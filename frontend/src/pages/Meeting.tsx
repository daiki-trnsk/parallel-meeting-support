import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '@livekit/components-styles';
import { LiveKitRoom, VideoConference } from '@livekit/components-react';

const Meeting: React.FC = () => {
  const navigate = useNavigate();
  const [session, setSession] = useState<any | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem('livekit_session');
    if (!raw) {
      navigate('/');
      return;
    }
    try {
      const obj = JSON.parse(raw);
      setSession(obj);
    } catch (e) {
      sessionStorage.removeItem('livekit_session');
      navigate('/');
    }
  }, [navigate]);

  if (!session) {
    return <div style={{ padding: 24 }}>Loading...</div>;
  }

  const { token, url, name } = session;

  return (
    <div style={{ height: '100vh' }}>
      <div style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={() => navigate('/')} style={{ padding: '6px 10px' }}>
          戻る
        </button>
        <div>{name ?? session.identity}</div>
      </div>
      <LiveKitRoom serverUrl={url} token={token} connect={true} video audio>
        <VideoConference />
      </LiveKitRoom>
    </div>
  );
};

export default Meeting;
