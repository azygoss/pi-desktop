import { RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { greetingFor } from '../lib/greeting'
import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { Composer } from './Composer'
import { PiLogo } from './PiLogo'

export function HomeView() {
  const userName = useAppStore((s) => s.userName)
  const piAvailable = useAppStore((s) => s.piAvailable)
  const activeProjectCwd = useAppStore((s) => s.activeProjectCwd)
  const defaultCwd = useAppStore((s) => s.appSettings.defaultCwd)
  const navigate = useAppStore((s) => s.navigate)

  const [draftId] = useState(() => crypto.randomUUID())
  const sentRef = useRef(false)
  const chat = useChatStore((s) => s.chats[draftId])

  // Eagerly spawn a draft pi process so the composer has models/state. Drafts
  // do not create session files until the first prompt (verified against real
  // pi 0.85.1). Closed on unmount unless a message was sent.
  useEffect(() => {
    if (!piAvailable) {
      return
    }
    void useChatStore
      .getState()
      .ensureChat(draftId, { cwd: activeProjectCwd ?? defaultCwd ?? undefined })
      .catch(() => {})
    return () => {
      if (!sentRef.current) {
        void useChatStore.getState().closeChat(draftId)
      }
    }
  }, [draftId, piAvailable, activeProjectCwd, defaultCwd])

  const greeting = greetingFor(userName)

  return (
    <div className="home-view">
      <div className="home-center">
        <div className="home-greeting">
          <PiLogo size={28} />
          <h1>{greeting}</h1>
        </div>

        {!piAvailable ? (
          <div className="install-card">
            <p>
              <strong>pi is not installed.</strong> Install the pi coding agent to use
              Pi Desktop:
            </p>
            <code>curl -fsSL https://pi.dev/install.sh | sh</code>
            <button
              type="button"
              className="ui-btn"
              onClick={() => void useAppStore.getState().init()}
            >
              <RotateCcw size={12} /> Retry
            </button>
          </div>
        ) : (
          <Composer
            chat={chat ?? null}
            autoFocus
            onSend={(message, images, mode) => {
              sentRef.current = true
              void useChatStore
                .getState()
                .send(draftId, message, images, mode)
                .catch(() => {})
              navigate({ kind: 'chat', chatId: draftId })
            }}
          />
        )}
      </div>
    </div>
  )
}
