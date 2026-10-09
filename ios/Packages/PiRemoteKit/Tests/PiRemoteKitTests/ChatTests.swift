import Foundation
import XCTest

@testable import PiRemoteKit

private func event(_ json: String) -> PiEvent {
    PiEvent(json: try! JSONValue.parse(json))
}

final class ChatViewTests: XCTestCase {
    func testStreamingAssemblesAndFinalMessageWins() {
        var state = ChatViewState()
        state.reduce(event(#"{"type":"agent_start"}"#))
        XCTAssertEqual(state.status, .streaming)
        XCTAssertNotNil(state.runStartedAt)
        state.reduce(event(#"{"type":"message_start","message":{"role":"user","content":"hi","timestamp":1}}"#))
        state.reduce(event(#"{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}"#))
        state.reduce(event(#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hel"}}"#))
        state.reduce(event(#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"lo"}}"#))
        XCTAssertEqual(state.messages.count, 2)
        guard case .assistant(let streaming) = state.messages[1] else { return XCTFail() }
        XCTAssertTrue(streaming.streaming)
        XCTAssertEqual(streaming.blocks, [.text("Hello")])
        state.reduce(event(
            #"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}],"model":"m1","provider":"p","stopReason":"stop","usage":{"input":10,"output":5,"cacheRead":2,"cacheWrite":1,"cost":{"total":0.01}},"timestamp":2}}"#
        ))
        guard case .assistant(let final) = state.messages[1] else { return XCTFail() }
        XCTAssertEqual(final.key, streaming.key)
        XCTAssertFalse(final.streaming)
        XCTAssertEqual(final.blocks, [.text("Hello!")])
        XCTAssertEqual(final.usage?.input, 13)
        XCTAssertEqual(final.model, "m1")
        XCTAssertTrue(state.reduce(event(#"{"type":"agent_end","messages":[]}"#)))
        state.reduce(event(#"{"type":"agent_settled"}"#))
        XCTAssertEqual(state.status, .idle)
        XCTAssertNil(state.runStartedAt)
    }

    func testTurnEndFlagsStatsRefreshWithoutTouchingState() {
        var state = ChatViewState()
        let turnEnd = event(#"{"type":"turn_end","message":{"role":"assistant","content":[]},"toolResults":[]}"#)
        guard case .turnEnd = turnEnd else { return XCTFail() }
        XCTAssertTrue(state.reduce(turnEnd))
        XCTAssertEqual(state.status, .idle)
        XCTAssertTrue(state.messages.isEmpty)
        XCTAssertFalse(state.reduce(event(#"{"type":"turn_start"}"#)))
    }

    func testOptimisticUserEchoKeepsLocalKeyAndCheckpoint() {
        var state = ChatViewState()
        state.messages.append(.user(UserDisplay(key: "local-1", text: "do it", images: [], checkpoint: "abc")))
        state.reduce(event(#"{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"do it"}]}}"#))
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(state.messages[0].user?.key, "local-1")
        XCTAssertEqual(state.messages[0].user?.checkpoint, "abc")
    }

    func testToolRunsLifecycle() {
        var state = ChatViewState()
        state.reduce(event(#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"ls"}}"#))
        XCTAssertEqual(state.toolRuns["t1"]?.status, .running)
        state.reduce(event(#"{"type":"tool_execution_update","toolCallId":"t1","toolName":"bash","args":{},"partialResult":{"content":[{"type":"text","text":"a\n"}]}}"#))
        XCTAssertEqual(state.toolRuns["t1"]?.partialText, "a\n")
        state.reduce(event(#"{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{"content":[{"type":"text","text":"a\nb"}]},"isError":true}"#))
        XCTAssertEqual(state.toolRuns["t1"]?.status, .error)
        XCTAssertNil(state.toolRuns["t1"]?.partialText)
        XCTAssertNotNil(state.toolRuns["t1"]?.durationMs)
    }

    func testBuildFromPersistedMessagesCarriesToolArgs() throws {
        let messages = AgentMessage.list(try JSONValue.parse(#"""
        [
          {"role":"user","content":"read it","timestamp":1},
          {"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"read","arguments":{"path":"/p/a.txt"}}],"model":"m","provider":"p","stopReason":"toolUse"},
          {"role":"toolResult","toolCallId":"c1","toolName":"read","content":[{"type":"text","text":"x"}],"isError":false},
          {"role":"compactionSummary","summary":"S","tokensBefore":150000},
          {"role":"bashExecution","command":"ls","output":"f","exitCode":0,"cancelled":false}
        ]
        """#))
        let state = ChatViewState.build(messages)
        XCTAssertEqual(state.messages.count, 4)
        XCTAssertEqual(state.toolRuns["c1"]?.args["path"]?.stringValue, "/p/a.txt")
        XCTAssertEqual(state.toolRuns["c1"]?.status, .done)
        guard case .notice(let notice) = state.messages[2] else { return XCTFail() }
        XCTAssertEqual(notice.text, "Context compacted · was 150k tokens")
        XCTAssertEqual(notice.detail, "S")
    }

    func testQueueUpdateAndDequeue() {
        var state = ChatViewState()
        state.reduce(event(#"{"type":"queue_update","steering":["a"],"followUp":["b"]}"#))
        XCTAssertEqual(state.queue?.count, 2)
        state.reduce(event(#"{"type":"message_start","message":{"role":"user","content":"a"}}"#))
        XCTAssertEqual(state.queue?.steering, [])
        XCTAssertEqual(state.queue?.followUp, ["b"])
        state.reduce(event(#"{"type":"queue_update","steering":[],"followUp":[]}"#))
        XCTAssertNil(state.queue)
    }

    func testThinkingAndToolCallDeltas() {
        var state = ChatViewState()
        state.reduce(event(#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}"#))
        state.reduce(event(#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"hmm"}}"#))
        state.reduce(event(#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0,"content":"hmm."}}"#))
        state.reduce(event(#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"id":"c9","toolName":"edit"}}"#))
        state.reduce(event(#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","contentIndex":1,"delta":"{\"pa"}}"#))
        guard case .assistant(let message) = state.messages[0] else { return XCTFail() }
        guard case .thinking(let thinking) = message.blocks[0], case .toolCall(let call) = message.blocks[1] else { return XCTFail() }
        XCTAssertEqual(thinking.thinking, "hmm.")
        XCTAssertNotNil(thinking.durationMs)
        XCTAssertEqual(call.id, "c9")
        XCTAssertEqual(call.argsText, "{\"pa")
    }

    func testNotifyBecomesNotice() {
        var state = ChatViewState()
        state.reduce(event(#"{"type":"extension_ui_request","id":"1","method":"notify","message":"Saved","notifyType":"error"}"#))
        guard case .notice(let notice) = state.messages[0] else { return XCTFail() }
        XCTAssertEqual(notice.text, "Saved")
        XCTAssertEqual(notice.tone, .error)
    }

    func testTranscriptFoldsWorkAndAddsMeta() {
        let trace1 = AssistantDisplay(key: "a1", blocks: [.toolCall(ToolCallBlock(id: "1", name: "read", arguments: [:]))], timestamp: 1000)
        let trace2 = AssistantDisplay(key: "a2", blocks: [.thinking(ThinkingBlock(thinking: "x"))], timestamp: 2000)
        let answer = AssistantDisplay(
            key: "a3",
            blocks: [.text("done")],
            timestamp: 5000,
            model: "m1",
            usage: TurnUsage(input: 1, output: 1800, cost: 0.04)
        )
        let items = buildTranscript(
            [.user(UserDisplay(key: "u", text: "go", images: [])), .assistant(trace1), .assistant(trace2), .assistant(answer)],
            streaming: false,
            models: [Model(id: "m1", name: "Model One", provider: "p")]
        )
        XCTAssertEqual(items.map(\.id), ["u", "a1:work", "a3", "a3:meta"])
        guard case .work(_, let grouped, let live, let start, let end) = items[1] else { return XCTFail() }
        XCTAssertEqual(grouped.count, 2)
        XCTAssertFalse(live)
        XCTAssertEqual(start, 1000)
        XCTAssertEqual(end, 5000)
        guard case .meta(_, let text, let reply) = items[3] else { return XCTFail() }
        XCTAssertTrue(text.hasPrefix("Model One · "))
        XCTAssertTrue(text.hasSuffix("1.8k tokens out · $0.040"))
        XCTAssertEqual(reply, "done")
    }
}

final class HelperTests: XCTestCase {
    func testToolCategoriesAndSummaries() {
        XCTAssertEqual(toolCategory("bash"), .run)
        XCTAssertEqual(toolCategory("show_image"), .image)
        XCTAssertEqual(toolCategory("runtime_info"), .other)
        XCTAssertEqual(toolCategory("str_replace_editor"), .edit)
        let summary = summarizeToolRuns([
            ToolRunInfo(name: "edit", args: ["oldText": "a\nb\nc", "newText": "a\nB\nc"], status: .done),
            ToolRunInfo(name: "bash", args: [:], status: .error),
            ToolRunInfo(name: "bash", args: [:], status: .running)
        ])
        XCTAssertEqual(summary.text, "Edited a file, ran 2 commands")
        XCTAssertEqual(summary.diff?.added, 1)
        XCTAssertEqual(summary.diff?.removed, 1)
        XCTAssertEqual(summary.failed, 1)
        XCTAssertEqual(summary.running, 1)
        XCTAssertEqual(toolCallSummary("read", ["path": "/repo/src/a.ts"], cwd: "/repo"), "src/a.ts")
        XCTAssertEqual(computerToolSummary("computer_key", ["key": "cmd+shift+s", "app": "Finder"]), "Pressed ⌘⇧S in Finder")
    }

    func testShellStatusAndDurations() {
        let split = splitShellStatus("out\n\nCommand exited with code 2")
        XCTAssertEqual(split.output, "out")
        XCTAssertEqual(split.status, .exit(2))
        XCTAssertNil(splitShellStatus("plain").status)
        XCTAssertEqual(formatDuration(400), "0.4s")
        XCTAssertEqual(formatDuration(125_000), "2m 05s")
        XCTAssertEqual(formatElapsed(3_723_000), "1:02:03")
    }

    func testLineDiffAndTrim() {
        let lines = diffLines("a\nb\nc\nd\ne\nf\ng\nh\ni\n", "a\nb\nc\nd\nX\nf\ng\nh\ni\n")
        XCTAssertEqual(lines.filter { $0.kind == .removed }.map(\.text), ["e"])
        XCTAssertEqual(lines.filter { $0.kind == .added }.map(\.text), ["X"])
        let trimmed = trimContext(lines, radius: 1)
        // Leading unchanged lines leave no gap marker; the trailing one is dropped.
        XCTAssertEqual(trimmed.count, 4)
        XCTAssertEqual(trimmed.compactMap { $0?.text }, ["d", "e", "X", "f"])
        let twoChanges = trimContext(diffLines("1\n2\n3\n4\n5\n6\n7\n8\n", "X\n2\n3\n4\n5\n6\n7\nY\n"), radius: 1)
        XCTAssertEqual(twoChanges.map { $0?.text ?? "⋯" }, ["1", "X", "2", "⋯", "7", "8", "Y"])
    }

    func testMentions() {
        XCTAssertEqual(mentionTrigger("look at @src/ma", cursor: 15), MentionTrigger(start: 8, end: 15, query: "src/ma"))
        XCTAssertNil(mentionTrigger("mail me@x.com", cursor: 13))
        XCTAssertNil(mentionTrigger("`@code", cursor: 6))
        XCTAssertEqual(mentionTrigger("see @\"My Doc", cursor: 12)?.query, "My Doc")
        XCTAssertEqual(formatMention("a b/c.txt"), "@\"a b/c.txt\"")
        XCTAssertEqual(
            splitMentions("fix @src/a.ts and @bob, mail a@b.com"),
            [.text("fix "), .mention(text: "@src/a.ts", path: "src/a.ts"), .text(" and @bob, mail a@b.com")]
        )
    }

    func testTitleFromUserText() {
        XCTAssertEqual(titleFromUserText("<skill name=\"lint\" location=\"/x\">body</skill>"), "/skill:lint")
        XCTAssertEqual(titleFromUserText("/tmp/shot.png explain"), "explain")
        XCTAssertEqual(titleFromUserText("/tmp/shot.png"), "Image")
        XCTAssertEqual(titleFromUserText("open @src/app/main.ts please"), "open main.ts please")
    }

    func testFuzzyAndSlash() {
        XCTAssertEqual(fuzzyFilter("mts", ["readme.md", "main.ts", "tests/x.ts"]) { $0 }.first, "main.ts")
        XCTAssertEqual(slashQuery("/mo"), "mo")
        XCTAssertNil(slashQuery("/model x"))
        XCTAssertEqual(parseSlashSend("/name  My chat ")?.command, "name")
        XCTAssertEqual(parseSlashSend("/name  My chat ")?.args, "My chat")
        let items = filterSlashCommands(
            [PiCommandInfo(name: "deploy", description: "Ship it", source: "skill")],
            query: "",
            inChat: false,
            streaming: false
        )
        XCTAssertFalse(items.contains { $0.name == "fork" })
        XCTAssertEqual(items.last?.name, "deploy")
    }

    func testSigilMatchesDesktop() {
        // Values from the desktop's sigil.ts for the same seeds.
        let expected: [(String, String, Int)] = [
            ("/Users/example/project", "111101010", 1),
            ("/home/me/ünïcode", "111000101", 2),
            ("a", "010000111", 5)
        ]
        for (seed, cells, hue) in expected {
            let pattern = sigilPattern(seed)
            XCTAssertEqual(pattern.cells.map { $0 ? "1" : "0" }.joined(), cells, seed)
            XCTAssertEqual(pattern.hue, hue, seed)
        }
    }

    func testUnifiedDiffAndComments() {
        let diff = """
        diff --git a/src/a.ts b/src/a.ts
        index 1..2 100644
        --- a/src/a.ts
        +++ b/src/a.ts
        @@ -1,3 +1,3 @@
         one
        -two
        +TWO
         three
        diff --git a/new.txt b/new.txt
        new file mode 100644
        --- /dev/null
        +++ b/new.txt
        @@ -0,0 +1 @@
        +hello
        """
        let files = parseUnifiedDiff(diff)
        XCTAssertEqual(files.map(\.path), ["src/a.ts", "new.txt"])
        XCTAssertEqual(files[1].status, "added")
        XCTAssertEqual(files[0].changes.added, 1)
        XCTAssertEqual(files[0].hunks[0].lines[2].newNo, 2)
        let comments = [
            ReviewComment(id: "1", path: "src/a.ts", line: 2, lineText: "TWO", text: "why caps", author: nil, createdAt: 0),
            ReviewComment(id: "2", path: "src/a.ts", line: 40, lineText: "", text: "far away", author: "pi", createdAt: 0)
        ]
        let placed = placeComments(files, comments)
        XCTAssertEqual(placed[0].key, "0:2")
        XCTAssertFalse(placed[0].fallback)
        XCTAssertTrue(placed[1].fallback)
        XCTAssertEqual(placed[1].text, "Line 40: far away")
        let prompt = reviewPrompt([(path: "src/a.ts", line: 2, lineText: "TWO", text: "why caps")])
        XCTAssertTrue(prompt.contains("1. `src/a.ts:2` — `TWO`\n   why caps"))
    }

    func testMarkdownParsing() {
        let blocks = parseMarkdown("""
        # Title

        Some **bold** and `code` with [link](https://x.dev).

        - [x] done
        - todo

        ```swift
        let a = 1
        ```

        | a | b |
        |---|---|
        | 1 | 2 |
        """)
        XCTAssertEqual(blocks.count, 5)
        guard case .heading(1, _) = blocks[0] else { return XCTFail("heading") }
        guard case .paragraph(let inline) = blocks[1] else { return XCTFail("paragraph") }
        XCTAssertTrue(inline.contains(.strong([.text("bold")])))
        XCTAssertTrue(inline.contains(.code("code")))
        XCTAssertTrue(inline.contains(.link(href: "https://x.dev", children: [.text("link")])))
        guard case .list(false, _, let items) = blocks[2] else { return XCTFail("list") }
        XCTAssertEqual(items.first?.checked, true)
        guard case .code("swift", "let a = 1") = blocks[3] else { return XCTFail("code") }
        guard case .table(let header, let rows) = blocks[4] else { return XCTFail("table") }
        XCTAssertEqual(header.count, 2)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(splitMarkdownBlocks("a\n\nb\n\n```\nx\n\ny\n```").count, 3)
    }

    func testHighlight() {
        let tokens = highlight("let x = 1 // note\n\"s\"", lang: "swift")
        XCTAssertTrue(tokens.contains(CodeToken(text: "let", kind: .keyword)))
        XCTAssertTrue(tokens.contains(CodeToken(text: "1", kind: .number)))
        XCTAssertTrue(tokens.contains(CodeToken(text: "// note", kind: .comment)))
        XCTAssertTrue(tokens.contains(CodeToken(text: "\"s\"", kind: .string)))
        XCTAssertEqual(languageOfPath("src/App.tsx"), "tsx")
        XCTAssertEqual(highlightLines("a\nb", lang: nil).count, 2)
    }

    func testSessionTreeFlattensLinearAndIndentsBranches() {
        let leafA = PiTreeNode(id: "a2", type: "message", message: .assistant(AssistantMessage(content: [.text("A")], provider: "", model: "")))
        let leafB = PiTreeNode(id: "b2", type: "message", message: .user(content: [.text("B")], timestamp: nil))
        let root = PiTreeNode(id: "r", type: "message", message: .user(content: [.text("root")], timestamp: nil), children: [leafB, leafA])
        let rows = flattenSessionTree(PiTreeResult(tree: [root], leafId: "a2"))
        XCTAssertEqual(rows.map(\.id), ["r", "a2", "b2"])
        XCTAssertEqual(rows.map(\.depth), [0, 1, 1])
        XCTAssertTrue(rows[1].active && rows[1].leaf)
        XCTAssertTrue(rows[2].forkable)
    }

    func testAutomationScheduleDescriptions() {
        XCTAssertEqual(AutomationSchedule.interval(minutes: 120).description, "Every 2 hours")
        XCTAssertEqual(AutomationSchedule.daily(time: "09:00", weekdaysOnly: true).description, "Weekdays at 09:00")
        XCTAssertFalse(AutomationSchedule.interval(minutes: 2).isValid)
        XCTAssertFalse(AutomationSchedule.daily(time: "25:00", weekdaysOnly: false).isValid)
    }

    func testJSONValueDecoderIsLenientForOptionals() throws {
        let value = try JSONValue.parse(#"{"isRepo":true,"branch":5,"files":2,"added":3,"removed":1}"#)
        let summary = try value.decode(RepoSummary.self)
        XCTAssertNil(summary.branch)
        XCTAssertEqual(summary.files, 2)
    }
}
