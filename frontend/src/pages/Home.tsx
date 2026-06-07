import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

type Role = { name: string; identity: string };

const ROLES: Role[] = [
  { name: '同時参加者', identity: 'subject-01' },
  { name: 'サクラA', identity: 'sakura-a' },
  { name: 'サクラB', identity: 'sakura-b' },
  { name: 'サクラC', identity: 'sakura-c' },
  { name: 'サクラD', identity: 'sakura-d' },
];

const Home: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function joinAs(role: Role) {
    setError(null);
    setLoading(role.identity);
    try {
      const res = await fetch('https://pms-token-server.onrender.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: role.identity }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // save to sessionStorage
      sessionStorage.setItem('livekit_session', JSON.stringify(data));
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
  width: 240,
};

const buttonStyle: React.CSSProperties = {
  padding: '12px 16px',
  fontSize: 16,
  borderRadius: 6,
  cursor: 'pointer',
};

export default Home;
