import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room } from 'livekit-client';
import type { MeetingId } from './useMeetingRecorder';

const SUMMON_TOPIC = 'summon';

/**
 * Below this, a summon skipped nothing worth calling a lost window.
 *
 * Sized off the existing playback machinery's own precision rather than
 * picked arbitrarily: MediaRecorder emits chunks on a 250 ms timeslice and
 * PlaybackController tolerates a 0.75 s catch-up epsilon (CATCHUP_EPSILON_
 * SEC) before it considers a meeting "behind" at all. A gap under half a
 * second is therefore inside the noise floor of "already realtime", and
 * recording it would just litter the history with empty windows.
 */
const MIN_LOST_WINDOW_MS = 500;

/**
 * Cap on how far markRealtimeReached may push a lost window's end past the
 * moment of trigger. The switch normally completes in tens of ms; a much
 * larger value means the overlay stalled (no tracks yet, decode hiccup)
 * rather than the user genuinely watching nothing, and blindly trusting it
 * would over-highlight.
 */
const MAX_SWITCH_EXTENSION_MS = 3000;

/**
 * How often the other meeting's still-open lost window is extended to its
 * current playhead while a response is in progress.
 *
 * That window used to be created only in clear(), which made it invisible
 * exactly when it is most useful — during the response — and made it depend
 * entirely on the user remembering to press 応答終了. Polling instead means
 * the missed lines light up as the footage rolls past, and clear() only
 * stops the growth.
 */
const UNATTENDED_POLL_MS = 500;

/**
 * The time the user spent responding: trigger → clear. Research log only.
 *
 * Explicitly NOT a subtitle-highlighting input. It measures how long the
 * response took, which says nothing about which footage went unplayed.
 * Use LostWindow for anything the user is meant to catch up on.
 */
export type ResponseWindow = {
  room: MeetingId;
  startMs: number;
  endMs: number | null;
};

/**
 * Why a stretch of footage went unseen. Both kinds are equally lost to the
 * user and are highlighted identically; the distinction is kept because the
 * two have different shapes and are worth separating in research logs.
 */
export type LostWindowCause =
  /** The summoned meeting: delayed playback was abandoned mid-stream and the
   * user was teleported to the live edge, so everything in between is gone. */
  | 'realtime-jump'
  /** The *other* meeting: its delayed playback kept rolling — and kept
   * catching up at 2x — for the whole response. Nothing paused and waited
   * for the user, so that stretch played to an empty seat and the playhead
   * is now past it for good. */
  | 'unattended-playback';

/**
 * A stretch of one meeting's footage the user never got to watch. Both
 * bounds are epoch ms on the same wall clock the subtitles carry (see
 * PlaybackController.getPlaybackEpochMs), and both are positions in that
 * meeting's *source* timeline — not wall-clock spans of the response.
 *
 * A single summon produces up to two of these, one per meeting:
 *
 *   summoned room   [playback position at trigger → live position reached]
 *   other room      [playback position at trigger → playback position now]
 *
 * The second one exists because nothing in PlaybackController pauses the
 * meeting the user turned away from: useCommaScheduler keeps handing it
 * focus and the 2x catch-up keeps advancing its playhead, so by the time the
 * response ends that footage has been played and passed, and will never be
 * replayed. It grows while the response runs and stops growing at `clear()`;
 * that is the only thing `clear()` affects. The summoned room's window is
 * settled the instant the realtime jump happens and is never touched again.
 *
 * Note both ends of the unattended window are *playhead* positions, not the
 * wall clock: that meeting is still running behind live, and everything past
 * its playhead is still queued up to be watched normally.
 *
 * Kept in history forever, so scrolling back through subtitles still shows
 * old windows highlighted.
 */
export type LostWindow = {
  id: string;
  room: MeetingId;
  startEpochMs: number;
  endEpochMs: number;
  cause: LostWindowCause;
};

export type UseSummonSignalParams = {
  roomA: Room | null;
  roomB: Room | null;
  /**
   * Resolves "what wall-clock time is the footage currently on screen for
   * this meeting?" — normally PlaybackController's getPlaybackEpochMs.
   * Read through a ref, so it may be a fresh closure on every render.
   * Returning null (recorder not started) means no lost window is recorded.
   */
  getPlaybackEpochMs?: (room: MeetingId) => number | null;
};

