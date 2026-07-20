import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '@livekit/components-styles';
import { LiveKitRoom, useTracks } from '@livekit/components-react';
import { Track } from 'livekit-client';

/**
 * Minimal spike: single remote MediaStreamTrack -> MediaRecorder -> MediaSource -> single <video>.
 * No comma switching, no eviction, no subtitle sync. Just confirms the MSE pipeline
 * (MediaRecorder chunking + SourceBuffer.appendBuffer + <video> playback) works at all
 * in this environment, independent of the comma-debug feature code.
 */

type RoomSession = { token: string; url: string; room: string; identity: string; name?: string };

const CANDIDATE_MIME_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function pickMimeType(): string | null {
  for (const c of CANDIDATE_MIME_TYPES) {
    const recorderOk = MediaRecorder.isTypeSupported(c);
    const sourceOk = MediaSource.isTypeSupported(c);
    console.log('[spike] mimeType candidate', c, { recorderOk, sourceOk });
    if (recorderOk && sourceOk) return c;
  }
  return null;
}

const TrackGrabber: React.FC<{ onTrack: (t: MediaStreamTrack) => void }> = ({ onTrack }) => {
  const tracks = useTracks([Track.Source.Camera]);
  const grabbed = useRef(false);

  useEffect(() => {
    if (grabbed.current) return;
    const remote = tracks.find((t) => !t.participant.isLocal && t.publication?.track);
    const mst = remote?.publication?.track?.mediaStreamTrack;
    if (mst) {
      grabbed.current = true;
      console.log('[spike] got remote MediaStreamTrack', mst);
      onTrack(mst);
    }
  }, [tracks, onTrack]);

  return null;
};

const SpikePipeline: React.FC<{ track: MediaStreamTrack }> = ({ track }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const appendLog = (line: string) => {
    console.log('[spike]', line);
    setLog((prev) => [...prev.slice(-49), line]);
  };

  useEffect(() => {
    const mt = pickMimeType();
    if (!mt) {
      appendLog('ERROR: no supported mimeType for both MediaRecorder and MediaSource');
      return;
    }
    appendLog(`using mimeType: ${mt}`);

    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    if (videoRef.current) {
      videoRef.current.src = url;
    }

    let recorder: MediaRecorder | null = null;
    let chunkCount = 0;

    const onSourceOpen = () => {
      appendLog('MediaSource sourceopen');
      const sb = mediaSource.addSourceBuffer(mt);

      sb.addEventListener('updateend', () => {
        const buffered = sb.buffered;
        const range =
          buffered.length > 0
            ? `[${buffered.start(0).toFixed(2)}-${buffered.end(buffered.length - 1).toFixed(2)}]`
            : '(empty)';
        appendLog(`SourceBuffer updateend, buffered=${range}`);
      });
      sb.addEventListener('error', (e) => appendLog(`SourceBuffer ERROR: ${String(e)}`));

      const queue: ArrayBuffer[] = [];
      const drain = () => {
        if (sb.updating || queue.length === 0) return;
        const buf = queue.shift()!;
        try {
          sb.appendBuffer(buf);
        } catch (e) {
          appendLog(`appendBuffer threw: ${String(e)}`);
        }
      };
      sb.addEventListener('updateend', drain);

      const stream = new MediaStream([track]);
      recorder = new MediaRecorder(stream, { mimeType: mt });

      recorder.ondataavailable = (ev: BlobEvent) => {
        if (!ev.data.size) return;
        chunkCount += 1;
        appendLog(`chunk #${chunkCount} size=${ev.data.size}`);
        ev.data.arrayBuffer().then((buf) => {
          queue.push(buf);
          drain();
        });
      };
      recorder.onstart = () => appendLog('MediaRecorder started');
      recorder.onerror = (e) => appendLog(`MediaRecorder ERROR: ${String(e)}`);
      recorder.onstop = () => appendLog('MediaRecorder stopped');

      recorder.start(250);
    };

    mediaSource.addEventListener('sourceopen', onSourceOpen);

    const video = videoRef.current;
    const onPlaying = () => appendLog('<video> playing');
    const onError = () => appendLog(`<video> ERROR: ${video?.error?.message ?? 'unknown'}`);
    const onWaiting = () => appendLog('<video> waiting (stalled)');
    video?.addEventListener('playing', onPlaying);
    video?.addEventListener('error', onError);
    video?.addEventListener('waiting', onWaiting);

    return () => {
      mediaSource.removeEventListener('sourceopen', onSourceOpen);
      video?.removeEventListener('playing', onPlaying);
      video?.removeEventListener('error', onError);
      video?.removeEventListener('waiting', onWaiting);
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      URL.revokeObjectURL(url);
    };
  }, [track]);

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <video ref={videoRef} autoPlay muted playsInline style={{ flex: 1, background: '#000' }} />
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          background: '#111',
          color: '#ddd',
          fontFamily: 'monospace',
          fontSize: 12,
          padding: 8,
        }}
      >
        {log.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </div>
  );
};

const SpikeTest: React.FC = () => {
  const navigate = useNavigate();
  const [session, setSession] = useState<RoomSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [track, setTrack] = useState<MediaStreamTrack | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem('livekit_session');
    console.log('[spike] sessionStorage.livekit_session raw =', raw);
    if (!raw) {
      setSessionError(
        'sessionStorage に livekit_session がありません。Home で参加した同じタブで /spike-test を開いてください（sessionStorage はタブ単位で、別タブ/シークレットウィンドウには引き継がれません）。',
      );
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const list: RoomSession[] = Array.isArray(parsed) ? parsed : [parsed];
      if (list.length === 0) throw new Error('empty session list');
      setSession(list[0]);
    } catch (e) {
      setSessionError(`livekit_session の解析に失敗しました: ${String(e)}`);
    }
  }, []);

  if (sessionError) {
    return (
      <div style={{ padding: 24, color: '#ccc', background: '#000', height: '100vh' }}>
        <div style={{ marginBottom: 12 }}>{sessionError}</div>
        <button onClick={() => navigate('/')} style={{ padding: '6px 10px' }}>
          Home へ
        </button>
      </div>
    );
  }

  if (!session) {
    return <div style={{ padding: 24 }}>Loading...</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#000' }}>
      <div style={{ padding: 8, color: '#ccc' }}>
        <button onClick={() => navigate('/')} style={{ padding: '6px 10px', marginRight: 12 }}>
          戻る
        </button>
        MSEパイプライン スパイクテスト — {session.room}
      </div>
      <div style={{ display: 'none' }}>
        <LiveKitRoom serverUrl={session.url} token={session.token} connect video audio={false}>
          <TrackGrabber onTrack={setTrack} />
        </LiveKitRoom>
      </div>
      {track ? <SpikePipeline track={track} /> : <div style={{ padding: 24, color: '#ccc' }}>カメラ待ち...</div>}
    </div>
  );
};

export default SpikeTest;
