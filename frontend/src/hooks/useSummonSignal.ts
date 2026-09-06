import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room } from 'livekit-client';
import type { MeetingId } from './useMeetingRecorder';

const SUMMON_TOPIC = 'summon';

export type SummonWindow = {
  room: MeetingId;
  startMs: number;
  endMs: number | null;
};

export type UseSummonSignalParams = {
  roomA: Room | null;
  roomB: Room | null;
};

export type UseSummonSignalResult = {
  /** The meeting currently shown as a live realtime overlay, or null if none. */
  summonedRoom: MeetingId | null;
  /** History of realtime-response time windows, for tagging subtitles that
   * fall inside one (the open window has endMs === null). */
  summonWindows: SummonWindow[];
  /** Manually end the current realtime response and return to normal cycling. */
  clear: () => void;
  /** Start a realtime response for `room`, as if a summon had been detected.
   * Used by the debug "テスト: 呼びかけ" buttons and by the agent-driven
   * dataReceived handler below. */
  trigger: (room: MeetingId) => void;
};

/**
 * Mirrors useSubtitleSync's dataReceived subscription pattern, but reacts to
 * a distinct "summon" topic (published by the agent when it detects the
 * summon keyword in a room's transcript) instead of transcript text.
 *
 * Deliberately does not touch useCommaScheduler/PlaybackController: this
 * hook only tracks *which* room should currently show a realtime overlay on
 * top of the (always-running, untouched) alternating playback underneath.
 */
export function useSummonSignal(params: UseSummonSignalParams): UseSummonSignalResult {
  const { roomA, roomB } = params;
  const [summonedRoom, setSummonedRoom] = useState<MeetingId | null>(null);
  const [summonWindows, setSummonWindows] = useState<SummonWindow[]>([]);
  const summonedRoomRef = useRef<MeetingId | null>(null);
  summonedRoomRef.current = summonedRoom;

  const trigger = useCallback((room: MeetingId) => {
    if (summonedRoomRef.current !== null) {
      console.warn(
        `[useSummonSignal] ignoring summon for ${room}: ${summonedRoomRef.current} is already active`,
      );
      return;
    }
    summonedRoomRef.current = room;
    setSummonedRoom(room);
    setSummonWindows((prev) => [...prev, { room, startMs: Date.now(), endMs: null }]);
  }, []);

  const clear = useCallback(() => {
    if (summonedRoomRef.current === null) return;
    summonedRoomRef.current = null;
    setSummonedRoom(null);
    setSummonWindows((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].endMs === null) {
          next[i] = { ...next[i], endMs: Date.now() };
          break;
        }
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const subscriptions: Array<{ room: Room; handler: (...args: unknown[]) => void }> = [];

    const makeHandler = (meeting: MeetingId) => {
      return (payload: Uint8Array, _participant: unknown, _kind: unknown, topic?: string) => {
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

  return { summonedRoom, summonWindows, clear, trigger };
}
