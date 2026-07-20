import { useEffect, useState } from 'react';
import type { Room } from 'livekit-client';
import type { MeetingId } from './useMeetingRecorder';

const TRANSCRIPT_TOPIC = 'transcript';
const MAX_VISIBLE = 100;

export type SubtitleEntry = {
  id: string;
  room: MeetingId;
  participant: string;
  text: string;
  timestampEpochMs: number;
};

export type UseSubtitleSyncParams = {
  roomA: Room | null;
  roomB: Room | null;
};

/**
 * Transcription is intentionally decoupled from comma playback: it's shown
 * live, in real time, as soon as each DataChannel message arrives —
 * regardless of which meeting (if either) is currently focused/playing at
 * 2x. Transcription and the buffered-catchup video are two independent
 * concerns; there is no video-time gating here.
 */
export function useSubtitleSync(params: UseSubtitleSyncParams): { visible: SubtitleEntry[] } {
  const { roomA, roomB } = params;
  const [visible, setVisible] = useState<SubtitleEntry[]>([]);

  useEffect(() => {
    const subscriptions: Array<{ room: Room; handler: (...args: unknown[]) => void }> = [];

    const makeHandler = (meeting: MeetingId) => {
      return (payload: Uint8Array, _participant: unknown, _kind: unknown, topic?: string) => {
        if (topic !== TRANSCRIPT_TOPIC) return;
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          const entry: SubtitleEntry = {
            id: `${meeting}-${Date.now()}-${Math.random()}`,
            room: meeting,
            participant: String(msg.participant ?? ''),
            text: String(msg.text ?? ''),
            timestampEpochMs: Number(msg.timestamp) || Date.now(),
          };
          setVisible((prev) => {
            const next = [...prev, entry];
            return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
          });
        } catch {
          // malformed payload — ignore
        }
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
  }, [roomA, roomB]);

  return { visible };
}
