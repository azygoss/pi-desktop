import type {
  AgentMessage,
  AppInfo,
  Automation,
  AutomationInput,
  CatalogSnapshot,
  ChatBashResult,
  ChatOpenResult,
  ChatSendMode,
  ChatSessionStats,
  ChatTranscriptResult,
  CheckpointRestoreResult,
  CuaPermissions,
  FileReadResult,
  ForkMessage,
  GitActionResult,
  ImageContent,
  PiReviewComment,
  PrCommentInput,
  RepoBranches,
  WorktreeSource,
  PrReviewPosted,
  ReviewComment,
  PiRuntimeInfo,
  PiTreeResult,
  ProjectSummary,
  PrStatus,
  RemoteDirListing,
  RemoteLiveChat,
  RepoDiffResult,
  RepoSummary,
  SessionMetaMap,
  SessionMetaPatch,
  SessionSearchHit,
  SessionSummary,
  SetModelResult,
  SideModelInput,
  ThinkingLevel,
  UsageReport,
  WorktreeInfo
} from '../desktop'
import { request } from '../state/connection'

/** Catalog results without the message list (the phone pages transcripts). */
const LITE = { lite: true }
/** A cold pi start (extensions, MCP servers) can take a while. */
const OPEN_TIMEOUT_MS = 120_000
const LONG_TIMEOUT_MS = 10 * 60_000

/**
 * The desktop's IPC surface as the phone uses it. Channel names are the
 * desktop's own (src/main/ipc.ts); only allowlisted ones answer remotely.
 */
