import { Play, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'

import type { AutomationInput } from '../../../shared/api'
import {
  MIN_INTERVAL_MINUTES,
  describeSchedule,
  nextRunAt,
  type Automation,
  type AutomationSchedule
} from '../../../shared/automations'
import { useAppStore } from '../state/app-store'
import { toast } from '../state/toast-store'
import { ModalShell } from './CommandModals'
import { openSession } from './Sidebar'

const INTERVALS: { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: 'hour' },
  { minutes: 180, label: '3 hours' },
  { minutes: 360, label: '6 hours' },
  { minutes: 720, label: '12 hours' }
]

const whenFormat = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
})

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method [^:]+: (Error: )?/,
    ''
  )
}

const BLANK: AutomationInput = {
  name: '',
  prompt: '',
  cwd: '',
  schedule: { kind: 'daily', time: '09:00', weekdaysOnly: true },
  enabled: true
}

/** The editor for one automation (new or existing). */
function AutomationForm({
  initial,
  onSaved,
  onCancel
}: {
  initial: AutomationInput
  onSaved(): void
  onCancel(): void
}) {
  const projects = useAppStore((s) => s.projects)
  const [draft, setDraft] = useState<AutomationInput>(initial)
  const [saving, setSaving] = useState(false)
  const schedule = draft.schedule
  const setSchedule = (next: AutomationSchedule) => setDraft({ ...draft, schedule: next })
  // A saved project that is no longer listed (hidden, removed) still shows.
  const knownCwd = draft.cwd === '' || projects.some((p) => p.cwd === draft.cwd)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.piDesktop.automations.save(draft)
      onSaved()
    } catch (e) {
      toast(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="automation-form" data-testid="automation-form">
      <input
        className="ui-dialog-input"
        autoFocus
        value={draft.name}
        placeholder="Name — e.g. Morning issue triage"
        maxLength={80}
        spellCheck={false}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <textarea
        className="ui-dialog-input"
        rows={5}
        value={draft.prompt}
        placeholder="What should pi do each time? Slash commands and skills work here too."
        onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
      />
      <div className="automation-form-row">
        <label>
          <span>Project</span>
          <select value={draft.cwd} onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}>
            <option value="">Without project</option>
            {!knownCwd && <option value={draft.cwd}>{draft.cwd.split('/').pop()}</option>}
            {projects.map((p) => (
              <option key={p.cwd} value={p.cwd}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Repeat</span>
          <select
            value={schedule.kind}
            onChange={(e) =>
              setSchedule(
                e.target.value === 'daily'
                  ? { kind: 'daily', time: '09:00', weekdaysOnly: true }
                  : { kind: 'interval', minutes: 60 }
              )
            }
          >
            <option value="daily">Daily at a time</option>
            <option value="interval">Every…</option>
          </select>
        </label>
        {schedule.kind === 'daily' ? (
          <>
            <label>
              <span>Time</span>
              <input
                type="time"
                value={schedule.time}
                onChange={(e) => e.target.value && setSchedule({ ...schedule, time: e.target.value })}
              />
            </label>
            <label className="automation-check">
              <input
                type="checkbox"
                checked={schedule.weekdaysOnly === true}
                onChange={(e) => setSchedule({ ...schedule, weekdaysOnly: e.target.checked })}
              />
              <span>Weekdays only</span>
            </label>
          </>
        ) : (
          <label>
            <span>Interval</span>
            <select
              value={schedule.minutes}
              onChange={(e) =>
                setSchedule({
                  kind: 'interval',
                  minutes: Math.max(MIN_INTERVAL_MINUTES, Number(e.target.value))
                })
              }
            >
              {!INTERVALS.some((i) => i.minutes === schedule.minutes) && (
                <option value={schedule.minutes}>{schedule.minutes} minutes</option>
              )}
              {INTERVALS.map((i) => (
                <option key={i.minutes} value={i.minutes}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="ui-dialog-actions">
        <button type="button" className="ui-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={saving || !draft.name.trim() || !draft.prompt.trim()}
          onClick={() => void save()}
        >
          {draft.id ? 'Save' : 'Create automation'}
        </button>
      </div>
    </div>
  )
}

/**
 * Automations: prompts pi runs on a schedule while the app is open. Each run
 * is an ordinary chat that starts in the background.
 */
export function AutomationsModal() {
  const [list, setList] = useState<Automation[] | null>(null)
  // When the list was read; "next run" is shown relative to it.
  const [loadedAt, setLoadedAt] = useState(0)
  const [editing, setEditing] = useState<AutomationInput | null>(null)
  const sessions = useAppStore((s) => s.sessions)
  const workspaceDir = useAppStore((s) => s.appInfo?.workspaceDir ?? '')
  const close = useCallback(() => useAppStore.getState().setAutomationsOpen(false), [])

  const reload = useCallback(() => {
    void window.piDesktop.automations
      .list()
      .then((items) => {
        setList(items)
        setLoadedAt(Date.now())
      })
      .catch(() => setList([]))
  }, [])

  useEffect(() => {
    const timer = setTimeout(reload, 0)
    const off = window.piDesktop.automations.onChanged(reload)
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [reload])

  const projectName = (cwd: string): string =>
    !cwd || cwd === workspaceDir ? 'Without project' : (cwd.split('/').filter(Boolean).pop() ?? cwd)

  const remove = async (automation: Automation): Promise<void> => {
    const choice = await window.piDesktop.app.confirmDialog({
      title: `Delete the automation "${automation.name}"?`,
      message: 'Chats from its earlier runs are kept.',
      buttons: ['Delete', 'Cancel'],
      danger: true
    })
    if (choice === 0) {
      await window.piDesktop.automations.delete({ id: automation.id }).catch(() => {})
    }
  }

  return (
    <ModalShell title="Automations" onClose={close}>
      {editing ? (
        <AutomationForm
          initial={editing}
          onSaved={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div className="automations" data-testid="automations">
          <div className="cmd-modal-hint">
            Prompts pi runs on a schedule while Pi Desktop is open. Each run is a chat that starts
            in the background; a run missed while the app was closed happens once when it opens.
          </div>
          {list?.map((automation) => {
            const lastSession = sessions.find((s) => s.path === automation.lastSessionPath)
            return (
              <div
                key={automation.id}
                className={clsx('automation-row', { 'is-off': !automation.enabled })}
              >
                <button
                  type="button"
                  className="automation-main"
                  title="Edit"
                  onClick={() => setEditing({ ...automation })}
                >
                  <span className="automation-name">{automation.name}</span>
                  <span className="automation-meta">
                    {describeSchedule(automation.schedule)} · {projectName(automation.cwd)}
                    {automation.enabled
                      ? ` · next ${whenFormat.format(Math.max(nextRunAt(automation), loadedAt))}`
                      : ' · paused'}
                  </span>
                </button>
                {lastSession && (
                  <button
                    type="button"
                    className="ui-btn automation-last"
                    onClick={() => {
                      close()
                      openSession(lastSession)
                    }}
                  >
                    Last run
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  title="Run now"
                  onClick={() =>
                    void window.piDesktop.automations
                      .runNow({ id: automation.id })
                      .then(() => toast(`Started "${automation.name}"`))
                      .catch((e: unknown) => toast(errorText(e)))
                  }
                >
                  <Play size={13} />
                </button>
                <button
                  type="button"
                  className={clsx('switch', 'automation-switch', { on: automation.enabled })}
                  role="switch"
                  aria-checked={automation.enabled}
                  title={automation.enabled ? 'Pause' : 'Resume'}
                  onClick={() =>
                    void window.piDesktop.automations
                      .save({ ...automation, enabled: !automation.enabled })
                      .catch((e: unknown) => toast(errorText(e)))
                  }
                >
                  <span className="switch-knob" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Delete…"
                  onClick={() => void remove(automation)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )
          })}
          {list?.length === 0 && <div className="automations-empty">No automations yet.</div>}
          <button
            type="button"
            className="ui-btn automations-new"
            onClick={() => setEditing({ ...BLANK })}
          >
            <Plus size={13} /> New automation
          </button>
        </div>
      )}
    </ModalShell>
  )
}
