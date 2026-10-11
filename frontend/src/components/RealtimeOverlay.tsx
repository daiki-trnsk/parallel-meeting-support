import React, { useEffect, useRef } from 'react';
import type { SakuraTrack } from './CommaTrackBridge';
import { MAX_SAKURA_PER_ROOM } from './CommaTrackBridge';
import { speakerDisplay } from '../lib/speakerDisplay';

type Props = {
  tracks: SakuraTrack[];
  /**
   * Fired once, when the first live tile actually starts rendering frames —
   * i.e. the moment the user really arrives at realtime. useSummonSignal
   * uses it to settle the lost window's end on the true landing point
   * rather than on the moment the switch was requested; the gap is usually
   * tens of ms, but it is footage the user missed all the same.
   *
   * Not fired when there are no tracks to play — in that case nothing was
   * reached, and the lost window keeps its (shorter, safer) trigger-time end.
   */
  onLive?: () => void;
};

/**
 * Live, unbuffered view of a room's サクラ participants, shown on top of
 * that room's (untouched, still-running underneath) alternating-playback
 * panel while the user is responding to a summon.
 *
 * Deliberately bypasses useCompositeMeetingStream: that canvas composite is
 * downsampled to 240p/10fps for the buffer/2x-replay pipeline, which is far
 * too low quality and laggy for an actual live conversation. Here each
 * サクラ's raw camera/mic MediaStreamTrack is attached directly to its own
 * <video> element instead, at full native quality/latency — same as a
 * normal one-on-one web meeting tile.
 */
const RealtimeOverlay: React.FC<Props> = ({ tracks, onLive }) => {
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const liveReportedRef = useRef(false);

  const handlePlaying = () => {
    if (liveReportedRef.current) return;
    liveReportedRef.current = true;
    onLive?.();
  };

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

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        background: '#000',
        border: '3px solid #ff9800',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 6,
          left: 8,
          fontSize: 12,
          fontFamily: 'monospace',
          color: '#fff',
          background: '#ff9800',
          padding: '1px 8px',
          borderRadius: 3,
          zIndex: 1,
        }}
      >
        ● LIVE 応答中
      </div>
      {tracks.length === 0 && (
        <div style={{ margin: 'auto', color: '#888', fontFamily: 'monospace', fontSize: 13 }}>
          参加者の映像を待機中...
        </div>
      )}
      {/* Fixed MAX_SAKURA_PER_ROOM-slot grid, same as the 倍速 composite
          canvas, so each サクラ's tile and name label sit exactly where they
          did before the switch to live. */}
      {Array.from({ length: MAX_SAKURA_PER_ROOM }, (_, i) => {
        const t: SakuraTrack | undefined = tracks[i];
        const display = t ? speakerDisplay(t.identity) : null;
        return (
          <div key={i} style={{ position: 'relative', flex: '1 1 0', minWidth: 0, minHeight: 0 }}>
            <video
              ref={(el) => {
                videoRefs.current[i] = el;
              }}
              onPlaying={handlePlaying}
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
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
};

export default RealtimeOverlay;
