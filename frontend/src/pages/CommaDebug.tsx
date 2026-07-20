import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '@livekit/components-styles';
import { LiveKitRoom } from '@livekit/components-react';
import type { Room } from 'livekit-client';
import CommaTrackBridge from '../components/CommaTrackBridge';
import PlaybackController, {
  type PlaybackControllerHandle,
  type DebugEvent,
} from '../components/PlaybackController';
import DebugReadout from '../components/DebugReadout';
import { useSubtitleSync, type SubtitleEntry } from '../hooks/useSubtitleSync';

type RoomSession = { token: string; url: string; room: string; identity: string; name?: string };

const MAX_EVENTS = 200;
const AT_BOTTOM_THRESHOLD = 30;

// Mirrors TranscriptPanel.tsx's auto-scroll-to-latest / "return to latest"
// pattern: stays pinned to the bottom as new entries arrive, but stops
// auto-scrolling as soon as the user scrolls away from the bottom, until
// they explicitly ask to jump back.
const SubtitleColumn: React.FC<{ entries: SubtitleEntry[]; borderRight?: boolean }> = ({
  entries,
  borderRight,
}) => {
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD;
    if (!atBottom) setAutoScroll(false);
  }, []);

  const returnToLatest = () => {
    setAutoScroll(true);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  };

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRight: borderRight ? '1px solid #333' : undefined,
      }}
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', padding: 8, color: '#ddd', fontSize: 13, textAlign: 'left' }}
      >
        {entries.map((s) => (
          <div key={s.id}>
            <span style={{ color: '#7aabff', marginRight: 6, fontWeight: 600 }}>{s.participant}</span>
            <span>{s.text}</span>
          </div>
        ))}
      </div>
      {!autoScroll && (
        <button
          onClick={returnToLatest}
          style={{
            margin: '4px 8px',
            padding: '3px 10px',
            fontSize: 11,
            cursor: 'pointer',
            background: '#2a2a2a',
            color: '#ccc',
            border: '1px solid #444',
            borderRadius: 4,
            alignSelf: 'flex-end',
          }}
        >
          最新へ戻る ↓
        </button>
      )}
    </div>
  );
};

const CommaDebug: React.FC = () => {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<RoomSession[] | null>(null);
  const [trackA, setTrackA] = useState<MediaStreamTrack | null>(null);
  const [trackB, setTrackB] = useState<MediaStreamTrack | null>(null);
  const [audioTrackA, setAudioTrackA] = useState<MediaStreamTrack | null>(null);
  const [audioTrackB, setAudioTrackB] = useState<MediaStreamTrack | null>(null);
  const [roomA, setRoomA] = useState<Room | null>(null);
  const [roomB, setRoomB] = useState<Room | null>(null);
  const [started, setStarted] = useState(false);
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);

  const controllerRef = useRef<PlaybackControllerHandle | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem('livekit_session');
    if (!raw) {
      navigate('/');
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const list: RoomSession[] = Array.isArray(parsed) ? parsed : [parsed];
      if (list.length < 2) throw new Error('need two sessions (room-a, room-b) for comma debug');
      setSessions(list);
    } catch (e) {
      console.error('[comma-debug] invalid session', e);
      navigate('/');
    }
  }, [navigate]);

  const onDebugEvent = useCallback((e: DebugEvent) => {
    setEvents((prev) => {
      const next = [...prev, e];
      return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
    });
  }, []);

  const { visible: subtitles } = useSubtitleSync({ roomA, roomB });

  if (!sessions) {
    return <div style={{ padding: 24 }}>Loading...</div>;
  }

  const sessionA = sessions[0];
  const sessionB = sessions[1];
  const subtitlesA = subtitles.filter((s) => s.room === 'A');
  const subtitlesB = subtitles.filter((s) => s.room === 'B');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#000' }}>
      <div style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button onClick={() => navigate('/')} style={{ padding: '6px 10px' }}>
          戻る
        </button>
        <div style={{ color: '#ccc' }}>コマ単位バッファ追いつき倍速再生 — デバッグ</div>
        <button
          onClick={() => {
            // Call synchronously from this click handler (not from an effect)
            // so the browser's unmuted-autoplay policy sees a direct user
            // gesture before comma playback (with audio) actually starts.
            controllerRef.current?.unlockPlayback();
            setStarted(true);
          }}
          disabled={started || !trackA || !trackB}
          style={{ padding: '6px 10px' }}
        >
          開始
        </button>
        <button onClick={() => setDebugOpen((v) => !v)} style={{ padding: '6px 10px', marginLeft: 'auto' }}>
          {debugOpen ? 'デバッグ情報を閉じる ▲' : 'デバッグ情報 ▼'}
        </button>
      </div>

      {/* Hidden LiveKitRoom connections — only used to obtain the remote camera/mic MediaStreamTrack + Room */}
      <div style={{ display: 'none' }}>
        <LiveKitRoom serverUrl={sessionA.url} token={sessionA.token} connect video audio={false}>
          <CommaTrackBridge onTrack={setTrackA} onAudioTrack={setAudioTrackA} onRoom={setRoomA} />
        </LiveKitRoom>
        <LiveKitRoom serverUrl={sessionB.url} token={sessionB.token} connect video audio={false}>
          <CommaTrackBridge onTrack={setTrackB} onAudioTrack={setAudioTrackB} onRoom={setRoomB} />
        </LiveKitRoom>
      </div>

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <PlaybackController
            ref={controllerRef}
            trackA={trackA}
            trackB={trackB}
            audioTrackA={audioTrackA}
            audioTrackB={audioTrackB}
            started={started}
            onDebugEvent={onDebugEvent}
          />
        </div>

        <div style={{ display: 'flex', height: 140, flexShrink: 0, borderTop: '1px solid #333' }}>
          <SubtitleColumn entries={subtitlesA} borderRight />
          <SubtitleColumn entries={subtitlesB} />
        </div>

        {/* Dropdown-style debug overlay: hidden by default, covers the A/B
            panels when opened rather than taking up permanent layout space. */}
        {debugOpen && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 10,
              background: 'rgba(8,8,8,0.97)',
            }}
          >
            <DebugReadout controllerRef={controllerRef} events={events} />
          </div>
        )}
      </div>
    </div>
  );
};

export default CommaDebug;
