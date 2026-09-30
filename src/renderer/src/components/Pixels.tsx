import { memo } from 'react'

import { sigilPattern } from '../lib/sigil'

/**
 * Pixel glyphs: the pi mark is built from squares on a grid, and the UI's
 * small identity/status marks follow it — project sigils, the context gauge
 * and the thinking-level meter are all tiny square grids drawn as SVG.
 */

/**
 * Deterministic pixel sigil for a project folder — replaces the generic
 * folder icon so projects are recognizable at a glance in every list.
 */
export const ProjectSigil = memo(function ProjectSigil({
  seed,
  size = 14
}: {
  seed: string
  size?: number
}) {
  const { cells, hue } = sigilPattern(seed)
  return (
    <svg
      className="sigil"
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      style={{ color: `var(--sigil-${hue + 1})` }}
    >
      {cells.map((on, i) =>
        on ? (
          <rect key={i} x={(i % 3) * 5} y={Math.floor(i / 3) * 5} width="4" height="4" rx="0.6" />
        ) : null
      )}
    </svg>
  )
})

/** Hollow dashed square: a chat without a project (the app scratch dir). */
export function ScratchSigil({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="sigil sigil-scratch"
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="12" height="12" rx="1.5" />
    </svg>
  )
}

/**
 * Context gauge: nine cells filling bottom-up like a tank. At a glance it
 * reads as "how full", and it shares the sigils' grid.
 */
export function ContextCells({ percent }: { percent: number }) {
  const lit = percent <= 0 ? 0 : Math.max(1, Math.round((Math.min(100, percent) / 100) * 9))
  const cells = []
  for (let i = 0; i < 9; i++) {
    // Fill order: bottom row first, left to right.
    const row = 2 - Math.floor(i / 3)
    const col = i % 3
    cells.push(
      <rect
        key={i}
        className={i < lit ? 'cell-on' : 'cell-off'}
        x={col * 5}
        y={row * 5}
        width="4"
        height="4"
        rx="0.6"
      />
    )
  }
  return (
    <svg className="ctx-cells" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {cells}
    </svg>
  )
}

const LEVEL_STEPS: Record<string, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 5
}

/** Thinking effort as a row of five pixels. */
export function LevelMeter({ level }: { level: string }) {
  const steps = LEVEL_STEPS[level] ?? 0
  return (
    <svg className="level-meter" width="19" height="7" viewBox="0 0 19 7" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <rect
          key={i}
          className={i < steps ? 'cell-on' : 'cell-off'}
          x={i * 4}
          y={7 - (3 + i)}
          width="3"
          height={3 + i}
          rx="0.5"
        />
      ))}
    </svg>
  )
}
