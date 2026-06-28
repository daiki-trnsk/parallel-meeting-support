import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

type Role = { name: string; identity: string; rooms: string[] };

const ROLES: Role[] = [
  { name: '参加者A (room-a)', identity: 'participant-a', rooms: ['room-a'] },
  { name: '参加者B (room-a)', identity: 'participant-b', rooms: ['room-a'] },
  { name: '参加者C (room-b)', identity: 'participant-c', rooms: ['room-b'] },
  { name: '参加者D (room-b)', identity: 'participant-d', rooms: ['room-b'] },
  { name: '同時参加者 (subject-01)', identity: 'subject-01', rooms: ['room-a', 'room-b'] },
];

type RoomSession = { token: string; url: string; room: string; identity: string; name?: string };

const TOKEN_API = 'https://pms-token-server.onrender.com/token';

const Home: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function joinAs(role: Role) {
    setError(null);
    setLoading(role.identity);
    try {
      const sessions: RoomSession[] = await Promise.all(
        role.rooms.map(async (room) => {
          const res = await fetch(TOKEN_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity: role.identity, room }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status} (${room})`);
          const data = await res.json();
          return { ...data, room } as RoomSession;
        }),
      );
      sessionStorage.setItem('livekit_session', JSON.stringify(sessions));
      navigate('/meeting');
    } catch (e: any) {
      setError(e?.message ?? 'トークン取得に失敗しました');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div style={containerStyle}>
      <h1>Parallel Meeting Support System</h1>
      <div style={buttonColumnStyle}>
        {ROLES.map((r) => (
          <button
            key={r.identity}
            onClick={() => joinAs(r)}
            style={buttonStyle}
            disabled={loading !== null}
          >
            {loading === r.identity ? '接続中…' : r.name}
          </button>
        ))}
      </div>
      {error && <div style={{ color: 'crimson', marginTop: 12 }}>{error}</div>}
    </div>
  );
};

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100vh',
  gap: 20,
};

const buttonColumnStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  width: 260,
};

const buttonStyle: React.CSSProperties = {
  padding: '12px 16px',
  fontSize: 16,
  borderRadius: 6,
  cursor: 'pointer',
};

export default Home;
