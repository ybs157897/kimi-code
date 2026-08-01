// apps/kimi-web/test/interaction.test.ts
// Logic tests for the pure interaction helpers extracted from BottomSheet.vue
// (drag-to-close verdict) and ResizeHandle.vue (keyboard step). No DOM / no
// component mounting — these are plain functions.
import { describe, expect, it } from 'vitest';
import {
  DRAG_CLOSE_DISTANCE_PX,
  DRAG_CLOSE_VELOCITY,
  KEY_STEP,
  KEY_STEP_LARGE,
  resizeKeyStep,
  shouldCloseSheetDrag,
} from '../src/lib/interaction';

describe('shouldCloseSheetDrag — distance threshold', () => {
  it('closes past the distance threshold with no fling', () => {
    expect(shouldCloseSheetDrag(DRAG_CLOSE_DISTANCE_PX + 1, 0)).toBe(true);
    expect(shouldCloseSheetDrag(100, 0)).toBe(true);
  });

  it('springs back at or under the distance threshold (strict >)', () => {
    expect(shouldCloseSheetDrag(DRAG_CLOSE_DISTANCE_PX, 0)).toBe(false);
    expect(shouldCloseSheetDrag(DRAG_CLOSE_DISTANCE_PX - 1, 0)).toBe(false);
    expect(shouldCloseSheetDrag(0, 0)).toBe(false);
  });
});

describe('shouldCloseSheetDrag — velocity rule', () => {
  it('closes on a downward fling over the velocity threshold while displaced', () => {
    expect(shouldCloseSheetDrag(10, DRAG_CLOSE_VELOCITY + 0.01)).toBe(true);
    expect(shouldCloseSheetDrag(1, 1)).toBe(true);
  });

  it('springs back at or under the velocity threshold (strict >)', () => {
    expect(shouldCloseSheetDrag(10, DRAG_CLOSE_VELOCITY)).toBe(false);
    expect(shouldCloseSheetDrag(10, 0)).toBe(false);
  });

  it('ignores a fling when the panel is not displaced (distance must be > 0)', () => {
    expect(shouldCloseSheetDrag(0, 1)).toBe(false);
  });
});

describe('shouldCloseSheetDrag — cancelled pointer', () => {
  it('always springs back when the pointer was cancelled', () => {
    expect(shouldCloseSheetDrag(200, 0, true)).toBe(false);
    expect(shouldCloseSheetDrag(50, 10, true)).toBe(false);
  });
});

describe('resizeKeyStep — arrow stepping', () => {
  const bounds = { min: 100, max: 400 };

  it('steps ±4px on the x-axis arrows', () => {
    expect(resizeKeyStep({ width: 250, key: 'ArrowRight', ...bounds })).toBe(250 + KEY_STEP);
    expect(resizeKeyStep({ width: 250, key: 'ArrowLeft', ...bounds })).toBe(250 - KEY_STEP);
  });

  it('maps the y-axis arrows onto the same directions (axis-agnostic keys)', () => {
    expect(resizeKeyStep({ width: 250, key: 'ArrowDown', ...bounds })).toBe(250 + KEY_STEP);
    expect(resizeKeyStep({ width: 250, key: 'ArrowUp', ...bounds })).toBe(250 - KEY_STEP);
  });

  it('multiplies the step by 4 while Shift is held', () => {
    expect(resizeKeyStep({ width: 250, key: 'ArrowRight', shiftKey: true, ...bounds })).toBe(
      250 + KEY_STEP_LARGE,
    );
    expect(resizeKeyStep({ width: 250, key: 'ArrowLeft', shiftKey: true, ...bounds })).toBe(
      250 - KEY_STEP_LARGE,
    );
  });

  it('flips the direction when reverse is set (bottom panel grows upward)', () => {
    expect(resizeKeyStep({ width: 250, key: 'ArrowRight', reverse: true, ...bounds })).toBe(
      250 - KEY_STEP,
    );
    expect(resizeKeyStep({ width: 250, key: 'ArrowLeft', reverse: true, ...bounds })).toBe(
      250 + KEY_STEP,
    );
    expect(resizeKeyStep({ width: 250, key: 'ArrowDown', reverse: true, ...bounds })).toBe(
      250 - KEY_STEP,
    );
    expect(
      resizeKeyStep({ width: 250, key: 'ArrowRight', shiftKey: true, reverse: true, ...bounds }),
    ).toBe(250 - KEY_STEP_LARGE);
  });
});

describe('resizeKeyStep — Home/End jumps', () => {
  const bounds = { min: 100, max: 400 };

  it('jumps to the clamps, ignoring Shift', () => {
    expect(resizeKeyStep({ width: 250, key: 'Home', ...bounds })).toBe(100);
    expect(resizeKeyStep({ width: 250, key: 'End', ...bounds })).toBe(400);
    expect(resizeKeyStep({ width: 250, key: 'Home', shiftKey: true, ...bounds })).toBe(100);
    expect(resizeKeyStep({ width: 250, key: 'End', shiftKey: true, ...bounds })).toBe(400);
  });
});

describe('resizeKeyStep — clamping', () => {
  const bounds = { min: 100, max: 400 };

  it('clamps to min when a step undershoots', () => {
    expect(resizeKeyStep({ width: 102, key: 'ArrowLeft', ...bounds })).toBe(100);
    expect(resizeKeyStep({ width: 110, key: 'ArrowLeft', shiftKey: true, ...bounds })).toBe(100);
    expect(resizeKeyStep({ width: 102, key: 'ArrowRight', reverse: true, ...bounds })).toBe(100);
  });

  it('clamps to max when a step overshoots', () => {
    expect(resizeKeyStep({ width: 398, key: 'ArrowRight', ...bounds })).toBe(400);
    expect(resizeKeyStep({ width: 390, key: 'ArrowRight', shiftKey: true, ...bounds })).toBe(400);
  });

  it('rounds the result to whole pixels', () => {
    expect(resizeKeyStep({ width: 250.6, key: 'ArrowRight', ...bounds })).toBe(255);
  });
});

describe('resizeKeyStep — unhandled keys', () => {
  const bounds = { min: 100, max: 400 };

  it('returns null for keys the handle ignores', () => {
    expect(resizeKeyStep({ width: 250, key: 'a', ...bounds })).toBeNull();
    expect(resizeKeyStep({ width: 250, key: 'Enter', ...bounds })).toBeNull();
    expect(resizeKeyStep({ width: 250, key: ' ', ...bounds })).toBeNull();
    expect(resizeKeyStep({ width: 250, key: '', ...bounds })).toBeNull();
  });
});
