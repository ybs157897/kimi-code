// apps/kimi-web/src/lib/interaction.ts
// Pure decision helpers behind two pointer/keyboard interactions, extracted
// verbatim from their components so the thresholds are unit-testable without a
// DOM: the BottomSheet.vue drag-to-close verdict and the ResizeHandle.vue
// keyboard step. The components still own all state and side effects; these
// functions only compute the next value.

// --- BottomSheet.vue: drag-to-close -----------------------------------------

/** Past this drag distance (px) a release always closes the sheet. */
export const DRAG_CLOSE_DISTANCE_PX = 80;
/** A downward fling faster than this (px/ms) closes even a short drag. */
export const DRAG_CLOSE_VELOCITY = 0.5;

/** Decide whether a released bottom-sheet drag closes the sheet or springs
 *  back home: releasing past the distance threshold closes, as does a downward
 *  fling (velocity over threshold) while the panel is displaced at all. A
 *  cancelled pointer (pointercancel) always springs back. */
export function shouldCloseSheetDrag(
  distancePx: number,
  velocity: number,
  cancelled = false,
): boolean {
  return (
    !cancelled &&
    (distancePx > DRAG_CLOSE_DISTANCE_PX || (velocity > DRAG_CLOSE_VELOCITY && distancePx > 0))
  );
}

// --- ResizeHandle.vue: keyboard step ----------------------------------------

/** Arrow-key step (px) for the resize handle. */
export const KEY_STEP = 4;
/** Arrow-key step (px) while Shift is held. */
export const KEY_STEP_LARGE = 16;

/** Clamp a size to [min, max], rounding to whole pixels — the same finite-input
 *  behavior as useResizable's setWidth. */
function clampResize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export interface ResizeKeyStepOptions {
  /** Current size (px). */
  width: number;
  /** The pressed key (KeyboardEvent.key). */
  key: string;
  /** Shift held — arrows take the large step. */
  shiftKey?: boolean;
  /** Smallest allowed size (px). */
  min: number;
  /** Largest allowed size (px). */
  max: number;
  /** Flip the arrow direction (a bottom panel grows upward). */
  reverse?: boolean;
}

/** Compute the next size for a resize-handle key press. Arrows step ±4px
 *  (±16px with Shift) and mirror the drag math, including the `reverse` flip,
 *  so a key moves the panel exactly where the equivalent drag would; Home/End
 *  jump to the clamps. Returns null for keys the handle ignores. The result is
 *  clamped to [min, max] just like setWidth, so a second clamp there is a
 *  no-op. */
export function resizeKeyStep(options: ResizeKeyStepOptions): number | null {
  const { width, key, shiftKey = false, min, max, reverse = false } = options;
  let direction: number;
  if (key === 'ArrowRight' || key === 'ArrowDown') direction = 1;
  else if (key === 'ArrowLeft' || key === 'ArrowUp') direction = -1;
  else if (key === 'Home') return clampResize(min, min, max);
  else if (key === 'End') return clampResize(max, min, max);
  else return null;
  const step = shiftKey ? KEY_STEP_LARGE : KEY_STEP;
  return clampResize(width + (reverse ? -direction : direction) * step, min, max);
}
