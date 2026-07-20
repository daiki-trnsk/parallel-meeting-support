import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from 'react';
import { useMeetingRecorder, type MeetingId } from '../hooks/useMeetingRecorder';
import { useCommaScheduler, type FocusMeeting } from '../hooks/useCommaScheduler';

const CATCHUP_EPSILON_SEC = 0.75;
const EVICTION_INTERVAL_MS = 5000;

export type DebugEvent = {
  event: 'focus-switch' | 'catchup-missed' | 'warmup-fallback';
  meeting: MeetingId;
  cycleIndex: number;
  [key: string]: unknown;
};

export type PlaybackSnapshot = {
  focus: FocusMeeting;
  cycleIndex: number;
  isWarmup: boolean;
  videos: Record<
    MeetingId,
    { currentTime: number; playbackRate: number; buffered: TimeRanges | null; recorderState: string }
  >;
};

export type PlaybackControllerHandle = {
  getCurrentTime: (meeting: MeetingId) => number;
  getFocusedMeeting: () => FocusMeeting;
  getSnapshot: () => PlaybackSnapshot;
  /** Plays both video elements from a direct user-gesture call site, so the
   * browser's unmuted-autoplay-with-sound policy is satisfied before
   * `started` flips the actual comma playback on. Call this synchronously
   * from a click handler, not from an effect. */
  unlockPlayback: () => void;
};

type Props = {
  trackA: MediaStreamTrack | null;
  trackB: MediaStreamTrack | null;
  audioTrackA?: MediaStreamTrack | null;
  audioTrackB?: MediaStreamTrack | null;
  started: boolean;
  onDebugEvent?: (event: DebugEvent) => void;
};

