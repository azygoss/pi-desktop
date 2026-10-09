import { Smartphone } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'

import type { RemotePairingCode, RemoteStatusInfo } from '../../../shared/api'
import { useAppStore } from '../state/app-store'
import { toast } from '../state/toast-store'
import { relativeTime } from './Sidebar'
import { ipcErrorMessage } from '../../../shared/ipc-error'

const QUIET_ZONE = 3

const errorText = ipcErrorMessage

function lastSeen(at: number): string {
  const age = relativeTime(new Date(at).toISOString())
  return age === 'now' ? 'just now' : `${age} ago`
}

/** The pairing code as one SVG path: dark modules on white, whatever the theme. */
function PairingCode({ code }: { code: RemotePairingCode }) {
  const path = useMemo(() => {
    let d = ''
    for (let y = 0; y < code.size; y++) {
      for (let x = 0; x < code.size; x++) {
        if (code.modules[y * code.size + x]) {
          d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`
        }
      }
    }
    return d
  }, [code])
  const side = code.size + QUIET_ZONE * 2
  return (
    <svg
      className="remote-qr"
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Pairing code"
      data-testid="remote-qr"
      data-payload={code.payload}
    >
      <rect width={side} height={side} fill="#ffffff" />
      <path d={path} fill="#0e0f11" />
    </svg>
  )
}

/** Settings → Remote control: turn the host on, pair a phone, manage phones. */
export function RemotePage() {
  const enabled = useAppStore((s) => s.appSettings.remote?.enabled ?? false)
  const updateAppSettings = useAppStore((s) => s.updateAppSettings)
  const [status, setStatus] = useState<RemoteStatusInfo | null>(null)
  const [code, setCode] = useState<RemotePairingCode | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.piDesktop.remote
      .status()
      .then((s) => {
        if (!cancelled) {
          setStatus(s)
        }
      })
      .catch(() => {})
    const unsubscribe = window.piDesktop.remote.onChanged((s) => setStatus(s))
    return () => {
      cancelled = true
      unsubscribe()
      // A code left on screen stops working once the page is closed.
      void window.piDesktop.remote.cancelPairing().catch(() => {})
    }
  }, [])

  // The code expires on its own, and is spent once a phone pairs with it
  // (main then reports no pairing in progress).
  useEffect(() => {
    if (!code) {
      return
    }
    const timer = setTimeout(() => setCode(null), Math.max(0, code.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [code])
  const shownCode = code && status?.pairingExpiresAt === code.expiresAt ? code : null

  async function pair(): Promise<void> {
    setBusy(true)
    try {
      const next = await window.piDesktop.remote.beginPairing()
      setStatus(await window.piDesktop.remote.status())
      setCode(next)
      // beginPairing turns remote control on; mirror that in the settings.
      await updateAppSettings({ remote: { enabled: true } })
    } catch (e) {
      toast(`Could not start pairing: ${errorText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  async function remove(deviceId: string, name: string): Promise<void> {
    const choice = await window.piDesktop.app.confirmDialog({
      title: `Remove ${name}?`,
      message: 'It is disconnected now and has to pair again to control this computer.',
      buttons: ['Remove', 'Cancel'],
      danger: true
    })
    if (choice === 0) {
      await window.piDesktop.remote.revoke({ deviceId }).catch(() => {})
    }
  }

  const address = status?.addresses[0]
  return (
    <div className="settings-section">
      <h2>Remote control</h2>
      <p className="settings-note settings-note-top">
        Use Pi Desktop from the Pi Remote app on your phone: start and follow chats, answer
        pi&apos;s questions, review and commit changes. The phone connects straight to this
        computer over your network (the same Wi-Fi, or a VPN such as Tailscale) and everything
        between them is end-to-end encrypted. A paired phone can do what this window can,
        including running commands in your projects.
      </p>
      <div className="settings-row">
        <div>
          <div className="settings-label">Remote control</div>
          <div className="settings-hint">
            {!enabled
              ? 'Paired phones cannot connect'
              : status?.error
                ? status.error
                : status?.running && address
                  ? `Listening on ${address}:${status.port}`
                  : status?.running
                    ? 'This computer is not on a network'
                    : 'Starting…'}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          data-testid="remote-toggle"
          className={clsx('switch', { on: enabled })}
          onClick={() => {
            setCode(null)
            void updateAppSettings({ remote: { enabled: !enabled } })
          }}
        >
          <span className="switch-knob" />
        </button>
      </div>

      <div className="settings-row settings-row-top">
        <div className="settings-row-text">
          <div className="settings-label">Pair a phone</div>
          <div className="settings-hint">
            {shownCode
              ? 'Open Pi Remote on the phone and scan this code. It works once, for five minutes.'
              : 'Shows a one-time QR code for the Pi Remote app'}
          </div>
          {shownCode && (
            <div className="remote-pairing">
              <PairingCode code={shownCode} />
              <div className="remote-pairing-side">
                <button
                  type="button"
                  className="ui-btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(shownCode.payload)
                    toast('Pairing link copied')
                  }}
                >
                  Copy pairing link
                </button>
                <button
                  type="button"
                  className="ui-btn"
                  onClick={() => {
                    setCode(null)
                    void window.piDesktop.remote.cancelPairing().catch(() => {})
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
        {!shownCode && (
          <button
            type="button"
            className="ui-btn"
            data-testid="remote-pair"
            disabled={busy}
            onClick={() => void pair()}
          >
            Show pairing code
          </button>
        )}
      </div>

      <div className="section-label remote-devices-label">Paired phones</div>
      {status && status.devices.length > 0 ? (
        status.devices.map((device) => (
          <div key={device.id} className="settings-row" data-testid="remote-device">
            <div className="remote-device">
              <Smartphone size={15} />
              <div>
                <div className="settings-label">{device.name}</div>
                <div className="settings-hint">
                  {device.connected
                    ? 'Connected'
                    : device.lastSeenAt
                      ? `Last seen ${lastSeen(device.lastSeenAt)}`
                      : 'Never connected'}
                </div>
              </div>
            </div>
            <div className="perm-actions">
              <button
                type="button"
                className="ui-btn"
                onClick={() => void remove(device.id, device.name)}
              >
                Remove
              </button>
            </div>
          </div>
        ))
      ) : (
        <div className="settings-hint">No phone is paired with this computer.</div>
      )}
    </div>
  )
}
