import XCTest

@testable import PiRemoteKit

// Mirrors the parseUnifiedDiff / unquoteGitPath / diffFileForUntracked cases
// in src/shared/diff-parse.test.ts.
final class GitModelsTests: XCTestCase {
    private let sample = """
        diff --git a/src/a.ts b/src/a.ts
        index 111..222 100644
        --- a/src/a.ts
        +++ b/src/a.ts
        @@ -1,3 +1,4 @@
         line one
        -old line
        +new line
        +another
         end
        diff --git a/new.ts b/new.ts
        new file mode 100644
        --- /dev/null
        +++ b/new.ts
        @@ -0,0 +1,2 @@
        +hello
        +world
        diff --git a/gone.ts b/gone.ts
        deleted file mode 100644
        --- a/gone.ts
        +++ /dev/null
        @@ -1 +0,0 @@
        -bye
        diff --git a/old-name.ts b/new-name.ts
        similarity index 90%
        rename from old-name.ts
        rename to new-name.ts
        --- a/old-name.ts
        +++ b/new-name.ts
        @@ -1 +1 @@
        -x
        +y
        diff --git a/bin.png b/bin.png
        Binary files a/bin.png and b/bin.png differ
        """

    func testParsesFilesStatusesAndHunks() {
        let files = parseUnifiedDiff(sample)
        XCTAssertEqual(files.map { [$0.path, $0.status] }, [
            ["src/a.ts", "modified"],
            ["new.ts", "added"],
            ["gone.ts", "deleted"],
            ["new-name.ts", "renamed"],
            ["bin.png", "modified"]
        ])
        XCTAssertTrue(files[4].isBinary)
        XCTAssertEqual(files[3].oldPath, "old-name.ts")
    }

    func testParsesPathsContainingSpaces() {
        let files = parseUnifiedDiff("""
            diff --git a/my file.ts b/my file.ts
            index 111..222 100644
            --- a/my file.ts
            +++ b/my file.ts
            @@ -1 +1 @@
            -x
            +y
            """)
        XCTAssertEqual(files.map(\.path), ["my file.ts"])
        XCTAssertEqual(files[0].status, "modified")
    }

    func testPureRenameWithoutPatchLines() {
        let files = parseUnifiedDiff("""
            diff --git a/old.ts b/new.ts
            similarity index 100%
            rename from old.ts
            rename to new.ts
            """)
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(files[0].path, "new.ts")
        XCTAssertEqual(files[0].oldPath, "old.ts")
        XCTAssertEqual(files[0].status, "renamed")
        XCTAssertTrue(files[0].hunks.isEmpty)
    }

    func testUnquotesQuotedHeaderAndPatchPaths() {
        let files = parseUnifiedDiff("""
            diff --git "a/yeni dosya \\360\\237\\232\\200.txt" "b/yeni dosya \\360\\237\\232\\200.txt"
            index 111..222 100644
            --- "a/yeni dosya \\360\\237\\232\\200.txt"
            +++ "b/yeni dosya \\360\\237\\232\\200.txt"
            @@ -1 +1 @@
            -x
            +y
            diff --git "a/tricky \\"quote\\" \\t.txt" "b/tricky \\"quote\\" \\t.txt"
            --- "a/tricky \\"quote\\" \\t.txt"
            +++ "b/tricky \\"quote\\" \\t.txt"
            @@ -1 +1 @@
            -p
            +q
            """)
        XCTAssertEqual(files.map { [$0.path, $0.status] }, [
            ["yeni dosya 🚀.txt", "modified"],
            ["tricky \"quote\" \t.txt", "modified"]
        ])
    }

    func testUnquotesHeaderFallbackForBinaryFile() {
        let files = parseUnifiedDiff("""
            diff --git "a/t\\304\\237rk.png" "b/t\\304\\237rk.png"
            Binary files "a/t\\304\\237rk.png" and "b/t\\304\\237rk.png" differ
            """)
        XCTAssertEqual(files[0].path, "tğrk.png")
        XCTAssertEqual(files[0].status, "modified")
        XCTAssertTrue(files[0].isBinary)
    }

    func testUnquotesRenameFromToLines() {
        let files = parseUnifiedDiff("""
            diff --git "a/\\304\\237eski.ts" "b/\\304\\237yeni.ts"
            similarity index 100%
            rename from "\\304\\237eski.ts"
            rename to "\\304\\237yeni.ts"
            """)
        XCTAssertEqual(files[0].path, "ğyeni.ts")
        XCTAssertEqual(files[0].oldPath, "ğeski.ts")
        XCTAssertEqual(files[0].status, "renamed")
    }

    func testUnquoteGitPath() {
        XCTAssertEqual(unquoteGitPath("a/plain.ts"), "a/plain.ts")
        XCTAssertEqual(unquoteGitPath("\"a/yeni dosya \\360\\237\\232\\200.txt\""), "a/yeni dosya 🚀.txt")
        XCTAssertEqual(unquoteGitPath("\"t\\304\\237rk.ts\""), "tğrk.ts")
        XCTAssertEqual(unquoteGitPath("\"q\\\"t\\\"\\t\\\\x\""), "q\"t\"\t\\x")
        XCTAssertEqual(unquoteGitPath("\"\\377\\377\""), "\"\\377\\377\"")
        XCTAssertEqual(unquoteGitPath("\"a/q\\\"ğü 🚀.txt\""), "a/q\"ğü 🚀.txt")
        XCTAssertEqual(unquoteGitPath("\"a/\\360\\237\\232\\200 ğ.txt\""), "a/🚀 ğ.txt")
    }

    func testDiffFileForUntracked() {
        let file = diffFileForUntracked(path: "fresh.ts", content: "a\nb\n")
        XCTAssertEqual(file.status, "added")
        XCTAssertEqual(file.changes.added, 2)
        XCTAssertEqual(file.changes.deleted, 0)
        XCTAssertEqual(file.hunks[0].lines.map(\.text), ["a", "b"])

        let nested = diffFileForUntracked(path: "dir/sub/deep.txt", content: "x")
        XCTAssertEqual(nested.path, "dir/sub/deep.txt")

        let binary = diffFileForUntracked(path: "blob.bin", content: "", binary: true)
        XCTAssertEqual(binary.status, "added")
        XCTAssertTrue(binary.hunks.isEmpty)
        XCTAssertTrue(binary.isBinary)

        let large = diffFileForUntracked(path: "huge.log", content: "", tooLarge: true)
        XCTAssertEqual(large.status, "added")
        XCTAssertTrue(large.hunks.isEmpty)
        XCTAssertTrue(large.tooLarge)
    }

    func testUntrackedResultDecodesBinaryAndTooLarge() throws {
        let result = RepoDiffResult(json: try JSONValue.parse(#"{"isRepo":true,"diffText":"","untracked":[{"path":"a.bin","binary":true},{"path":"b.log","tooLarge":true,"content":""},{"path":"c.txt","content":"hi"}]}"#))
        XCTAssertEqual(result.untracked.count, 3)
        XCTAssertTrue(result.untracked[0].binary)
        XCTAssertFalse(result.untracked[0].tooLarge)
        XCTAssertTrue(result.untracked[1].tooLarge)
        XCTAssertFalse(result.untracked[2].binary)
        XCTAssertFalse(result.untracked[2].tooLarge)
    }
}