const PlaybackController = forwardRef<PlaybackControllerHandle, Props>(
  ({ trackA, trackB, audioTrackA = null, audioTrackB = null, started, onDebugEvent }, ref) => {
    const recA = useMeetingRecorder(trackA, audioTrackA, 'A');
    const recB = useMeetingRecorder(trackB, audioTrackB, 'B');
    const scheduler = useCommaScheduler(10000);

    const videoElA = useRef<HTMLVideoElement | null>(null);
    const videoElB = useRef<HTMLVideoElement | null>(null);
    const lastAppliedCycleRef = useRef<number>(-1);
    const emit = (e: DebugEvent) => {
      console.log('[comma-debug]', e);
      onDebugEvent?.(e);
    };

    // preservesPitch is a media-element IDL property, not a settable JSX/HTML
    // attribute, so it must be assigned imperatively on the element.
    //
    // These MUST be memoized (useCallback), not inline arrow functions: React
    // detaches+reattaches a ref whenever its callback identity changes, and an
    // inline function is a new identity on every render. PlaybackController
    // re-renders often (every recA/recB state transition, every scheduler
    // tick), so an unmemoized ref here caused recA.mediaRef/recB.mediaRef to
    // fire on nearly every render, each time reassigning video.src to a fresh
    // blob URL around the same already-open MediaSource and resetting playback.
    const attachVideoA = useCallback(
      (el: HTMLVideoElement | null) => {
        videoElA.current = el;
        if (el) el.preservesPitch = true;
        recA.mediaRef(el);
      },
      [recA.mediaRef],
    );
    const attachVideoB = useCallback(
      (el: HTMLVideoElement | null) => {
        videoElB.current = el;
        if (el) el.preservesPitch = true;
        recB.mediaRef(el);
      },
      [recB.mediaRef],
    );

    const recFor = (m: MeetingId) => (m === 'A' ? recA : recB);
    const videoFor = (m: MeetingId) => (m === 'A' ? videoElA.current : videoElB.current);

    const forceCatchupIfNeeded = (meeting: MeetingId, cycleIndex: number) => {
      const el = videoFor(meeting);
      const buffered = recFor(meeting).getBuffered();
      if (!el || !buffered || buffered.length === 0) return;
      const bufferedEnd = buffered.end(buffered.length - 1);
      if (bufferedEnd - el.currentTime > CATCHUP_EPSILON_SEC) {
        el.currentTime = bufferedEnd;
        el.playbackRate = 1.0;
        emit({ event: 'catchup-missed', meeting, cycleIndex, bufferedEnd, currentTimeBefore: el.currentTime });
      }
    };

    useEffect(() => {
      if (!started) return;
      if (lastAppliedCycleRef.current === scheduler.cycleIndex) return;
      lastAppliedCycleRef.current = scheduler.cycleIndex;

      if (scheduler.cycleIndex > 0) {
        const leaving: MeetingId = scheduler.cycleIndex % 2 === 1 ? 'A' : 'B';
        forceCatchupIfNeeded(leaving, scheduler.cycleIndex);
      }

      const target: MeetingId = scheduler.focus;
      const rec = recFor(target);
      const el = videoFor(target);
      if (!el) return;

      if (scheduler.isWarmup) {
        el.playbackRate = 1.0;
        el.play().catch((e) => console.warn('[comma-debug] autoplay failed', e));
      } else {
        const buffered = rec.getBuffered();
        if (!buffered || buffered.length === 0) {
          el.playbackRate = 1.0;
          el.play().catch((e) => console.warn('[comma-debug] autoplay failed', e));
          emit({ event: 'warmup-fallback', meeting: target, cycleIndex: scheduler.cycleIndex });
        } else {
          const bufferedStart = buffered.start(0);
          const bufferedEnd = buffered.end(buffered.length - 1);
          const seekTarget = Math.max(bufferedStart, bufferedEnd - 10);
          el.currentTime = seekTarget;
          el.playbackRate = 2.0;
          el.play().catch((e) => console.warn('[comma-debug] autoplay failed', e));
          emit({ event: 'focus-switch', meeting: target, cycleIndex: scheduler.cycleIndex, seekTarget, bufferedEnd });
        }
      }

      const other: MeetingId = target === 'A' ? 'B' : 'A';
      videoFor(other)?.pause();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scheduler.cycleIndex, started]);

    useEffect(() => {
      if (!started) return;
      const interval = window.setInterval(() => {
        recA.requestEviction(videoElA.current?.currentTime ?? 0);
        recB.requestEviction(videoElB.current?.currentTime ?? 0);
      }, EVICTION_INTERVAL_MS);
      return () => window.clearInterval(interval);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [started]);

    useImperativeHandle(
      ref,
      () => ({
        getCurrentTime: (meeting) => videoFor(meeting)?.currentTime ?? 0,
        getFocusedMeeting: () => scheduler.focus,
        unlockPlayback: () => {
          videoElA.current?.play().catch(() => {});
          videoElB.current?.play().catch(() => {});
        },
        getSnapshot: () => ({
          focus: scheduler.focus,
          cycleIndex: scheduler.cycleIndex,
          isWarmup: scheduler.isWarmup,
          videos: {
            A: {
              currentTime: videoElA.current?.currentTime ?? 0,
              playbackRate: videoElA.current?.playbackRate ?? 0,
              buffered: recA.getBuffered(),
              recorderState: recA.state,
            },
            B: {
              currentTime: videoElB.current?.currentTime ?? 0,
              playbackRate: videoElB.current?.playbackRate ?? 0,
              buffered: recB.getBuffered(),
              recorderState: recB.state,
            },
          },
        }),
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [scheduler.focus, scheduler.cycleIndex],
    );

    // Layout only, below — no recording/scheduling logic here. Both videos
    // are always visible side by side (never display:none); the non-focused
    // one is simply pause()'d by the effect above, which naturally leaves
    // its last decoded frame on screen as a frozen still.
    const panelStyle = (meeting: MeetingId): CSSProperties => ({
      flex: 1,
      position: 'relative',
      background: '#000',
      overflow: 'hidden',
      borderTop: `3px solid ${scheduler.focus === meeting ? '#4caf50' : '#333'}`,
    });
    const labelStyle: CSSProperties = {
      position: 'absolute',
      top: 6,
      left: 8,
      fontSize: 12,
      fontFamily: 'monospace',
      color: '#ddd',
      background: 'rgba(0,0,0,0.5)',
      padding: '1px 6px',
      borderRadius: 3,
      zIndex: 1,
      pointerEvents: 'none',
    };

    return (
      <div style={{ display: 'flex', width: '100%', height: '100%' }}>
        <div style={panelStyle('A')}>
          <div style={labelStyle}>A{scheduler.focus === 'A' ? ' ▶' : ''}</div>
          <video
            ref={attachVideoA}
            playsInline
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        </div>
        <div style={panelStyle('B')}>
          <div style={labelStyle}>B{scheduler.focus === 'B' ? ' ▶' : ''}</div>
          <video
            ref={attachVideoB}
            playsInline
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        </div>
      </div>
    );
  },
);

PlaybackController.displayName = 'PlaybackController';

export default PlaybackController;
