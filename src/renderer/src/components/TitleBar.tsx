import { ChevronLeft, ChevronRight, PanelLeft } from 'lucide-react'

import { useAppStore } from '../state/app-store'

export function TitleBar() {
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const backStack = useAppStore((s) => s.backStack)
  const forwardStack = useAppStore((s) => s.forwardStack)
  const goBack = useAppStore((s) => s.goBack)
  const goForward = useAppStore((s) => s.goForward)

  return (
    <div
      className="drag-region"
      style={{
        height: 44,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 78,
        paddingRight: 12,
        gap: 2
      }}
    >
      <button
        type="button"
        className="icon-btn"
        onClick={toggleSidebar}
        title={sidebarCollapsed ? 'Expand sidebar (⌘B)' : 'Collapse sidebar (⌘B)'}
      >
        <PanelLeft size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={goBack}
        disabled={backStack.length === 0}
        title="Back (⌘[)"
      >
        <ChevronLeft size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={goForward}
        disabled={forwardStack.length === 0}
        title="Forward (⌘])"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  )
}
