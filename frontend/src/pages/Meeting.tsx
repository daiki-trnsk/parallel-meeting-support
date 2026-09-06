import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '@livekit/components-styles';
import { LiveKitRoom, VideoConference } from '@livekit/components-react';
import TranscriptPanel from '../components/TranscriptPanel';

type RoomSession = { token: string; url: string; room: string; identity: string; name?: string };

const Meeting: React.FC = () => {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<RoomSession[] | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem('livekit_session');
    if (!raw) {
      navigate('/');
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const list: RoomSession[] = Array.isArray(parsed) ? parsed : [parsed];
      if (list.length === 0) throw new Error('empty');
      setSessions(list);
    } catch (e) {
      sessionStorage.removeItem('livekit_session');
      navigate('/');
    }
  }, [navigate]);

  if (!sessions) {
    return <div style={{ padding: 24 }}>Loading...</div>;
  }

  const displayName = sessions[0].name ?? sessions[0].identity;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button onClick={() => navigate('/')} style={{ padding: '6px 10px' }}>
          戻る
        </button>
        <div>{displayName}</div>
      </div>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {sessions.map((s, i) => (
          <div
            key={s.room}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              borderLeft: i > 0 ? '2px solid #444' : undefined,
              overflow: 'hidden',
            }}
          >
            {sessions.length > 1 && (
              <div
                style={{
                  padding: '2px 8px',
                  fontSize: 12,
                  background: '#222',
                  color: '#aaa',
                  flexShrink: 0,
                }}
              >
                {s.room}
              </div>
            )}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {sessions.length > 1 ? (
                <LiveKitRoom
                  serverUrl={s.url}
                  token={s.token}
                  connect={true}
                  video
                  audio
                  style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
                >
                  {/* auto (not hidden): LiveKit's own grid layout needs more
                      height than this box has as participant count changes
                      (1 vs 3 tiles, etc.) — with `hidden` that extra height
                      was silently clipped, hiding the mic/camera control bar
                      that sits at the bottom of VideoConference's own layout.
                      `auto` keeps the control bar reachable via scroll
                      instead of clipping it away. */}
                  <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                    <VideoConference />
                  </div>
                  <TranscriptPanel roomLabel={s.room} />
                </LiveKitRoom>
              ) : (
                <LiveKitRoom
                  serverUrl={s.url}
                  token={s.token}
                  connect={true}
                  video
                  audio
                  style={{ height: '100%', overflow: 'auto' }}
                >
                  <VideoConference />
                </LiveKitRoom>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Meeting;