export type UseSummonSignalResult = {
  /** The meeting currently shown as a live realtime overlay, or null if none. */
  summonedRoom: MeetingId | null;
  /** Immutable history of footage the user never saw. Drives subtitle
   * highlighting; see LostWindow. */
  lostWindows: LostWindow[];
  /** Research log of response durations. Never used for highlighting. */
  responseWindows: ResponseWindow[];
  /** End the current realtime response and return to normal cycling. Closes
   * the response window and settles the *other* meeting's unattended-
   * playback window; never touches the summoned meeting's window. */
  clear: () => void;
  /** Start a realtime response for `room`, as if a summon had been detected.
   * Used by the debug "テスト: 呼びかけ" buttons and by the agent-driven
   * dataReceived handler below. */
  trigger: (room: MeetingId) => void;
  /** Called by the realtime overlay once it is actually showing live video,
   * to settle the summoned room's window on the moment the jump really
   * landed rather than the moment it was requested. Only ever extends, only
   * once per summon, and only within MAX_SWITCH_EXTENSION_MS. */
  markRealtimeReached: (room: MeetingId) => void;
};

let lostWindowSeq = 0;
const nextLostWindowId = (room: MeetingId) => `lw-${room}-${++lostWindowSeq}`;

/**
 * Mirrors useSubtitleSync's dataReceived subscription pattern, but reacts to
 * a distinct "summon" topic (published by the agent when it detects the
 * summon keyword in a room's transcript) instead of transcript text.
 *
 * Deliberately does not touch useCommaScheduler/PlaybackController's
 * scheduling: this hook only tracks *which* room should currently show a
 * realtime overlay on top of the (always-running, untouched) alternating
 * playback underneath — plus the footage that arrangement costs the user,
 * in both meetings.
 */
