import type {
  AgentMessage,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ImageContent,
  Model,
  PiCommandInfo,
  PiEvent,
  PiSessionState,
  PiTreeResult,
  ThinkingLevel
} from './pi-types'
import type { PiRuntimeInfo, PiSettings, ProjectSummary, SessionSummary } from './session-types'
import type { Automation, AutomationSchedule } from './automations'
import type { PrStatus } from './pr-status'
import type { PiReviewComment, ReviewComment, ReviewCommentsChange } from './review'
import type { PrCommentInput } from './pr-review'
import type { RepoBranches, WorktreeSource } from './git-branches'

export interface PrReviewPosted {
  url: string
  inline: number
  listed: number
  account: string
}

/** Which model a side chat or review pass should use (the chat's own). */
export interface SideModelInput {
  provider: string
  modelId: string
}

export interface SideEventPayload {
  sideId: string
  events: PiEvent[]
}

/** Editable fields of an automation; `id` updates an existing one. */
export interface AutomationInput {
  id?: string
  name: string
  prompt: string
  cwd: string
  schedule: AutomationSchedule
  enabled: boolean
}

export interface ChatOpenInput {
  chatId: string
  cwd?: string
  sessionPath?: string
}

export interface ChatOpenResult {
  chatId: string
  cwd: string
  state: PiSessionState
  messages: AgentMessage[]
  models: Model[]
  thinkingLevels: ThinkingLevel[]
  commands: PiCommandInfo[]
  /** Absolute session file path reported by pi (pre-allocated for drafts). */
  sessionPath?: string
}

/** File-derived transcript of a past session (instant, before pi is up). */
export interface ChatTranscriptResult {
  messages: AgentMessage[]
  /** True when the active branch has more messages than were returned. */
  hasEarlier: boolean
  totalMessages: number
  /** Index of the first returned message on the branch (pass as `before` to page back). */
  startIndex?: number
}

/**
 * Broadcast when a chat's pi process answered its first requests — the
 * live catalog replacing whatever cached values were shown during startup.
 */
export interface ChatReadyPayload {
  chatId: string
  state: PiSessionState
  models: Model[]
  thinkingLevels: ThinkingLevel[]
  commands: PiCommandInfo[]
  sessionPath?: string
  /** Spawn → first answered request, in ms. */
  startupMs: number
}

/** Last-known pi catalog persisted in userData (see catalog-cache.ts). */
export interface CatalogSnapshot {
  models: Model[]
  commands: PiCommandInfo[]
  thinkingLevels: ThinkingLevel[]
  model: Model | null
  thinkingLevel: ThinkingLevel | null
  /** Last measured spawn→ready time, in ms. */
  lastStartupMs?: number
}

export type ChatSendMode = 'prompt' | 'steer' | 'followUp'

export interface ChatSendInput {
  chatId: string
  message: string
  images?: ImageContent[]
  mode: ChatSendMode
}

export interface ChatEventPayload {
  chatId: string
  /**
   * Ordered event batch — main coalesces message_update deltas into one IPC
   * payload per ~32ms; non-delta events flush immediately, so sequence is
   * always preserved.
   */
  events: PiEvent[]
}

export interface ChatUiRequestPayload {
  chatId: string
  request: ExtensionUiRequest
}

export interface ChatExitPayload {
  chatId: string
  code: number | null
  signal: string | null
  /** Last stderr lines (bounded, no RPC payloads). */
  stderrTail: string[]
}

/**
 * Sent while a chat's pi is still starting when stderr shows a known blocker
 * (e.g. an MCP server retrying) — rendered next to the starting indicator.
 */
export interface ChatStartupHintPayload {
  chatId: string
  hint: string
}

export interface ChatSessionStats {
  sessionFile?: string
  sessionId?: string
  userMessages?: number
  assistantMessages?: number
  toolCalls?: number
  toolResults?: number
  totalMessages?: number
  tokens?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost?: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number | null
    percent: number | null
  }
}

export type ChatUiResponseInput = Omit<ExtensionUiResponse, 'type'> & { chatId: string }

