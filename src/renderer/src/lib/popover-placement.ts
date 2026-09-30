import { useLayoutEffect, useState, type RefObject } from 'react'

/** Title bar (44px) plus breathing room above a popover. */
const TOP_RESERVE = 56
const BOTTOM_RESERVE = 12
/** Gap between the anchor and the popover (`calc(100% + 8px)` in CSS). */
const GAP = 8

export interface PopoverPlacement {
  /** Open downward from the anchor instead of upward. */
  below: boolean
  maxHeight: number
}

export interface PlacementLimits {
  max: number
  min: number
}

/**
 * Picks the side of the anchor with more room: upward from the docked chat
 * composer, downward from the home composer that sits mid-screen (where the
 * space above is only a sliver). The height fits whichever side it takes.
 * Pure so it can be tested without a DOM.
 */
export function placePopover(
  anchor: { top: number; bottom: number },
  viewportHeight: number,
  limits: PlacementLimits
): PopoverPlacement {
  const above = anchor.top - TOP_RESERVE - GAP
  const below = viewportHeight - anchor.bottom - BOTTOM_RESERVE - GAP
  const openBelow = below > above
  return {
    below: openBelow,
    maxHeight: Math.max(limits.min, Math.min(limits.max, openBelow ? below : above))
  }
}

/** Measures the anchor each time the popover opens. */
export function usePopoverPlacement(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  limits: PlacementLimits
): PopoverPlacement {
  const [placement, setPlacement] = useState<PopoverPlacement>({
    below: false,
    maxHeight: limits.max
  })
  const { max, min } = limits

  useLayoutEffect(() => {
    if (!open) {
      return
    }
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) {
      setPlacement(placePopover(rect, window.innerHeight, { max, min }))
    }
  }, [open, anchorRef, max, min])

  return placement
}
