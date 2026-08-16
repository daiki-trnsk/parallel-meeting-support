import { useEffect, useRef, useState } from 'react';
import type { SakuraTrack } from '../components/CommaTrackBridge';
import { MAX_SAKURA_PER_ROOM } from '../components/CommaTrackBridge';
import type { MeetingId } from './useMeetingRecorder';

const CELL_WIDTH = 320;
const CELL_HEIGHT = 240;
const CANVAS_FPS = 10;

export type CompositeStream = {
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
};

/**
 * Composites up to MAX_SAKURA_PER_ROOM サクラ participants' raw camera+mic
 * tracks for one meeting into a single side-by-side video + mixed audio
 * stream, *before* handing off to useMeetingRecorder.
 *
 * Doing the merge here — rather than recording each サクラ into their own
 * MediaRecorder/SourceBuffer/<video> — is what keeps the サクラ within one
 * room from ever drifting apart on screen: they are baked into the same
 * canvas frames and the same recorded timeline, so there is nothing left for
 * PlaybackController's existing per-room catch-up/2x logic to desync between
 * them (that logic only ever sees a single video per room, unchanged).
 *
 * Output tracks are stable object identities for the lifetime of this hook
 * (only meetingId re-mounts them), even as the underlying サクラ tracks
 * come and go — so useMeetingRecorder's MediaRecorder is set up once and
 * keeps running across サクラ churn, instead of restarting every time a
 * participant's track is (re)picked upstream.
 */
export function useCompositeMeetingStream(
  tracks: SakuraTrack[],
  meetingId: MeetingId,
): CompositeStream {
  const videoElRefs = useRef<(HTMLVideoElement | null)[]>(Array(MAX_SAKURA_PER_ROOM).fill(null));
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const audioSourceNodesRef = useRef<Map<string, MediaStreamAudioSourceNode>>(new Map());
  const audioStreamsRef = useRef<Map<string, MediaStream>>(new Map());

  const [videoTrack, setVideoTrack] = useState<MediaStreamTrack | null>(null);
  const [audioTrack, setAudioTrack] = useState<MediaStreamTrack | null>(null);

  // Set up the compositing canvas, hidden decode <video> elements, and the
  // audio mixer once per mount (meetingId is stable for a room's lifetime).
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = CELL_WIDTH * MAX_SAKURA_PER_ROOM;
    canvas.height = CELL_HEIGHT;
    const ctx = canvas.getContext('2d');

    const videoEls: HTMLVideoElement[] = [];
    for (let i = 0; i < MAX_SAKURA_PER_ROOM; i++) {
      const el = document.createElement('video');
      el.muted = true;
      el.playsInline = true;
      videoEls.push(el);
      videoElRefs.current[i] = el;
    }

    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    audioCtxRef.current = audioCtx;
    audioDestRef.current = dest;

    let cancelled = false;
    const drawInterval = window.setInterval(() => {
      if (cancelled || !ctx) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < MAX_SAKURA_PER_ROOM; i++) {
        const el = videoEls[i];
        if (!el || el.readyState < 2 || !el.videoWidth) continue;
        const cellX = i * CELL_WIDTH;
        // object-fit: contain within this サクラ's cell, matching the
        // objectFit: 'contain' styling used for the (previously) single
        // video element per room in PlaybackController.
        const scale = Math.min(CELL_WIDTH / el.videoWidth, CELL_HEIGHT / el.videoHeight);
        const w = el.videoWidth * scale;
        const h = el.videoHeight * scale;
        const x = cellX + (CELL_WIDTH - w) / 2;
        const y = (CELL_HEIGHT - h) / 2;
        ctx.drawImage(el, x, y, w, h);
      }
    }, 1000 / CANVAS_FPS);

    const stream = canvas.captureStream(CANVAS_FPS);
    setVideoTrack(stream.getVideoTracks()[0] ?? null);
    setAudioTrack(dest.stream.getAudioTracks()[0] ?? null);

    console.log(`[useCompositeMeetingStream:${meetingId}] composite canvas/audio initialized`);

    return () => {
      cancelled = true;
      window.clearInterval(drawInterval);
      stream.getTracks().forEach((t) => t.stop());
      for (const el of videoEls) {
        el.pause();
        el.srcObject = null;
      }
      videoElRefs.current = Array(MAX_SAKURA_PER_ROOM).fill(null);
      for (const node of audioSourceNodesRef.current.values()) node.disconnect();
      audioSourceNodesRef.current.clear();
      audioStreamsRef.current.clear();
      dest.disconnect();
      audioCtx.close().catch(() => {});
      audioCtxRef.current = null;
      audioDestRef.current = null;
      setVideoTrack(null);
      setAudioTrack(null);
    };
  }, [meetingId]);

  // Feed each サクラ's raw video track into its hidden decode <video>
  // element, and each audio track into the shared AudioContext mix. Guarded
  // by an identity check on the currently attached track so that `tracks`
  // changing reference (CommaTrackBridge re-derives its array on frequent
  // mic-level events) doesn't tear down/reattach unchanged tracks.
  useEffect(() => {
    for (let i = 0; i < MAX_SAKURA_PER_ROOM; i++) {
      const el = videoElRefs.current[i];
      const track = tracks[i]?.video ?? null;
      if (!el) continue;
      const current = (el.srcObject as MediaStream | null)?.getVideoTracks()[0] ?? null;
      if (current === track) continue;
      if (track) {
        el.srcObject = new MediaStream([track]);
        el.play().catch(() => {});
      } else {
        el.srcObject = null;
      }
    }

    const audioCtx = audioCtxRef.current;
    const dest = audioDestRef.current;
    if (!audioCtx || !dest) return;

    const liveIdentities = new Set(tracks.map((t) => t.identity));
    for (const [identity, node] of audioSourceNodesRef.current) {
      if (!liveIdentities.has(identity)) {
        node.disconnect();
        audioSourceNodesRef.current.delete(identity);
        audioStreamsRef.current.delete(identity);
      }
    }

    for (const t of tracks) {
      if (!t.audio) continue;
      const existingStream = audioStreamsRef.current.get(t.identity);
      if (existingStream?.getAudioTracks()[0] === t.audio) continue;
      audioSourceNodesRef.current.get(t.identity)?.disconnect();
      const stream = new MediaStream([t.audio]);
      const node = audioCtx.createMediaStreamSource(stream);
      node.connect(dest);
      audioSourceNodesRef.current.set(t.identity, node);
      audioStreamsRef.current.set(t.identity, stream);
    }
  }, [tracks]);

  return { videoTrack, audioTrack };
}