/** Result of switching models: pi may clamp the thinking level, so the
 *  post-switch state and the new model's level list come back together. */
export interface SetModelResult {
  model: Model | null
  thinkingLevel: ThinkingLevel | null
  thinkingLevels: ThinkingLevel[]
}

/** A project the user added explicitly (may have no sessions yet). */
export interface AppProject {
  cwd: string
  addedAt: string
}

/** Pi Desktop's own settings (stored in Electron userData, not ~/.pi). */
export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  displayName?: string
  defaultCwd?: string
  piRuntime: {
    mode: 'auto' | 'installed' | 'bundled' | 'custom'
    customPath?: string
  }
  projects: AppProject[]
  hiddenProjects: string[]
  /** Project cwds expanded in the sidebar (all others stay collapsed). */
  expandedProjects: string[]
  /** Recently opened browser-panel URLs (http(s) only, newest first). */
  recentUrls: string[]
  sidebarCollapsed: boolean
  /** Right panel open state and pixel width, persisted across restarts. */
  panelOpen: boolean
  panelWidth: number
  /** Computer use: whether the agent may drive native macOS apps. */
  computerUse: { enabled: boolean }
  /** Native notifications + dock badge when pi finishes or needs input. */
  notifications: { enabled: boolean }
  /** First-run welcome checklist; dismissedAt is epoch ms. */
  onboarding: { dismissedAt?: number }
  /** Background release check; dismissedVersion hides the sidebar pill. */
  updates: { check: boolean; dismissedVersion?: string }
  /** Dictation: speech locale (BCP-47) and silence auto-stop. */
  dictation: { locale?: string; autoStop: boolean }
  /** Remote control: whether paired phones may connect. */
  remote: { enabled: boolean }
  /** The `gh` account that posts diff comments to a PR (gh's own when unset). */
  github: { commentAccount?: string }
}

/** A phone paired for remote control. */
export interface RemoteDeviceInfo {
  id: string
  name: string
  platform: string
  pairedAt: number
  lastSeenAt?: number
  connected: boolean
}

/** State of the remote-control host, for Settings → Remote control. */
export interface RemoteStatusInfo {
  running: boolean
  port: number | null
  /** Addresses a phone can reach this computer at. */
  addresses: string[]
  devices: RemoteDeviceInfo[]
  /** When the pairing code on screen stops working, or null. */
  pairingExpiresAt: number | null
  error?: string
}

/** A one-time pairing code, as a QR module matrix. */
export interface RemotePairingCode {
  /** The link the QR code encodes (also accepted pasted into the phone). */
  payload: string
  expiresAt: number
  /** Modules per side. */
  size: number
  /** Row-major modules, 1 = dark. */
  modules: number[]
}

/** A newer release found by the update check. */
export interface UpdateInfo {
  version: string
  url: string
}

export type UpdateCheckResult =
  | { status: 'up-to-date' }
  | { status: 'update-available'; version: string; url: string }
  | { status: 'unavailable' }

/** Dictation helper permission state (macOS TCC). */
export interface DictationPermissions {
  available: boolean
  microphone: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown'
  speech: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown'
}

/** Events streamed by the dictation helper. */
export type DictationEvent =
  | { event: 'partial'; text: string }
  | { event: 'final'; text: string }
  | { event: 'level'; rms: number }
  | { event: 'error'; message: string }
  | { event: 'stopped' }
  | { event: 'cancelled' }

/** A native notification request from the renderer. */
export interface AppNotifyInput {
  chatId: string
  title: string
  body: string
}

/** macOS permission state of the computer-use helper. */
export interface CuaPermissions {
  available: boolean
  accessibility: boolean
  screenRecording: boolean
  /** Whether macOS trusts Pi Desktop itself (the helper inherits it). */
  appAccessibility?: boolean
  /** Reset permissions is offered (packaged macOS build). */
  canReset?: boolean
}

/** Progress event for an agent-driven native-app action. */
export interface CuaActivity {
  chatId?: string
  /** 'paused'/'resumed' are global service events (no chatId). */
  phase: 'start' | 'end' | 'paused' | 'resumed'
  cmd: string
  app?: string
  summary: string
}

