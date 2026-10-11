import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '@livekit/components-styles';
import { LiveKitRoom } from '@livekit/components-react';
import type { Room } from 'livekit-client';
import CommaTrackBridge, { type SakuraTrack } from '../components/CommaTrackBridge';
import LiveSakuraPanel, { type LiveSakuraPanelHandle } from '../components/LiveSakuraPanel';
import MicIconButton from '../components/MicIconButton';
import { meetingDisplayName } from '../lib/meetingLabels';

type RoomSession = { token: string; url: string; room: string; identity: string; name?: string };

const headingStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: 16,
  fontWeight: 700,
  color: '#eee',
  textAlign: 'center',
  background: '#1a1a1a',
  borderBottom: '1px solid #555',
  boxSizing: 'border-box',
  flexShrink: 0,
};

const roomFrameStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minWidth: 0,
  border: '2px solid #555',
  boxSizing: 'border-box',
};

/**
 * 統制群 (control group) screen: same 同時参加者 entry flow and same per-room
 * サクラ tile layout as CommaDebug (実験群), but with none of its experimental
 * machinery — no alternating 2x playback, no buffering, no subtitles, no
 * summon/realtime-switch. Both rooms' サクラ video just streams live,
 * continuously, side by side. The only controls beyond 開始 are a
 * mic on/off toggle per room.
 */
const ControlDebug: React.FC = () => {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<RoomSession[] | null>(null);
  const [sakuraTracksA, setSakuraTracksA] = useState<SakuraTrack[]>([]);
  const [sakuraTracksB, setSakuraTracksB] = useState<SakuraTrack[]>([]);
  const [roomA, setRoomA] = useState<Room | null>(null);
  const [roomB, setRoomB] = useState<Room | null>(null);
  const [started, setStarted] = useState(false);
  const [micOnA, setMicOnA] = useState(false);
  const [micOnB, setMicOnB] = useState(false);

  const panelARef = useRef<LiveSakuraPanelHandle | null>(null);
  const panelBRef = useRef<LiveSakuraPanelHandle | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem('livekit_session');
    if (!raw) {
      navigate('/');
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const list: RoomSession[] = Array.isArray(parsed) ? parsed : [parsed];
      if (list.length < 2) throw new Error('need two sessions (room-a, room-b) for control debug');
      setSessions(list);
    } catch (e) {
      console.error('[control-debug] invalid session', e);
      navigate('/');
    }
  }, [navigate]);

  // Mic publishing defaults to off in both rooms on entry (視聴のみ), same as
  // 実験群. Unlike 実験群, there is no summon to drive this automatically —
  // the user toggles each room's mic independently and both can be on at once.
  useEffect(() => {
    roomA?.localParticipant.setMicrophoneEnabled(micOnA).catch((e) => {
      console.error('[control-debug] setMicrophoneEnabled(A) failed', e);
    });
  }, [roomA, micOnA]);

  useEffect(() => {
    roomB?.localParticipant.setMicrophoneEnabled(micOnB).catch((e) => {
      console.error('[control-debug] setMicrophoneEnabled(B) failed', e);
    });
  }, [roomB, micOnB]);

  if (!sessions) {
    return <div style={{ padding: 24 }}>Loading...</div>;
  }

  const sessionA = sessions[0];
  const sessionB = sessions[1];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#000' }}>
      <div style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button onClick={() => navigate('/')} style={{ padding: '6px 10px' }}>
          戻る
        </button>
        <div style={{ color: '#ccc' }}>あなた：田中さん</div>
        <button
          onClick={() => {
            // Call synchronously from this click handler (not from an effect)
            // so the browser's unmuted-autoplay policy sees a direct user
            // gesture before the live サクラ audio actually starts.
            panelARef.current?.play();
            panelBRef.current?.play();
            setStarted(true);
          }}
          disabled={started || sakuraTracksA.length === 0 || sakuraTracksB.length === 0}
          style={{ padding: '6px 10px' }}
        >
          開始
        </button>
      </div>

      {/* Hidden LiveKitRoom connections — only used to obtain the remote camera/mic MediaStreamTrack + Room */}
      <div style={{ display: 'none' }}>
        <LiveKitRoom serverUrl={sessionA.url} token={sessionA.token} connect video audio={false}>
          <CommaTrackBridge onTracks={setSakuraTracksA} onRoom={setRoomA} />
        </LiveKitRoom>
        <LiveKitRoom serverUrl={sessionB.url} token={sessionB.token} connect video audio={false}>
          <CommaTrackBridge onTracks={setSakuraTracksB} onRoom={setRoomB} />
        </LiveKitRoom>
      </div>

      {/* Each room (heading + video + mic button) is wrapped in its own
          bordered frame, so the whole room — not just the video — reads as
          one enclosed unit. */}
      <div style={{ display: 'flex', width: '100%' }}>
        <div style={roomFrameStyle}>
          <div style={headingStyle}>{meetingDisplayName('A')}</div>
          {/* Video height is pinned to the footage's own aspect ratio (two
              640x180 composite-equivalent panels side by side ⇒ 64:9 for the
              pair, 32:9 per room) — not flex:1, so the panel's box never
              grows/shrinks with the rest of the page, and (together with
              LiveSakuraPanel's fixed MAX_SAKURA_PER_ROOM-slot grid) stays
              visually identical whether 1 or 2 サクラ are currently present. */}
          <div style={{ width: '100%', aspectRatio: '32 / 9', maxHeight: '68vh', flexShrink: 0, overflow: 'hidden' }}>
            <LiveSakuraPanel ref={panelARef} tracks={sakuraTracksA} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', padding: 8 }}>
            <MicIconButton
              enabled={micOnA}
              onClick={() => setMicOnA((v) => !v)}
              ariaLabel={`${meetingDisplayName('A')}のマイクを${micOnA ? 'オフ' : 'オン'}にする`}
            />
          </div>
        </div>
        <div style={roomFrameStyle}>
          <div style={headingStyle}>{meetingDisplayName('B')}</div>
          <div style={{ width: '100%', aspectRatio: '32 / 9', maxHeight: '68vh', flexShrink: 0, overflow: 'hidden' }}>
            <LiveSakuraPanel ref={panelBRef} tracks={sakuraTracksB} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', padding: 8 }}>
            <MicIconButton
              enabled={micOnB}
              onClick={() => setMicOnB((v) => !v)}
              ariaLabel={`${meetingDisplayName('B')}のマイクを${micOnB ? 'オフ' : 'オン'}にする`}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ControlDebug;