export function useSummonSignal(params: UseSummonSignalParams): UseSummonSignalResult {
  const { roomA, roomB, getPlaybackEpochMs } = params;
  const [summonedRoom, setSummonedRoom] = useState<MeetingId | null>(null);
  const [lostWindows, setLostWindows] = useState<LostWindow[]>([]);
  const [responseWindows, setResponseWindows] = useState<ResponseWindow[]>([]);
  const summonedRoomRef = useRef<MeetingId | null>(null);
  summonedRoomRef.current = summonedRoom;

  // Held in a ref so `trigger` keeps a stable identity: it is a dependency
  // of the dataReceived subscription effect below, and a new identity every
  // render would tear down and re-add both room listeners constantly.
  const getPlaybackEpochMsRef = useRef(getPlaybackEpochMs);
  useEffect(() => {
    getPlaybackEpochMsRef.current = getPlaybackEpochMs;
  }, [getPlaybackEpochMs]);

  /** The summoned room's window, still awaiting its real end from the overlay. */
  const pendingJumpRef = useRef<{ id: string; room: MeetingId; triggeredAtMs: number } | null>(null);
  /** The other room's window: open, and growing, until the response ends.
   * `windowId` is null until its span first crosses MIN_LOST_WINDOW_MS. */
  const pendingUnattendedRef = useRef<{
    room: MeetingId;
    startEpochMs: number;
    windowId: string | null;
  } | null>(null);

  /**
   * Extend (or first create) the other meeting's lost window out to wherever
   * its playhead has reached.
   *
   * Note the end is the *playhead*, not the wall clock: that meeting is still
   * running behind live, and everything past its playhead has not been played
   * yet and will be watched normally, so it is not lost.
   */
  const settleUnattended = useCallback((final: boolean) => {
    const pending = pendingUnattendedRef.current;
    if (!pending) return;
    if (final) pendingUnattendedRef.current = null;

    const playheadEpochMs = getPlaybackEpochMsRef.current?.(pending.room) ?? null;
    if (playheadEpochMs === null) {
      if (final) {
        console.warn(
          `[useSummonSignal] no playback anchor for ${pending.room} — no unattended lost window`,
        );
      }
      return;
    }

    const spanMs = playheadEpochMs - pending.startEpochMs;
    if (pending.windowId === null) {
      if (spanMs < MIN_LOST_WINDOW_MS) {
        if (final) {
          // Normal and correct for a very short response: the other meeting
          // was paused the whole time, so its playhead never moved and the
          // footage is still queued up to be watched.
          console.log(
            `[useSummonSignal] ${pending.room} playhead moved ${spanMs.toFixed(0)}ms during the ` +
              `response — nothing rolled past unwatched, no lost window`,
          );
        }
        return;
      }
      const id = nextLostWindowId(pending.room);
      pending.windowId = id;
      setLostWindows((prev) => [
        ...prev,
        {
          id,
          room: pending.room,
          startEpochMs: pending.startEpochMs,
          endEpochMs: playheadEpochMs,
          cause: 'unattended-playback',
        },
      ]);
      console.log(
        `[useSummonSignal] lost(unattended-playback) ${pending.room} opened ` +
          `${new Date(pending.startEpochMs).toISOString()} → ` +
          `${new Date(playheadEpochMs).toISOString()} (${(spanMs / 1000).toFixed(2)}s)`,
      );
      return;
    }

    const id = pending.windowId;
    setLostWindows((prev) => {
      let changed = false;
      const next = prev.map((w) => {
        if (w.id !== id || playheadEpochMs <= w.endEpochMs) return w;
        changed = true;
        return { ...w, endEpochMs: playheadEpochMs };
      });
      return changed ? next : prev;
    });
    if (final) {
      console.log(
        `[useSummonSignal] lost(unattended-playback) ${pending.room} settled at ` +
          `${new Date(playheadEpochMs).toISOString()} (${(spanMs / 1000).toFixed(2)}s)`,
      );
    }
  }, []);

  const trigger = useCallback((room: MeetingId) => {
    if (summonedRoomRef.current !== null) {
      // Re-entrant summon (same room still responding, or the other room
      // butting in): ignored as before — and, importantly, no second lost
      // window is recorded for either meeting.
      console.warn(
        `[useSummonSignal] ignoring summon for ${room}: ${summonedRoomRef.current} is already active`,
      );
      return;
    }
    summonedRoomRef.current = room;

    // Order matters, and it is the order of the actual events: read where
    // both playheads stand *before* anything switches, then switch, then let
    // the overlay report where the live view actually landed.
    const other: MeetingId = room === 'A' ? 'B' : 'A';
    const lostStart = getPlaybackEpochMsRef.current?.(room) ?? null;
    const otherStart = getPlaybackEpochMsRef.current?.(other) ?? null;
    const jumpAtMs = Date.now();

    setSummonedRoom(room);
    setResponseWindows((prev) => [...prev, { room, startMs: jumpAtMs, endMs: null }]);

    // Left open and grown by the poll below, so the other meeting's missed
    // lines light up while the response is still going rather than only once
    // the user remembers to press 応答終了.
    pendingUnattendedRef.current =
      otherStart !== null ? { room: other, startEpochMs: otherStart, windowId: null } : null;
    if (otherStart === null) {
      console.warn(
        `[useSummonSignal] no playback anchor for ${other} at trigger — no unattended lost window`,
      );
    }

    if (lostStart === null) {
      console.warn(
        `[useSummonSignal] no playback anchor for ${room} (recorder not started?) — no lost window`,
      );
      pendingJumpRef.current = null;
      return;
    }

    const gapMs = jumpAtMs - lostStart;
    if (gapMs < MIN_LOST_WINDOW_MS) {
      // Playback was already sitting on the live edge — the jump skipped
      // nothing the user hadn't just watched.
      console.log(
        `[useSummonSignal] ${room} was already realtime (gap=${gapMs.toFixed(0)}ms) — no lost window`,
      );
      pendingJumpRef.current = null;
      return;
    }

    const id = nextLostWindowId(room);
    // Settled immediately (rather than left open until the overlay reports
    // in) so the summoning utterance is highlighted on this very render —
    // reading it is the whole point of the feature.
    const window: LostWindow = {
      id,
      room,
      startEpochMs: lostStart,
      endEpochMs: jumpAtMs,
      cause: 'realtime-jump',
    };
    pendingJumpRef.current = { id, room, triggeredAtMs: jumpAtMs };
    setLostWindows((prev) => [...prev, window]);
    console.log(
      `[useSummonSignal] lost(realtime-jump) ${room} ${new Date(lostStart).toISOString()} → ` +
        `${new Date(jumpAtMs).toISOString()} (${(gapMs / 1000).toFixed(2)}s)`,
    );
  }, []);

  const markRealtimeReached = useCallback((room: MeetingId) => {
    const pending = pendingJumpRef.current;
    if (!pending || pending.room !== room) return;
    pendingJumpRef.current = null;

    const reachedAtMs = Date.now();
    const extensionMs = reachedAtMs - pending.triggeredAtMs;
    if (extensionMs <= 0) return;
    if (extensionMs > MAX_SWITCH_EXTENSION_MS) {
      console.warn(
        `[useSummonSignal] realtime overlay for ${room} took ${extensionMs}ms — ` +
          `capping lost window at trigger time instead of extending`,
      );
      return;
    }
    // The switch itself took time, and that footage was skipped too: the
    // user was already off the delayed playback but not yet on live video.
    // This is the one and only mutation a lost window ever undergoes.
    setLostWindows((prev) =>
      prev.map((w) => (w.id === pending.id ? { ...w, endEpochMs: reachedAtMs } : w)),
    );
  }, []);

  const clear = useCallback(() => {
    if (summonedRoomRef.current === null) return;
    summonedRoomRef.current = null;
    pendingJumpRef.current = null;
    setSummonedRoom(null);

    // Stop the other meeting's window growing, at its playhead right now.
    // The summoned meeting's own window is deliberately untouched here —
    // everything after its realtime jump was seen and heard live, however
    // long the response ran.
    settleUnattended(true);

    setResponseWindows((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].endMs === null) {
          next[i] = { ...next[i], endMs: Date.now() };
          break;
        }
      }
      return next;
    });
  }, [settleUnattended]);

  // Grow the other meeting's lost window for as long as the response runs.
  useEffect(() => {
    if (summonedRoom === null) return;
    const interval = window.setInterval(() => settleUnattended(false), UNATTENDED_POLL_MS);
    return () => window.clearInterval(interval);
  }, [summonedRoom, settleUnattended]);

  useEffect(() => {
    const subscriptions: Array<{ room: Room; handler: (...args: unknown[]) => void }> = [];

    const makeHandler = (meeting: MeetingId) => {
      return (_payload: Uint8Array, _participant: unknown, _kind: unknown, topic?: string) => {
        if (topic !== SUMMON_TOPIC) return;
        trigger(meeting);
      };
    };

    if (roomA) {
      const handler = makeHandler('A');
      roomA.on('dataReceived', handler);
      subscriptions.push({ room: roomA, handler: handler as (...args: unknown[]) => void });
    }
    if (roomB) {
      const handler = makeHandler('B');
      roomB.on('dataReceived', handler);
      subscriptions.push({ room: roomB, handler: handler as (...args: unknown[]) => void });
    }

    return () => {
      for (const sub of subscriptions) {
        sub.room.off('dataReceived', sub.handler as never);
      }
    };
  }, [roomA, roomB, trigger]);

  return { summonedRoom, lostWindows, responseWindows, clear, trigger, markRealtimeReached };
}

/**
 * True when a subtitle's utterance overlaps `window` by at least an instant.
 * Both sides are closed intervals on the same epoch clock, so this is the
 * plain interval-overlap test — deliberately whole-line: a subtitle
 * straddling a boundary is highlighted in full. Over-highlighting by a few
 * words is the safe direction; missing part of the question is not.
 */
export function overlapsOneLostWindow(
  subtitle: { room: MeetingId; speechStartEpochMs: number; speechEndEpochMs: number },
  window: LostWindow,
): boolean {
  return (
    window.room === subtitle.room &&
    subtitle.speechStartEpochMs <= window.endEpochMs &&
    subtitle.speechEndEpochMs >= window.startEpochMs
  );
}

/**
 * True when a subtitle falls in any lost window.
 *
 * Recomputed from the (immutable) window history on every render rather
 * than stamped onto entries when a window is created — that is what makes
 * subtitles arriving seconds *after* the fact light up on their own, and
 * what keeps old windows highlighted when scrolling back.
 */
export function overlapsLostWindow(
  subtitle: { room: MeetingId; speechStartEpochMs: number; speechEndEpochMs: number },
  windows: LostWindow[],
): boolean {
  return windows.some((w) => overlapsOneLostWindow(subtitle, w));
}
