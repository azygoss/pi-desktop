export function App() {
  return (
    <div className="flex h-screen flex-col bg-[#1a1a19] text-neutral-200">
      <header className="drag-region flex h-12 shrink-0 items-center justify-center border-b border-neutral-800">
        <span className="text-sm font-medium text-neutral-400">Pi Desktop</span>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8">
        <h1 className="text-2xl font-semibold">Pi Desktop</h1>
        <p className="text-sm text-neutral-500">
          A desktop shell for the pi coding agent harness.
        </p>
      </main>
    </div>
  )
}
