import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { SakuraTrack } from './CommaTrackBridge';

type Props = {
  tracks: SakuraTrack[];
};

export type LiveSakuraPanelHandle = {
  /** Plays every tile's <video> element from a direct user-gesture call
   * site, so the browser's unmuted-autoplay-with-sound policy is satisfied.
   * Call this synchronously from a click handler, not from an effect. */
  play: () => void;
};

/**
 * Plain, continuous, unbuffered view of a room's サクラ participants — the
 * 統制群 (control group) equivalent of CommaDebug's PlaybackController, minus
 * any alternating-focus / 2x-replay / buffering behaviour. Each サクラ's raw
 * camera/mic MediaStreamTrack is attached directly to its own <video>
 * element, same layout (up to MAX_SAKURA_PER_ROOM tiles side by side) as the
 * 実験群 screen's per-room panel, but always live and always both rooms
 * visible at once — there is no focus/summon concept here.
 */
const LiveSakuraPanel = forwardRef<LiveSakuraPanelHandle, Props>(({ tracks }, ref) => {
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);

  useEffect(() => {
    tracks.forEach((t, i) => {
      const el = videoRefs.current[i];
      if (!el) return;
      const current = (el.srcObject as MediaStream | null) ?? null;
      const wantVideo = t.video;
      const wantAudio = t.audio;
      const currentVideo = current?.getVideoTracks()[0] ?? null;
      const currentAudio = current?.getAudioTracks()[0] ?? null;
      if (currentVideo === wantVideo && currentAudio === wantAudio) return;

      const streamTracks: MediaStreamTrack[] = [];
      if (wantVideo) streamTracks.push(wantVideo);
      if (wantAudio) streamTracks.push(wantAudio);
      el.srcObject = streamTracks.length > 0 ? new MediaStream(streamTracks) : null;
      el.play().catch(() => {});
    });
  }, [tracks]);

  useImperativeHandle(
    ref,
    () => ({
      play: () => {
        videoRefs.current.forEach((el) => el?.play().catch(() => {}));
      },
    }),
    [],
  );

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        width: '100%',
        height: '100%',
        background: '#000',
        overflow: 'hidden',
      }}
    >
      {tracks.length === 0 && (
        <div style={{ margin: 'auto', color: '#888', fontFamily: 'monospace', fontSize: 13 }}>
          参加者の映像を待機中...
        </div>
      )}
      {tracks.map((t, i) => (
        <video
          key={t.identity}
          ref={(el) => {
            videoRefs.current[i] = el;
          }}
          playsInline
          style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, width: '100%', height: '100%', objectFit: 'contain' }}
        />
      ))}
    </div>
  );
});

LiveSakuraPanel.displayName = 'LiveSakuraPanel';

export default LiveSakuraPanel;
