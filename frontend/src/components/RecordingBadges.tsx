import React from 'react';
import type { MeetingId } from '../hooks/useMeetingRecorder';
import type { RecordingState } from '../hooks/useRecordingControl';

/** Per-room acknowledgement of the agent-side experiment audio recording. */
const RecordingBadges: React.FC<{ state: Record<MeetingId, RecordingState> }> = ({ state }) => (
  <>
    {(['A', 'B'] as MeetingId[]).map((m) => {
      const s = state[m];
      return (
        <span
          key={m}
          title={s === 'missing' ? 'agent から録音中の応答がありません' : undefined}
          style={{
            padding: '2px 6px',
            fontSize: 11,
            borderRadius: 3,
            color: s === 'recording' ? '#f44336' : s === 'missing' ? '#fff' : '#888',
            background: s === 'missing' ? '#c62828' : 'transparent',
            border: `1px solid ${s === 'recording' ? '#f44336' : s === 'missing' ? '#c62828' : '#555'}`,
          }}
        >
          {s === 'recording' ? '● ' : ''}REC {m}
          {s === 'missing' ? ' 未開始' : s === 'idle' ? ' 確認中' : ''}
        </span>
      );
    })}
  </>
);

export default RecordingBadges;
