import React, { useEffect, useState } from 'react';
import type { PlaybackControllerHandle, PlaybackSnapshot, DebugEvent } from './PlaybackController';
import type { MeetingId } from '../hooks/useMeetingRecorder';

const POLL_INTERVAL_MS = 200;
const MAX_LOG_ENTRIES = 30;

function formatBuffered(buffered: TimeRanges | null): string {
  if (!buffered || buffered.length === 0) return '(empty)';
  const parts: string[] = [];
  for (let i = 0; i < buffered.length; i++) {
    parts.push(`[${buffered.start(i).toFixed(2)}–${buffered.end(i).toFixed(2)}]`);
  }
  return parts.join(' ');
}

type Props = {
  controllerRef: React.RefObject<PlaybackControllerHandle | null>;
  events: DebugEvent[];
};

const meetingRow = (id: MeetingId, snapshot: PlaybackSnapshot | null) => {
  const v = snapshot?.videos[id];
  return (
    <div key={id} style={{ marginBottom: 4 }}>
      <strong>{id}</strong> state={v?.recorderState ?? '-'} currentTime={v?.currentTime.toFixed(2) ?? '-'}{' '}
      rate={v?.playbackRate.toFixed(1) ?? '-'} buffered={formatBuffered(v?.buffered ?? null)}
    </div>
  );
};

const DebugReadout: React.FC<Props> = ({ controllerRef, events }) => {
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const s = controllerRef.current?.getSnapshot() ?? null;
      setSnapshot(s);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [controllerRef]);

  const recentEvents = events.slice(-MAX_LOG_ENTRIES).reverse();

  return (
    <div
      style={{
        fontFamily: 'monospace',
        fontSize: 12,
        background: '#111',
        color: '#ddd',
        padding: 8,
        overflowY: 'auto',
        height: '100%',
      }}
    >
      <div style={{ marginBottom: 8 }}>
        focus=<strong>{snapshot?.focus ?? '-'}</strong> cycleIndex={snapshot?.cycleIndex ?? '-'}{' '}
        {snapshot?.isWarmup ? '(warmup)' : ''}
      </div>
      {meetingRow('A', snapshot)}
      {meetingRow('B', snapshot)}
      <div style={{ marginTop: 8, borderTop: '1px solid #333', paddingTop: 4 }}>
        {recentEvents.map((e, i) => (
          <div key={i} style={{ color: e.event === 'catchup-missed' ? '#ff8080' : '#8ab4f8' }}>
            [{e.cycleIndex}] {e.event} {e.meeting}
            {'seekTarget' in e ? ` seek=${(e.seekTarget as number).toFixed(2)}` : ''}
            {'bufferedEnd' in e ? ` bufEnd=${(e.bufferedEnd as number).toFixed(2)}` : ''}
          </div>
        ))}
      </div>
    </div>
  );
};

export default DebugReadout;
