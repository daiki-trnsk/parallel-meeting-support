import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';

type TranscriptEntry = {
  id: string;
  participant: string;
  text: string;
};

const MAX_ENTRIES = 100;
const TRANSCRIPT_TOPIC = 'transcript';
const AT_BOTTOM_THRESHOLD = 30;

type Props = { roomLabel: string };

const TranscriptPanel: React.FC<Props> = ({ roomLabel }) => {
  const room = useRoomContext();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleData = (payload: Uint8Array, _participant: unknown, _kind: unknown, topic?: string) => {
      if (topic !== TRANSCRIPT_TOPIC) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        const entry: TranscriptEntry = {
          id: `${Date.now()}-${Math.random()}`,
          participant: String(msg.participant ?? ''),
          text: String(msg.text ?? ''),
        };
        setEntries(prev => {
          const next = [...prev, entry];
          return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
        });
      } catch {
        // malformed payload — ignore
      }
    };

    room.on('dataReceived', handleData);
    return () => { room.off('dataReceived', handleData); };
  }, [room]);

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
        height: 200,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#111',
        color: '#ddd',
        fontSize: 13,
        borderTop: '1px solid #333',
      }}
    >
      <div
        style={{
          padding: '3px 8px',
          background: '#1e1e1e',
          fontSize: 11,
          color: '#888',
          flexShrink: 0,
        }}
      >
        字幕 — {roomLabel}
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', padding: '4px 8px' }}
      >
        {entries.map(e => (
          <div key={e.id} style={{ marginBottom: 3, lineHeight: 1.4, textAlign: 'left' }}>
            <span style={{ color: '#7aabff', marginRight: 6, fontWeight: 600 }}>
              {e.participant}
            </span>
            <span>{e.text}</span>
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

export default TranscriptPanel;
