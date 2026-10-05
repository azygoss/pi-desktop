/**
 * The desktop app's platform-neutral modules, shared with the phone so both
 * render a chat from the same reducers and summaries. Metro reaches them
 * through `watchFolders` (see metro.config.js); nothing here touches the DOM
 * or Node.
 */
export * from '../../../src/shared/chat-view'
export * from '../../../src/shared/pi-types'
export * from '../../../src/shared/session-types'
export * from '../../../src/shared/thinking'
export * from '../../../src/shared/automations'
export * from '../../../src/shared/pr-status'
export * from '../../../src/shared/skill-prefix'
export {
  parseUnifiedDiff,
  diffFileForUntracked,
  countChanges,
  type DiffFile,
  type DiffHunk,
  type DiffFileStatus
} from '../../../src/shared/diff-parse'
export type { DiffLine as PatchLine } from '../../../src/shared/diff-parse'
export type { PiReviewComment, ReviewCommentsChange } from '../../../src/shared/review'
export type { PrCommentInput } from '../../../src/shared/pr-review'
export type { RepoBranches, WorktreeSource } from '../../../src/shared/git-branches'
export type {
  AppInfo,
  AttachmentReadResult,
  AutomationInput,
  CatalogSnapshot,
  ChatBashResult,
  ChatExitPayload,
  ChatEventPayload,
  ChatOpenResult,
  ChatReadyPayload,
  ChatSendMode,
  ChatSessionStats,
  ChatStartupHintPayload,
  ChatTranscriptResult,
  ChatUiRequestPayload,
  CheckpointRestoreResult,
  CuaActivity,
  CuaPermissions,
  FileReadResult,
  ForkMessage,
  GitActionResult,
  RepoDiffResult,
  RepoSummary,
  SessionMetaMap,
  SessionMetaPatch,
  SessionSearchHit,
  SetModelResult,
  SideEventPayload,
  SideModelInput,
  PrReviewPosted,
  UsageReport,
  UsageTotals,
  WorktreeInfo
} from '../../../src/shared/api'
export * from '../../../src/shared/remote/protocol'
export * from '../../../src/shared/remote/crypto'
export * from '../../../src/renderer/src/lib/tool-summary'
export * from '../../../src/renderer/src/lib/trace'
export * from '../../../src/renderer/src/lib/tool-images'
export * from '../../../src/renderer/src/lib/session-tree'
export * from '../../../src/renderer/src/lib/line-diff'
export * from '../../../src/renderer/src/lib/markdown-blocks'
export * from '../../../src/renderer/src/lib/sigil'
export * from '../../../src/renderer/src/lib/date-groups'
export * from '../../../src/renderer/src/lib/mentions'
export * from '../../../src/renderer/src/lib/slash-commands'
export * from '../../../src/renderer/src/lib/fuzzy'
export * from '../../../src/renderer/src/lib/review-comments'
export * from '../../../src/renderer/src/lib/providers'
export { chatToMarkdown } from '../../../src/renderer/src/lib/chat-markdown'