/** A listening localhost dev server shown on the panel's new-tab page. */
export interface LocalServer {
  port: number
  command: string
  /** HTML <title> when the server returned one during the probe. */
  title?: string
}

/** Identifiers returned by the native context menu. */
export type SessionMenuAction =
  | 'pin'
  | 'unpin'
  | 'archive'
  | 'unarchive'
  | 'rename'
  | 'export'
  | 'reveal'
  | 'copy-path'
  | 'delete'
export type ProjectMenuAction =
  | 'reveal'
  | 'new-chat'
  | 'new-worktree'
  | 'open-in'
  | 'remove-worktree'
  | 'hide'
export type ChatMenuAction =
  | 'pin'
  | 'unpin'
  | 'archive'
  | 'unarchive'
  | 'rename'
  | 'export'
  | 'clone'
  | 'reveal'
  | 'delete'

/** App-side per-session metadata (pin/archive) — never written to pi files. */
export interface SessionMetaEntry {
  /** pinnedAt epoch ms. */
  pinned?: number
  /** archivedAt epoch ms. */
  archived?: number
}
export type SessionMetaMap = Record<string, SessionMetaEntry>
export interface SessionMetaPatch {
  pinned?: boolean
  archived?: boolean
}

/** One entry of `files.readAttachments` — an inlined image or a path chip. */
export type AttachmentReadResult =
  | {
      kind: 'image'
      path: string
      name: string
      size: number
      mimeType: string
      data: string
    }
  | { kind: 'file'; path: string; name: string; size: number }

/** Final result of a `!command` run through pi's `bash` RPC. */
export interface ChatBashResult {
  output: string
  exitCode?: number
  cancelled: boolean
  truncated: boolean
}

export interface ForkMessage {
  entryId: string
  text: string
}

/** How a terminal tab's child env is assembled in the main process. */
export type TerminalProfile = 'shell' | 'pi'

export interface TerminalSpawnInput {
  id: string
  cwd: string
  /** Empty/omitted argv spawns the login shell. */
  argv?: string[]
  profile?: TerminalProfile
  /** Text written to the pty once spawned (e.g. '/login\n'). */
  initialInput?: string
  cols?: number
  rows?: number
}

export interface TerminalDataPayload {
  id: string
  data: string
}

export interface TerminalExitPayload {
  id: string
  exitCode: number
  signal?: number
}

/** Spawn info for the resolved pi runtime, for interactive TUI terminals. */
export interface RuntimeCommand {
  command: string
  args: string[]
}

/** Rectangle (CSS px, window-relative) where a browser view should paint. */
export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

