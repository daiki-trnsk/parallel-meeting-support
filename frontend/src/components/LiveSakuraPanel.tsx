import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { SakuraTrack } from './CommaTrackBridge';
import { MAX_SAKURA_PER_ROOM } from './CommaTrackBridge';
import { speakerDisplay } from '../lib/speakerDisplay';

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
 * element.
 *
 * Always renders a fixed MAX_SAKURA_PER_ROOM-slot grid, same as the 実験群
 * composite canvas (always two 320x240 cells, see useCompositeMeetingStream)
 * — an empty slot stays blank rather than letting the other slot's tile
 * stretch to fill the gap, so the panel's visual size/layout never shifts
 * depending on whether 1 or 2 サクラ are currently present.
 */
const LiveSakuraPanel = forwardRef<LiveSakuraPanelHandle, Props>(({ tracks }, ref) => {
  const videoRefs = useRef<(HTMLVideoElement | null)[]>(Array(MAX_SAKURA_PER_ROOM).fill(null));

  useEffect(() => {
    for (let i = 0; i < MAX_SAKURA_PER_ROOM; i++) {
      const t = tracks[i];
      const el = videoRefs.current[i];
      if (!el) continue;
      const current = (el.srcObject as MediaStream | null) ?? null;
      const wantVideo = t?.video ?? null;
      const wantAudio = t?.audio ?? null;
      const currentVideo = current?.getVideoTracks()[0] ?? null;
      const currentAudio = current?.getAudioTracks()[0] ?? null;
      if (currentVideo === wantVideo && currentAudio === wantAudio) continue;

      const streamTracks: MediaStreamTrack[] = [];
      if (wantVideo) streamTracks.push(wantVideo);
      if (wantAudio) streamTracks.push(wantAudio);
      el.srcObject = streamTracks.length > 0 ? new MediaStream(streamTracks) : null;
      el.play().catch(() => {});
    }
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
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            margin: 'auto',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#888',
            fontFamily: 'monospace',
            fontSize: 13,
            pointerEvents: 'none',
          }}
        >
          参加者の映像を待機中...
        </div>
      )}
      {Array.from({ length: MAX_SAKURA_PER_ROOM }, (_, i) => {
        const t: SakuraTrack | undefined = tracks[i];
        const display = t ? speakerDisplay(t.identity) : null;
        return (
          <div key={i} style={{ position: 'relative', flex: '1 1 0', minWidth: 0 }}>
            <video
              ref={(el) => {
                videoRefs.current[i] = el;
              }}
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
            {/* Bottom-left name label, same look as the 実験群 composite
                canvas's baked-in label (speakerDisplay colors/positioning). */}
            {display && (
              <div
                style={{
                  position: 'absolute',
                  left: 6,
                  bottom: 6,
                  height: 20,
                  lineHeight: '20px',
                  padding: '0 6px',
                  fontSize: 14,
                  fontFamily: 'sans-serif',
                  color: display.color,
                  background: 'rgba(0,0,0,0.55)',
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {display.label}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

LiveSakuraPanel.displayName = 'LiveSakuraPanel';

export default LiveSakuraPanel;
