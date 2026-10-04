import { Pin } from 'lucide-react-native'
import { memo } from 'react'
import { View } from 'react-native'

import type { SessionSummary } from '../desktop'
import { baseName, relativeTime } from '../lib/format'
import { space, TOUCH, useTheme } from '../theme'
import { Mono, Pixel, ScratchSigil, Sigil, Tap, Txt, type PixelTone } from './index'

/**
 * One chat in a list: the project's sigil, the title, and a mono readout of
 * project and age. A status pixel replaces the age while pi is working
 * (hollow blue), waiting on the user (amber) or has an unread reply (blue).
 */
export const SessionRow = memo(function SessionRow({
  session,
  status,
  pinned,
  projectless,
  showProject = true,
  onPress,
  onLongPress
}: {
  session: SessionSummary
  status?: PixelTone | null
  pinned?: boolean
  /** The session lives in the scratch workspace, not a project. */
  projectless?: boolean
  showProject?: boolean
  onPress(session: SessionSummary): void
  onLongPress?(session: SessionSummary): void
}) {
  const theme = useTheme()
  const statusWord =
    status === 'working' ? 'working' : status === 'attention' ? 'needs you' : status === 'unread' ? 'new reply' : ''
  return (
    <Tap
      onPress={() => onPress(session)}
      onLongPress={onLongPress ? () => onLongPress(session) : undefined}
      accessibilityLabel={`${session.title}${statusWord ? `, ${statusWord}` : ''}`}
      accessibilityHint={onLongPress ? 'Long press for more actions' : undefined}
      style={{
        minHeight: TOUCH + 12,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm + 2,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md
      }}
    >
      {projectless ? <ScratchSigil size={18} /> : <Sigil seed={session.cwd} size={18} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt numberOfLines={1} weight={status === 'unread' ? 'semibold' : 'regular'}>
          {session.title || 'Untitled chat'}
        </Txt>
        <Mono size={12} tone="muted" numberOfLines={1}>
          {showProject && !projectless ? `${baseName(session.cwd)} · ` : ''}
          {statusWord || relativeTime(session.modified)}
        </Mono>
      </View>
      {pinned ? <Pin size={14} color={theme.muted} strokeWidth={1.75} /> : null}
      {status ? <Pixel tone={status} /> : null}
    </Tap>
  )
})
