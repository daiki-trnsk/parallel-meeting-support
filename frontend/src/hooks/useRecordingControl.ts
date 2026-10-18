import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room } from 'livekit-client';
import type { MeetingId } from './useMeetingRecorder';

const CONTROL_TOPIC = 'record-control';
const STATUS_TOPIC = 'record-status';
/** The start message is re-sent on this interval for the whole session: it
 * covers an agent that joined late or restarted mid-meeting, and every resend
 * is answered, so a missing answer means the agent is not recording. */
const RESEND_MS = 5000;
/** No answer for this long → shown as not recording. */
const STALE_MS = 12000;
/** Right after 開始, wait this long for the first answer before flagging it. */
const FIRST_ACK_GRACE_MS = 3000;

export type RecordingState = 'idle' | 'recording' | 'missing';

function makeSessionId(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Experiment audio recording runs entirely in the agents (one WAV per room).
 * This hook only tells them when the session starts and shows whether each
 * one has acknowledged. It never touches playback, subtitles or summons, and
 * every failure here is logged and swallowed.
 *
 * Used by both 実験群 (CommaDebug) and 統制群 (ControlDebug); the agent tells
 * the two apart by sender identity. Recording stops on the agent side when
 * the 同時参加者 who started it leaves the room.
 */
export function useRecordingControl(params: { roomA: Room | null; roomB: Room | null }) {
  const { roomA, roomB } = params;
  const [sessionId, setSessionId] = useState<string | null>(null);
  const lastAckRef = useRef<Record<MeetingId, number>>({ A: 0, B: 0 });
  const [state, setState] = useState<Record<MeetingId, RecordingState>>({ A: 'idle', B: 'idle' });

  const start = useCallback(() => {
    setSessionId((prev) => prev ?? makeSessionId(new Date()));
  }, []);

  useEffect(() => {
    const subscriptions: Array<{ room: Room; handler: (...args: unknown[]) => void }> = [];
    const makeHandler = (meeting: MeetingId) => {
      return (payload: Uint8Array, _participant: unknown, _kind: unknown, topic?: string) => {
        if (topic !== STATUS_TOPIC) return;
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          lastAckRef.current[meeting] = msg.recording ? Date.now() : 0;
        } catch {
          // malformed payload — ignore
        }
      };
    };
    ([
      ['A', roomA],
      ['B', roomB],
    ] as const).forEach(([meeting, room]) => {
      if (!room) return;
      const handler = makeHandler(meeting);
      room.on('dataReceived', handler);
      subscriptions.push({ room, handler: handler as (...args: unknown[]) => void });
    });
    return () => {
      for (const sub of subscriptions) {
        sub.room.off('dataReceived', sub.handler as never);
      }
    };
  }, [roomA, roomB]);

  useEffect(() => {
    if (!sessionId) return;
    const send = () => {
      const payload = new TextEncoder().encode(
        JSON.stringify({ action: 'start', session_id: sessionId, sent_at: Date.now() }),
      );
      [roomA, roomB].forEach((room) => {
        room?.localParticipant
          .publishData(payload, { reliable: true, topic: CONTROL_TOPIC })
          .catch((e) => console.error('[recording] start publish failed', e));
      });
    };
    const startedAt = Date.now();
    const refresh = () => {
      const now = Date.now();
      const of = (m: MeetingId): RecordingState =>
        now - lastAckRef.current[m] < STALE_MS
          ? 'recording'
          : now - startedAt < FIRST_ACK_GRACE_MS
            ? 'idle'
            : 'missing';
      setState((prev) => {
        const next = { A: of('A'), B: of('B') };
        return prev.A === next.A && prev.B === next.B ? prev : next;
      });
    };
    send();
    const sendId = window.setInterval(send, RESEND_MS);
    const refreshId = window.setInterval(refresh, 1000);
    return () => {
      window.clearInterval(sendId);
      window.clearInterval(refreshId);
    };
  }, [sessionId, roomA, roomB]);

  return { start, state, sessionId };
}
