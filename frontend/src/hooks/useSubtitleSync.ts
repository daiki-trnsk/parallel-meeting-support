import { useEffect, useRef, useState } from 'react';
import type { Room } from 'livekit-client';
import type { MeetingId } from './useMeetingRecorder';

const TRANSCRIPT_TOPIC = 'transcript';
const MAX_VISIBLE = 100;

/**
 * Two agent processes in the same room transcribe the same audio and each
 * publish their own payload, so every line arrives twice — visibly doubled
 * in the column, and doubled in the data any highlighting is judged against.
 * The fix is to stop the extra agent (see the warning logged below, which
 * names both senders), but the UI should not silently show garbage until
 * someone notices, so identical lines from the same speaker landing within
 * this window are collapsed to one.
 *
 * Duplicates from separate agents do not carry identical timestamps — each
 * has its own STT stream clock — hence a tolerance rather than an equality
 * check. It is wide enough to catch that skew and short enough that a
 * genuine repeated utterance ("はい" twice in two seconds) is the only thing
 * it could wrongly swallow.
 */
const DUPLICATE_TOLERANCE_MS = 2000;
/** How far back to look for a duplicate — a few speakers' worth of lines. */
const DUPLICATE_SCAN_DEPTH = 8;

export type SubtitleEntry = {
  id: string;
  room: MeetingId;
  participant: string;
  text: string;
  /** When the agent finalized this transcript (Deepgram FINAL_TRANSCRIPT →
   * publish_data). This is *not* when the words were spoken — it lags the
   * actual utterance by roughly the endpointing delay — so it is kept for
   * debugging/logging only and must never be used to line subtitles up
   * against recorded video. Use speechStart/EndEpochMs for that. */
  timestampEpochMs: number;
  /** Epoch ms of the actual utterance, derived agent-side from Deepgram's
   * word-level start/end offsets plus the STT stream's wall-clock anchor.
   * Falls back to timestampEpochMs when the agent could not supply them
   * (older agent build, or a result with no word timings). */
  speechStartEpochMs: number;
  speechEndEpochMs: number;
  /** 'deepgram' when the two fields above are real utterance times,
   * 'fallback-finalized' / 'legacy-finalized' when they are only the
   * finalized time standing in for them. */
  speechTimeSource: string;
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
  const senderIdentitiesRef = useRef<Map<MeetingId, Set<string>>>(new Map());

  useEffect(() => {
    const subscriptions: Array<{ room: Room; handler: (...args: unknown[]) => void }> = [];

    const makeHandler = (meeting: MeetingId) => {
      return (
        payload: Uint8Array,
        sender: { identity?: string } | undefined,
        _kind: unknown,
        topic?: string,
      ) => {
        if (topic !== TRANSCRIPT_TOPIC) return;

        // Exactly one agent should ever publish transcripts for a room.
        // A second identity here means a stale `python agent.py dev` is
        // still running, or agent_dispatch.py was run more than once.
        const senderIdentity = sender?.identity;
        if (senderIdentity) {
          let seen = senderIdentitiesRef.current.get(meeting);
          if (!seen) {
            seen = new Set();
            senderIdentitiesRef.current.set(meeting, seen);
          }
          if (!seen.has(senderIdentity)) {
            seen.add(senderIdentity);
            if (seen.size > 1) {
              console.error(
                `[useSubtitleSync] room ${meeting} is receiving transcripts from ${seen.size} ` +
                  `agents (${[...seen].join(', ')}) — subtitles will be duplicated. ` +
                  `Stop the extra agent process.`,
              );
            }
          }
        }

        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          const finalizedMs = Number(msg.timestamp) || Date.now();
          const speechStart = Number(msg.speech_start_ms);
          const speechEnd = Number(msg.speech_end_ms);
          const hasSpeechTimes = Number.isFinite(speechStart) && Number.isFinite(speechEnd);
          const entry: SubtitleEntry = {
            id: `${meeting}-${Date.now()}-${Math.random()}`,
            room: meeting,
            participant: String(msg.participant ?? ''),
            text: String(msg.text ?? ''),
            timestampEpochMs: finalizedMs,
            speechStartEpochMs: hasSpeechTimes ? speechStart : finalizedMs,
            speechEndEpochMs: hasSpeechTimes ? Math.max(speechEnd, speechStart) : finalizedMs,
            speechTimeSource: hasSpeechTimes
              ? String(msg.speech_time_source ?? 'deepgram')
              : 'legacy-finalized',
          };
          setVisible((prev) => {
            const isDuplicate = prev
              .slice(Math.max(0, prev.length - DUPLICATE_SCAN_DEPTH))
              .some(
                (p) =>
                  p.room === entry.room &&
                  p.participant === entry.participant &&
                  p.text === entry.text &&
                  Math.abs(p.speechStartEpochMs - entry.speechStartEpochMs) <
                    DUPLICATE_TOLERANCE_MS,
              );
            if (isDuplicate) return prev;
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