/** Per-tab browser state pushed from main to renderer. */
export interface BrowserTabState {
  id: string
  url: string
  title: string
  favicon?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** The agent bridge asks the renderer to show/close a chat's browser tab. */
export interface BrowserAgentTabPayload {
  /** Panel tab id (`agent-<chatId>`); the view exists in main already. */
  id: string
  chatId: string
  action: 'open' | 'close'
}

/** Git working-tree diff for the diff panel. */
export interface RepoDiffResult {
  isRepo: boolean
  branch?: string
  /** Repository root; diff paths are relative to it. */
  root?: string
  /** Raw `git diff` output (unified format). */
  diffText: string
  /** Untracked text files (≤200KB each), rendered as all-added files. */
  untracked: { path: string; content: string }[]
}

/** A session whose conversation text matches a search. */
export interface SessionSearchHit {
  sessionPath: string
  /** Who wrote the first matching message. */
  role: 'user' | 'assistant'
  /** One-line excerpt around the first match. */
  snippet: string
  /** Matching messages in this session. */
  matches: number
}

/** Working-tree summary shown in the chat header. */
export interface RepoSummary {
  isRepo: boolean
  branch?: string
  /** Changed files, tracked and untracked. */
  files: number
  added: number
  removed: number
}

/** Outcome of a git action run from the diff panel. */
export interface GitActionResult {
  ok: boolean
  /** One line for a toast: what happened, or git's error. */
  message: string
}

/** Outcome of restoring a checkpoint. */
export interface CheckpointRestoreResult {
  /** Files put back (changed or deleted since the checkpoint). */
  restored: number
  /** Files created since the checkpoint, moved to the OS trash. */
  trashed: number
  /** Checkpoint of the state just before restoring, to undo it. */
  undo: string
}

/** A worktree the app created for a project. */
export interface WorktreeInfo {
  cwd: string
  branch: string
  /** The repository the worktree belongs to. */
  repo: string
}

/** A text file opened in the panel's file viewer. */
export interface FileReadResult {
  /** Resolved absolute path. */
  path: string
  /** Path relative to the project folder, with forward slashes. */
  relativePath: string
  size: number
  binary: boolean
  /** True when the file is larger than the viewer's limit. */
  truncated: boolean
  content: string
}

export interface UsageTotals {
  cost: number
  /** Input tokens, cache reads and writes included. */
  input: number
  output: number
  requests: number
}

/** Tokens and cost recorded in session files over a window of days. */
export interface UsageReport {
  /** Oldest first, one entry per calendar day (zeros included). */
  days: ({ day: string } & UsageTotals)[]
  models: ({ model: string } & UsageTotals)[]
  projects: ({ cwd: string } & UsageTotals)[]
  total: UsageTotals
}

/** Actions dispatched from the native application menu. */
export type MenuAction = 'open-settings' | 'toggle-sidebar' | 'new-chat' | 'find-in-chat'

export interface AppInfo {
  /** App version from the package manifest. */
  version: string
  /** process.platform — used for macOS-only styling (vibrancy, traffic lights). */
  platform: string
  /** Absolute path to the pi agent dir (~/.pi/agent or override). */
  agentDir: string
  /** agentDir with the home directory collapsed to '~' for display. */
  agentDirDisplay: string
  /** The user's home directory, for collapsing paths in tooltips. */
  homeDir: string
  /** Scratch dir for project-less chats (sessions here belong to "Chats"). */
  workspaceDir: string
}

/** Typed API exposed on `window.piDesktop` by the preload script. */
export interface PiDesktopApi {
  /** True when the app was launched with PI_DESKTOP_PERF=1 — enables the
   *  dev-only React commit counters read by scripts/perf.mjs. */
  perfEnabled: boolean
  runtime: {
    info(): Promise<PiRuntimeInfo>
    /** Re-run runtime detection (applies to newly opened chats). */
    refresh(): Promise<PiRuntimeInfo>
    /** Spawn info (command + args) for interactive pi TUI terminals. */
    command(): Promise<RuntimeCommand>
  }
  sessions: {
    list(): Promise<SessionSummary[]>
    /** Tokens and cost over the last 30 days, by day, model and project. */
    usage(): Promise<UsageReport>
    /** Full-text search over prompts and replies (3+ characters). */
    search(input: { query: string }): Promise<SessionSearchHit[]>
    /** Subscribe to session-index changes; returns an unsubscribe function. */
    onChanged(callback: () => void): () => void
    /** Rename via pi's set_session_name (works on closed sessions too). */
    rename(input: { sessionPath: string; name: string }): Promise<void>
    /** Export a session to an HTML file at outputPath. */
    exportHtml(input: { sessionPath: string; outputPath: string }): Promise<{ path?: string }>
    /** Export a session: '.jsonl' output copies the file, otherwise HTML. */
    exportFile(input: { sessionPath: string; outputPath: string }): Promise<{ path?: string }>
    /** Import a .jsonl session file into pi's session dir; returns its path. */
    import(input: { path: string }): Promise<{ sessionPath: string }>
    /** Move a session file to the OS trash (never unlink). */
    delete(input: { sessionPath: string }): Promise<void>
    /** Native context menu for a session row; resolves to the action or null. */
    showMenu(input: {
      sessionPath: string
      pinned?: boolean
      archived?: boolean
    }): Promise<SessionMenuAction | null>
  }
  /** App-side pin/archive flags keyed by session file path. */
  sessionMeta: {
    get(): Promise<SessionMetaMap>
    set(input: { sessionPath: string; patch: SessionMetaPatch }): Promise<SessionMetaMap>
    /** Fired in every window when the map changes; carries the full map. */
    onChanged(callback: (map: SessionMetaMap) => void): () => void
  }
  files: {
    /** Relative file paths under a project cwd (for @-mentions). */
    list(input: { cwd: string }): Promise<{ files: string[] }>
    /** Read a text file inside a project folder (panel file viewer). */
    read(input: { cwd: string; path: string }): Promise<FileReadResult>
    /** Read picked/dropped paths into image payloads or file chips. */
    readAttachments(input: { paths: string[] }): Promise<AttachmentReadResult[]>
  }
  terminal: {
    spawn(input: TerminalSpawnInput): Promise<{ id: string }>
    write(input: { id: string; data: string }): Promise<void>
    resize(input: { id: string; cols: number; rows: number }): Promise<void>
    kill(input: { id: string }): Promise<void>
    onData(callback: (payload: TerminalDataPayload) => void): () => void
    onExit(callback: (payload: TerminalExitPayload) => void): () => void
  }
  browser: {
    /** Create a browser tab's WebContentsView; optionally navigates. */
    create(input: { id: string; url?: string }): Promise<void>
    /** Navigate; url is normalized in main. Errors are thrown. */
    navigate(input: { id: string; url: string }): Promise<void>
    goBack(input: { id: string }): Promise<void>
    goForward(input: { id: string }): Promise<void>
    /** Reload, or stop if a load is in flight. */
    reloadOrStop(input: { id: string }): Promise<void>
    close(input: { id: string }): Promise<void>
    /**
     * Which browser tab should be painted and where (window-relative CSS px).
     * `id: null` hides all browser views.
     */
    setVisible(input: { id: string | null; rect?: BrowserRect }): Promise<void>
    /** Hide/show all browser views while a DOM overlay is open. */
    setOverlayOpen(input: { open: boolean }): Promise<void>
    /** Tab state updates (url, title, favicon, loading, history flags). */
    onState(callback: (state: BrowserTabState) => void): () => void
    /** Page asked to open a new window → renderer opens a new browser tab. */
    onOpenUrl(callback: (payload: { url: string }) => void): () => void
    /** A download completed → renderer shows a toast. */
    onDownload(callback: (payload: { filename: string }) => void): () => void
    /** A chat's agent used its browser tools → show or close its tab. */
    onAgentTab(callback: (payload: BrowserAgentTabPayload) => void): () => void
  }
  diff: {
    /** Git status + unified diff for a directory; isRepo=false when not git. */
    status(input: { cwd: string }): Promise<RepoDiffResult>
    /** Branch and change counts only (cheap; polled by the chat header). */
    summary(input: { cwd: string }): Promise<RepoSummary>
    /** Discard one file's changes (untracked files go to the OS trash). */
    discard(input: { cwd: string; path: string }): Promise<GitActionResult>
    /** Stage everything and commit. */
    commit(input: { cwd: string; message: string }): Promise<GitActionResult>
    /** Push the current branch (sets the upstream on the first push). */
    push(input: { cwd: string }): Promise<GitActionResult>
    /**
     * Have pi review the working-tree changes in a separate, session-less
     * process; its remarks replace pi's earlier ones in the project's shared
     * comments. Null when pi's reply was not a list of comments.
     */
    review(input: { cwd: string; model?: SideModelInput }): Promise<PiReviewComment[] | null>
    /**
     * Post comments to the branch's pull request as one review (through gh,
     * as the account in Settings → GitHub, signed pi-bot). Comments on
     * lines the PR does not have yet are listed in the review's body.
     */
    postComments(input: { cwd: string; comments: PrCommentInput[] }): Promise<PrReviewPosted>
  }
  /** A project repository's branches and worktrees. */
  git: {
    branches(input: { cwd: string }): Promise<RepoBranches>
    /** Check out a branch here (a remote "origin/x" gets a tracking branch). */
    switchBranch(input: { cwd: string; branch: string }): Promise<GitActionResult>
    /** Create a branch from `from` (HEAD by default); switches to it unless `switch` is false. */
    createBranch(input: {
      cwd: string
      name: string
      from?: string
      switch?: boolean
    }): Promise<GitActionResult>
    /** A checkout's branch changed (switch, new branch, worktree added or removed). */
    onChanged(callback: (change: { root: string }) => void): () => void
  }
  /**
   * A project's diff comments, kept on the computer: every window and paired
   * phone shows the same list. A commit clears it, discarding a file clears
   * that file's.
   */
  reviewComments: {
    list(input: { cwd: string }): Promise<ReviewComment[]>
    add(input: {
      cwd: string
      path: string
      line?: number
      lineText: string
      text: string
    }): Promise<ReviewComment>
    remove(input: { cwd: string; ids: string[] }): Promise<ReviewComment[]>
    /** All of them, or those on `paths`. */
    clear(input: { cwd: string; paths?: string[] }): Promise<ReviewComment[]>
    onChanged(callback: (change: ReviewCommentsChange) => void): () => void
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    /** Register a project folder (picked via native dialog) in app settings. */
    add(input: { cwd: string }): Promise<void>
    /** Native context menu for a project row; resolves to the action or null. */
    showMenu(input: { cwd: string }): Promise<ProjectMenuAction | null>
    /** Create a git worktree of the project on a new pi/ branch. */
    /** By default a new pi/<slug> branch from HEAD; `source` names it or picks an existing branch. */
    createWorktree(input: { cwd: string; source?: WorktreeSource }): Promise<WorktreeInfo>
    /** Remove a worktree the app created (force discards its changes). */
    /** `deleteBranch` also deletes its branch when merged. */
    removeWorktree(input: {
      cwd: string
      force?: boolean
      deleteBranch?: boolean
    }): Promise<GitActionResult>
  }
  settings: {
    /** Pi's own whitelisted settings (~/.pi/agent/settings.json). */
    get(): Promise<PiSettings>
  }
  appSettings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
    /** Settings changed elsewhere (a paired phone turned computer use on). */
    onChanged(callback: (settings: AppSettings) => void): () => void
  }
  app: {
    getUserFirstName(): Promise<string>
    /** Native folder picker; resolves to the chosen absolute path or null. */
    pickFolder(): Promise<string | null>
    /** Native file picker for a single existing file (used for custom paths). */
    pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>
    /** Native multi-select picker for any file type (composer attachments). */
    pickFiles(): Promise<string[]>
    /** Absolute path of a dropped/pasted File (empty when none, e.g. clipboard). */
    pathForFile(file: File): string
    /** Native save dialog; resolves to the chosen path or null. */
    saveFile(input: { defaultPath?: string; extension: string }): Promise<string | null>
    /**
     * Native "Open in" menu for a project folder: the file manager, a
     * terminal and any installed editors. Main performs the chosen action.
     */
    openInMenu(input: { cwd: string }): Promise<void>
    /** Reveal a path in the OS file manager. */
    revealPath(path: string): Promise<void>
    /** Native confirm/message dialog; resolves to the clicked button index. */
    confirmDialog(input: {
      title: string
      message?: string
      buttons: string[]
      danger?: boolean
    }): Promise<number>
    /** App version and pi agent directory info for the settings/about panes. */
    getAppInfo(): Promise<AppInfo>
    /** Open the pi agent directory in the OS file manager. */
    openAgentDir(): Promise<void>
    /** Open an http(s) URL in the system browser. */
    openExternal(url: string): Promise<void>
    /** Listening local TCP servers (dev servers) for the new-tab page. */
    localServers(): Promise<LocalServer[]>
    /** Quit the app (renderer confirms with the user first when needed). */
    quit(): Promise<void>
    /** Show a native notification; clicking it focuses the app and the chat. */
    notify(input: AppNotifyInput): Promise<void>
    /** macOS dock badge count (0 clears). */
    setBadge(count: number): Promise<void>
    /** Native application menu actions; returns an unsubscribe function. */
    onMenuAction(callback: (action: MenuAction) => void): () => void
    /** Notification click / main-process request to open a chat. */
    onOpenChat(callback: (payload: { chatId: string }) => void): () => void
  }
  chat: {
    open(input: ChatOpenInput): Promise<ChatOpenResult>
    send(input: ChatSendInput): Promise<void>
    abort(input: { chatId: string }): Promise<void>
    /** Run a shell command in pi (`!command`); output streams as events. */
    bash(input: { chatId: string; command: string }): Promise<ChatBashResult>
    abortBash(input: { chatId: string }): Promise<void>
    /** Drop queued steering / follow-up messages; returns their text. */
    clearQueue(input: { chatId: string }): Promise<{ steering: string[]; followUp: string[] }>
    setModel(input: { chatId: string; provider: string; modelId: string }): Promise<SetModelResult>
    setThinkingLevel(input: { chatId: string; level: ThinkingLevel }): Promise<void>
    getStats(input: { chatId: string }): Promise<ChatSessionStats | undefined>
    setCwd(input: { chatId: string; cwd: string }): Promise<ChatOpenResult>
    compact(input: { chatId: string; customInstructions?: string }): Promise<void>
    setSessionName(input: { chatId: string; name: string }): Promise<void>
    exportHtml(input: { chatId: string; outputPath: string }): Promise<{ path?: string }>
    /** Re-fetch state/messages/models for an open chat (after fork/clone). */
    refresh(input: { chatId: string }): Promise<ChatOpenResult>
    getForkMessages(input: { chatId: string }): Promise<{ messages: ForkMessage[] }>
    fork(input: { chatId: string; entryId: string }): Promise<{ text?: string; cancelled?: boolean }>
    clone(input: { chatId: string }): Promise<{ cancelled?: boolean }>
    /** Restart the chat's pi process on the same session (reloads resources). */
    reload(input: { chatId: string }): Promise<ChatOpenResult>
    /** Session entry tree for the /tree modal. */
    getTree(input: { chatId: string }): Promise<PiTreeResult>
    /** Text of the last assistant message (for /copy). */
    getLastAssistantText(input: { chatId: string }): Promise<{ text: string | null }>
    /** chatId of the open chat viewing a session path, if any. */
    chatIdForSession(input: { sessionPath: string }): Promise<string | undefined>
    /** Native context menu for the chat header; resolves to the action or null. */
    showMenu(input: {
      chatId: string
      pinned?: boolean
      archived?: boolean
    }): Promise<ChatMenuAction | null>
    respondUi(input: ChatUiResponseInput): Promise<void>
    close(input: { chatId: string }): Promise<void>
    /** Mark a chat as currently visible (idle eviction bookkeeping). */
    focus(input: { chatId: string }): Promise<void>
    /** Warm a spare pi for a project cwd (hover intent; best-effort). */
    warm(input: { cwd: string }): Promise<void>
    /** File-derived transcript of a session (renders before pi is ready). */
    readTranscript(input: {
      sessionPath: string
      limit?: number
    }): Promise<ChatTranscriptResult>
    onEvent(callback: (payload: ChatEventPayload) => void): () => void
    /** Live catalog/state once a chat's pi process answered. */
    onReady(callback: (payload: ChatReadyPayload) => void): () => void
    onUiRequest(callback: (payload: ChatUiRequestPayload) => void): () => void
    /** A dialog was answered elsewhere (a paired phone, another window). */
    onUiResolved(callback: (payload: { chatId: string; id: string }) => void): () => void
    onExit(callback: (payload: ChatExitPayload) => void): () => void
    onStartupHint(callback: (payload: ChatStartupHintPayload) => void): () => void
  }
  /** Snapshots of a git project's files, taken before each prompt. */
  checkpoints: {
    /** Record the working tree now; null outside a git repository. */
    create(input: { cwd: string }): Promise<string | null>
    /** Put the files back to a checkpoint (new files go to the OS trash). */
    restore(input: { cwd: string; checkpoint: string }): Promise<CheckpointRestoreResult>
  }
  /**
   * Side chats: questions answered with a chat's context that leave nothing
   * in it (pi runs on a scratch copy of the session).
   */
  side: {
    open(input: {
      sideId: string
      cwd: string
      sessionPath?: string
      model?: SideModelInput
    }): Promise<void>
    send(input: { sideId: string; message: string }): Promise<void>
    abort(input: { sideId: string }): Promise<void>
    close(input: { sideId: string }): Promise<void>
    onEvent(callback: (payload: SideEventPayload) => void): () => void
    onExit(callback: (payload: { sideId: string }) => void): () => void
  }
  /** Prompts pi runs on a schedule while the app is open. */
  automations: {
    list(): Promise<Automation[]>
    save(input: AutomationInput): Promise<Automation>
    delete(input: { id: string }): Promise<void>
    /** Run it now; counts as its latest run. */
    runNow(input: { id: string }): Promise<void>
    /** Record the session file a run produced (for "Open last run"). */
    setSession(input: { id: string; sessionPath: string }): Promise<void>
    /** Main asks this window to start a run as a background chat. */
    onRun(callback: (automation: Automation) => void): () => void
    onChanged(callback: () => void): () => void
  }
  /** Pull request of a project's current branch, via the GitHub CLI. */
  pr: {
    status(input: { cwd: string }): Promise<PrStatus>
    /** Tail of the failed jobs' log for a GitHub Actions run. */
    failedLog(input: { cwd: string; runId: string }): Promise<string>
  }
  /** Remote control: the host paired phones connect to. */
  remote: {
    status(): Promise<RemoteStatusInfo>
    /** Show a fresh one-time pairing code (turns remote control on first). */
    beginPairing(): Promise<RemotePairingCode>
    cancelPairing(): Promise<void>
    /** Forget a phone and disconnect it. */
    revoke(input: { deviceId: string }): Promise<void>
    onChanged(callback: (status: RemoteStatusInfo) => void): () => void
  }
  /** Last-known pi catalog for instant composer/palette rendering. */
  catalog: {
    get(): Promise<CatalogSnapshot>
  }
  /** Computer use (native macOS app control). */
  cua: {
    permissions(): Promise<CuaPermissions>
    /** Show the macOS permission prompts and return the new state. */
    requestPermissions(): Promise<CuaPermissions>
    /** Open System Settings on the relevant privacy pane. */
    openSettings(pane: 'accessibility' | 'screenRecording'): Promise<void>
    /**
     * Drop Pi Desktop's Accessibility and Screen Recording entries (one left
     * by an older build no longer matches), then ask again.
     */
    resetPermissions(): Promise<CuaPermissions>
    pause(): Promise<void>
    resume(): Promise<void>
    /** Abort in-flight and queued computer actions. */
    stop(): Promise<void>
    onActivity(callback: (payload: CuaActivity) => void): () => void
    /** e2e-only: inject a synthetic activity event (PI_DESKTOP_E2E=1). */
    testActivity(payload: CuaActivity): Promise<void>
  }
  /** Release update check against the GitHub repo. */
  updates: {
    /** Last-known newer release (in-memory cache in main). */
    get(): Promise<UpdateInfo | null>
    /** Run the check now; failures report 'unavailable', never throw. */
    checkNow(): Promise<UpdateCheckResult>
    /** Open the latest release page in the system browser (main holds the URL). */
    open(): Promise<void>
    onAvailable(callback: (info: UpdateInfo) => void): () => void
  }
  /** Speech dictation via the bundled Swift helper (macOS only). */
  dictation: {
    permissions(): Promise<DictationPermissions>
    /** BCP-47 locale identifiers supported by SFSpeechRecognizer. */
    locales(): Promise<string[]>
    start(input: { locale?: string; autoStop?: boolean }): Promise<void>
    /** Finish and emit the final transcript. */
    stop(): Promise<void>
    /** Abort without committing the partial transcript. */
    cancel(): Promise<void>
    /** Open System Settings on a privacy pane. */
    openSettings(pane: 'microphone' | 'speech'): Promise<void>
    onEvent(callback: (payload: DictationEvent) => void): () => void
    /** e2e-only: inject a synthetic dictation event (PI_DESKTOP_E2E=1). */
    testEvent(payload: DictationEvent): Promise<void>
  }
}