export const api = {
  app: {
    info: () => request<AppInfo>('pi-desktop:app:info'),
    userFirstName: () => request<string>('pi-desktop:app:user-first-name'),
    runtime: () => request<PiRuntimeInfo>('pi-desktop:runtime:info'),
    catalog: () => request<CatalogSnapshot>('pi-desktop:catalog:get'),
    listDirs: (path?: string) =>
      request<RemoteDirListing>('pi-desktop:remote:list-dirs', { path }),
    settings: () => request<{ computerUse: { enabled: boolean } }>('pi-desktop:app-settings:get')
  },
  sessions: {
    list: () => request<SessionSummary[]>('pi-desktop:sessions:list'),
    search: (query: string) =>
      request<SessionSearchHit[]>('pi-desktop:sessions:search', { query }),
    usage: () => request<UsageReport>('pi-desktop:sessions:usage', undefined, 60_000),
    rename: (sessionPath: string, name: string) =>
      request<void>('pi-desktop:sessions:rename', { sessionPath, name }, OPEN_TIMEOUT_MS),
    delete: (sessionPath: string) => request<void>('pi-desktop:sessions:delete', { sessionPath }),
    meta: () => request<SessionMetaMap>('pi-desktop:session-meta:get'),
    setMeta: (sessionPath: string, patch: SessionMetaPatch) =>
      request<SessionMetaMap>('pi-desktop:session-meta:set', { sessionPath, patch })
  },
  projects: {
    list: () => request<ProjectSummary[]>('pi-desktop:projects:list'),
    add: (cwd: string) => request<void>('pi-desktop:projects:add', { cwd }),
    createWorktree: (cwd: string, source?: WorktreeSource) =>
      request<WorktreeInfo>('pi-desktop:projects:create-worktree', { cwd, ...(source ? { source } : {}) }, 60_000),
    removeWorktree: (cwd: string, force = false, deleteBranch = false) =>
      request<GitActionResult>('pi-desktop:projects:remove-worktree', { cwd, force, deleteBranch })
  },
  /** A project repository's branches and worktrees. */
  git: {
    branches: (cwd: string) => request<RepoBranches>('pi-desktop:git:branches', { cwd }, 60_000),
    switchBranch: (cwd: string, branch: string) =>
      request<GitActionResult>('pi-desktop:git:switch', { cwd, branch }, 60_000),
    createBranch: (cwd: string, name: string) =>
      request<GitActionResult>('pi-desktop:git:create-branch', { cwd, name }, 60_000)
  },
  files: {
    list: (cwd: string) => request<{ files: string[] }>('pi-desktop:files:list', { cwd }),
    read: (cwd: string, path: string) =>
      request<FileReadResult>('pi-desktop:files:read', { cwd, path }),
    readImage: (cwd: string, path: string) =>
      request<{ mimeType: string; data: string; size: number }>(
        'pi-desktop:remote:read-image',
        { cwd, path },
        120_000
      ),
    /** Store a file from the phone on the computer; pi reads it by path. */
    upload: (name: string, data: string) =>
      request<{ path: string; size: number }>('pi-desktop:remote:upload', { name, data }, 5 * 60_000)
  },
  chat: {
    live: () => request<RemoteLiveChat[]>('pi-desktop:remote:live-chats'),
    idForSession: (sessionPath: string) =>
      request<string | undefined>('pi-desktop:chat:id-for-session', { sessionPath }),
    open: (input: { chatId: string; cwd?: string; sessionPath?: string }) =>
      request<ChatOpenResult>('pi-desktop:chat:open', { ...input, ...LITE }, OPEN_TIMEOUT_MS),
    /** State and catalog of a chat that is already open on the computer. */
    refresh: (chatId: string, withMessages = false) =>
      request<ChatOpenResult>(
        'pi-desktop:chat:refresh',
        withMessages ? { chatId } : { chatId, ...LITE },
        OPEN_TIMEOUT_MS
      ),
    reload: (chatId: string) =>
      request<ChatOpenResult>('pi-desktop:chat:reload', { chatId, ...LITE }, OPEN_TIMEOUT_MS),
    setCwd: (chatId: string, cwd: string) =>
      request<ChatOpenResult>('pi-desktop:chat:set-cwd', { chatId, cwd, ...LITE }, OPEN_TIMEOUT_MS),
    /** The newest `limit` messages, or the `limit` before branch index `before` (paging back). */
    transcript: (sessionPath: string, limit?: number, before?: number) =>
      request<ChatTranscriptResult>(
        'pi-desktop:chat:transcript',
        { sessionPath, limit, ...(before !== undefined ? { before } : {}) },
        60_000
      ),
    exportHtml: (sessionPath: string) =>
      request<{ html: string }>('pi-desktop:remote:export-html', { sessionPath }, OPEN_TIMEOUT_MS),
    send: (input: {
      chatId: string
      message: string
      images?: ImageContent[]
      mode: ChatSendMode
    }) => request<void>('pi-desktop:chat:send', input, OPEN_TIMEOUT_MS),
    abort: (chatId: string) => request<void>('pi-desktop:chat:abort', { chatId }),
    bash: (chatId: string, command: string) =>
      request<ChatBashResult>('pi-desktop:chat:bash', { chatId, command }, 24 * 60 * 60_000),
    abortBash: (chatId: string) => request<void>('pi-desktop:chat:abort-bash', { chatId }),
    clearQueue: (chatId: string) =>
      request<{ steering: string[]; followUp: string[] }>('pi-desktop:chat:clear-queue', {
        chatId
      }),
    setModel: (chatId: string, provider: string, modelId: string) =>
      request<SetModelResult>('pi-desktop:chat:set-model', { chatId, provider, modelId }),
    setThinkingLevel: (chatId: string, level: ThinkingLevel) =>
      request<void>('pi-desktop:chat:set-thinking-level', { chatId, level }),
    stats: (chatId: string) =>
      request<ChatSessionStats | undefined>('pi-desktop:chat:get-stats', { chatId }),
    compact: (chatId: string, customInstructions?: string) =>
      request<void>('pi-desktop:chat:compact', { chatId, customInstructions }, LONG_TIMEOUT_MS),
    setSessionName: (chatId: string, name: string) =>
      request<void>('pi-desktop:chat:set-session-name', { chatId, name }),
    forkMessages: (chatId: string) =>
      request<{ messages: ForkMessage[] }>('pi-desktop:chat:get-fork-messages', { chatId }),
    fork: (chatId: string, entryId: string) =>
      request<{ text?: string; cancelled?: boolean }>('pi-desktop:chat:fork', { chatId, entryId }),
    clone: (chatId: string) => request<{ cancelled?: boolean }>('pi-desktop:chat:clone', { chatId }),
    tree: (chatId: string) => request<PiTreeResult>('pi-desktop:chat:get-tree', { chatId }),
    lastAssistantText: (chatId: string) =>
      request<{ text: string | null }>('pi-desktop:chat:last-assistant-text', { chatId }),
    respondUi: (input: {
      chatId: string
      id: string
      value?: string
      confirmed?: boolean
      cancelled?: boolean
    }) => request<void>('pi-desktop:chat:respond-ui', input)
  },
  checkpoints: {
    create: (cwd: string) => request<string | null>('pi-desktop:checkpoints:create', { cwd }),
    restore: (cwd: string, checkpoint: string) =>
      request<CheckpointRestoreResult>('pi-desktop:checkpoints:restore', { cwd, checkpoint })
  },
  side: {
    open: (input: { sideId: string; cwd: string; sessionPath?: string; model?: SideModelInput }) =>
      request<void>('pi-desktop:side:open', input, OPEN_TIMEOUT_MS),
    send: (sideId: string, message: string) =>
      request<void>('pi-desktop:side:send', { sideId, message }, OPEN_TIMEOUT_MS),
    abort: (sideId: string) => request<void>('pi-desktop:side:abort', { sideId }),
    close: (sideId: string) => request<void>('pi-desktop:side:close', { sideId })
  },
  diff: {
    status: (cwd: string) => request<RepoDiffResult>('pi-desktop:diff:status', { cwd }, 60_000),
    summary: (cwd: string) => request<RepoSummary>('pi-desktop:diff:summary', { cwd }),
    discard: (cwd: string, path: string) =>
      request<GitActionResult>('pi-desktop:diff:discard', { cwd, path }),
    commit: (cwd: string, message: string) =>
      request<GitActionResult>('pi-desktop:diff:commit', { cwd, message }, 60_000),
    push: (cwd: string) => request<GitActionResult>('pi-desktop:diff:push', { cwd }, 120_000),
    review: (cwd: string, model?: SideModelInput) =>
      request<PiReviewComment[] | null>('pi-desktop:diff:review', { cwd, model }, LONG_TIMEOUT_MS),
    postComments: (cwd: string, comments: PrCommentInput[]) =>
      request<PrReviewPosted>('pi-desktop:diff:post-comments', { cwd, comments }, 120_000)
  },
  /** A project's diff comments, kept on the computer and shared by every screen. */
  reviewComments: {
    list: (cwd: string) => request<ReviewComment[]>('pi-desktop:review-comments:list', { cwd }),
    add: (cwd: string, comment: { path: string; line?: number; lineText: string; text: string }) =>
      request<ReviewComment>('pi-desktop:review-comments:add', { cwd, ...comment }),
    remove: (cwd: string, ids: string[]) =>
      request<ReviewComment[]>('pi-desktop:review-comments:remove', { cwd, ids }),
    clear: (cwd: string, paths?: string[]) =>
      request<ReviewComment[]>('pi-desktop:review-comments:clear', { cwd, ...(paths ? { paths } : {}) })
  },
  pr: {
    status: (cwd: string) => request<PrStatus>('pi-desktop:pr:status', { cwd }, 60_000),
    failedLog: (cwd: string, runId: string) =>
      request<string>('pi-desktop:pr:failed-log', { cwd, runId }, 60_000)
  },
  automations: {
    list: () => request<Automation[]>('pi-desktop:automations:list'),
    save: (input: AutomationInput) => request<Automation>('pi-desktop:automations:save', input),
    delete: (id: string) => request<void>('pi-desktop:automations:delete', { id }),
    runNow: (id: string) => request<void>('pi-desktop:automations:run-now', { id })
  },
  cua: {
    permissions: () => request<CuaPermissions>('pi-desktop:cua:permissions'),
    pause: () => request<void>('pi-desktop:cua:pause'),
    resume: () => request<void>('pi-desktop:cua:resume'),
    stop: () => request<void>('pi-desktop:cua:stop'),
    setEnabled: (enabled: boolean) =>
      request<{ enabled: boolean }>('pi-desktop:remote:set-computer-use', { enabled })
  }
}

/** Broadcast channels the phone listens to. */
export const EVENTS = {
  chatEvent: 'pi-desktop:chat:event',
  chatReady: 'pi-desktop:chat:ready',
  chatExit: 'pi-desktop:chat:exit',
  chatHint: 'pi-desktop:chat:hint',
  chatUiRequest: 'pi-desktop:chat:ui-request',
  chatUiResolved: 'pi-desktop:chat:ui-resolved',
  sideEvent: 'pi-desktop:side:event',
  sideExit: 'pi-desktop:side:exit',
  sessionsChanged: 'pi-desktop:sessions:changed',
  sessionMetaChanged: 'pi-desktop:session-meta:changed',
  automationsChanged: 'pi-desktop:automations:changed',
  reviewCommentsChanged: 'pi-desktop:review-comments:changed',
  gitChanged: 'pi-desktop:git:changed',
  cuaActivity: 'pi-desktop:cua:activity'
} as const

export type { AgentMessage }

export function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method [^:]+: (Error: )?/,
    ''
  )
}
