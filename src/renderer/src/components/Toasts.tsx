import { useToastStore } from '../state/toast-store'

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts)
  if (toasts.length === 0) {
    return null
  }
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" onClick={() => useToastStore.getState().dismiss(t.id)}>
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={(e) => {
                e.stopPropagation()
                useToastStore.getState().dismiss(t.id)
                t.action!.run()
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
