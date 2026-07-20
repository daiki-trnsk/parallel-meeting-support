import { useEffect, useState } from 'react';

export type FocusMeeting = 'A' | 'B';

export type CommaSchedulerState = {
  focus: FocusMeeting;
  cycleIndex: number;
  isWarmup: boolean;
  focusStartEpochMs: number;
};

const DEFAULT_PERIOD_MS = 10000;

function computeState(idx: number): CommaSchedulerState {
  return {
    focus: idx % 2 === 0 ? 'A' : 'B',
    cycleIndex: idx,
    isWarmup: idx === 0,
    focusStartEpochMs: Date.now(),
  };
}

/**
 * Self-correcting 10s focus-alternation timer. Uses setTimeout (not rAF,
 * which throttles/stops in hidden tabs) and recomputes the absolute cycle
 * index from performance.now() on every fire, so drift or a late/clamped
 * timeout never accumulates — a delayed fire just jumps straight to the
 * correct current index instead of replaying missed transitions.
 */
export function useCommaScheduler(periodMs: number = DEFAULT_PERIOD_MS): CommaSchedulerState {
  const [state, setState] = useState<CommaSchedulerState>(() => computeState(0));

  useEffect(() => {
    const origin = performance.now();
    let timeoutId: number;

    const tick = () => {
      const elapsed = performance.now() - origin;
      const idx = Math.floor(elapsed / periodMs);
      setState((prev) => (prev.cycleIndex === idx ? prev : computeState(idx)));

      const nextBoundary = (idx + 1) * periodMs;
      const delay = Math.max(0, nextBoundary - (performance.now() - origin));
      timeoutId = window.setTimeout(tick, delay);
    };

    timeoutId = window.setTimeout(tick, periodMs);

    const onVisible = () => {
      if (!document.hidden) {
        window.clearTimeout(timeoutId);
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [periodMs]);

  return state;
}
