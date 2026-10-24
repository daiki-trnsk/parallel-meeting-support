import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Room, RoomEvent, Track, type VideoEncoding } from 'livekit-client';
import {
  RECORDED_SAKURA,
  SAKURA_CONTROL_TOPIC,
  SAKURA_IDS,
  SAKURA_READY_ATTR,
  isSakuraId,
  type SakuraId,
} from '../lib/recordedSakura';
import { roomDisplayName } from '../lib/meetingLabels';

const TOKEN_API = 'https://pms-token-server.onrender.com/token';

// 通常視聴（リアルタイム）と同じ公開品質: 360p / 15fps / 〜200kbps（docs/configuration.md）
const TARGET_HEIGHT = 360;
const MAX_FRAMERATE = 15;
const MAX_BITRATE = 200_000;

type Phase = 'noFile' | 'loading' | 'loaded' | 'connecting' | 'ready' | 'playing' | 'rejoining' | 'error';

const PHASE_LABEL: Record<Phase, string> = {
  noFile: '動画ファイルを選択してください',
  loading: '動画を読み込み中…',
  loaded: '読み込み完了（「接続」を押してください）',
  connecting: '接続中…',
  ready: '待機中（ready）— 同時参加者の開始を待っています',
  playing: '再生中',
  rejoining: '再生終了 — 再接続中…',
  error: 'エラー',
};

type CapturableVideo = HTMLVideoElement & { captureStream(): MediaStream };

/** Same request as Home.tsx's joinAs, for a single room. */
async function fetchToken(identity: string, room: string): Promise<{ token: string; url: string }> {
  const res = await fetch(TOKEN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity, room }),
  });
  if (!res.ok) throw new Error(`トークン取得に失敗しました: HTTP ${res.status} (${room})`);
  return res.json();
}

function waitMediaEvent(el: HTMLMediaElement, type: 'canplaythrough' | 'seeked'): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      el.removeEventListener('error', onErr);
      resolve();
    };
    const onErr = () => {
      el.removeEventListener(type, onOk);
      reject(new Error(`動画の読み込みに失敗しました (${el.error?.message ?? 'unknown'})`));
    };
    el.addEventListener(type, onOk, { once: true });
    el.addEventListener('error', onErr, { once: true });
  });
}

async function rewind(video: HTMLVideoElement): Promise<void> {
  video.pause();
  if (video.currentTime === 0) return;
  const seeked = waitMediaEvent(video, 'seeked');
  video.currentTime = 0;
  await seeked;
}

/**
 * 録画動画サクラ: 1ウィンドウ = 出演者1人（/sakura?id=A..D）。
 *
 * 生声サクラ（Meeting.tsx）とは映像・音声の供給元だけが違う。getUserMedia の
 * 代わりに、選択した動画ファイルを再生する <video> から
 *   映像: video.captureStream() の映像トラック
 *   音声: createMediaElementSource(video) → MediaStreamAudioDestinationNode
 * を取り、同じ identity（participant-a..d）・同じ Room に Camera/Microphone
 * として publish する。音声グラフは ctx.destination に繋がないので、
 * createMediaElementSource で要素の出力が奪われた結果、サクラPC からは音が出ない。
 *
 * publish 完了で attributes.ready='1' を立て、同時参加者の start（Data Channel）
 * で再生を始める。ended で退室 → 0秒に戻して再接続 → ready を立て直し、
 * リロードなしで次のセッションに使える。再生中の切断・リロードからの復帰はしない。
 */
const Sakura: React.FC = () => {
  const [searchParams] = useSearchParams();
  const rawId = searchParams.get('id')?.toUpperCase() ?? null;
  const id: SakuraId | null = isSakuraId(rawId) ? rawId : null;

  if (!id) {
    return (
      <div style={{ padding: 24 }}>
        <p>id が不正です（A〜D を指定してください）。</p>
        <ul>
          {SAKURA_IDS.map((s) => (
            <li key={s}>
              <a href={`/sakura?id=${s}`}>/sakura?id={s}</a>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return <SakuraPlayer id={id} />;
};

const SakuraPlayer: React.FC<{ id: SakuraId }> = ({ id }) => {
  const cfg = RECORDED_SAKURA[id];
  const [phase, setPhase] = useState<Phase>('noFile');
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileReady, setFileReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const roomRef = useRef<Room | null>(null);
  // true only between "ready set" and "start received" — start is honoured once.
  const awaitingStartRef = useRef(false);
  const playingRef = useRef(false);

  const fail = useCallback((e: unknown) => {
    console.error('[sakura]', e);
    awaitingStartRef.current = false;
    playingRef.current = false;
    setError(e instanceof Error ? e.message : String(e));
    setPhase('error');
  }, []);

  const leave = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    awaitingStartRef.current = false;
    // stopTracks (default true) stops this connection's captured video track
    // and audio clone; the next join takes fresh ones.
    await room?.disconnect();
  }, []);

  const onStart = useCallback(() => {
    const video = videoRef.current;
    if (!video || !awaitingStartRef.current) return;
    awaitingStartRef.current = false;
    playingRef.current = true;
    video
      .play()
      .then(() => {
        setPhase('playing');
        // Not part of the start handshake — just keeps "ready" honest while
        // this take is being played back.
        roomRef.current?.localParticipant.setAttributes({ [SAKURA_READY_ATTR]: '0' }).catch(() => {});
      })
      .catch(fail);
  }, [fail]);

  const join = useCallback(async () => {
    const video = videoRef.current as CapturableVideo | null;
    const dest = destRef.current;
    if (!video || !dest) throw new Error('動画または音声グラフが未初期化です');

    await leave();
    await rewind(video);

    const { token, url } = await fetchToken(cfg.identity, cfg.room);
    const room = new Room();
    roomRef.current = room;
    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic !== SAKURA_CONTROL_TOPIC) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg?.action === 'start') onStart();
      } catch {
        // malformed payload — ignore
      }
    });
    room.on(RoomEvent.Disconnected, () => {
      // Our own leave() clears roomRef first; anything else is unexpected.
      if (roomRef.current === room) fail(new Error('Room から切断されました（復帰処理なし）'));
    });

    // サクラは他人の映像・音声を見聞きしないので購読しない（同一PC複数ウィンドウの負荷対策）。
    // Data Channel は購読と無関係に届く。
    await room.connect(url, token, { autoSubscribe: false });

    const captured = video.captureStream();
    captured.getAudioTracks().forEach((t) => t.stop()); // 音声は AudioContext 経由で取る
    const videoTrack = captured.getVideoTracks()[0];
    if (!videoTrack) throw new Error('captureStream() から映像トラックを取得できません');

    // simulcast:false のとき livekit-client は videoEncoding をそのまま
    // sendEncodings に渡すので、360p への縮小は scaleResolutionDownBy で指定する
    // （VideoEncoding 型には無いフィールドのためキャスト）。
    const scaleResolutionDownBy = Math.max(1, video.videoHeight / TARGET_HEIGHT);
    await room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.Camera,
      simulcast: false,
      videoEncoding: {
        maxBitrate: MAX_BITRATE,
        maxFramerate: MAX_FRAMERATE,
        scaleResolutionDownBy,
      } as VideoEncoding,
    });
    await room.localParticipant.publishTrack(dest.stream.getAudioTracks()[0].clone(), {
      source: Track.Source.Microphone,
    });
    await room.localParticipant.setAttributes({ [SAKURA_READY_ATTR]: '1' });

    awaitingStartRef.current = true;
    setPhase('ready');
  }, [cfg, leave, onStart, fail]);

  const onConnect = () => {
    const video = videoRef.current;
    if (!video) return;
    if (!ctxRef.current) {
      // createMediaElementSource can only be called once per element, so the
      // graph is built once and reused for every later connection.
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(video);
      const dest = ctx.createMediaStreamDestination();
      source.connect(dest); // ctx.destination には接続しない（サクラPCから音を出さない）
      ctxRef.current = ctx;
      destRef.current = dest;
    }
    // resume() is called synchronously inside the click handler (user gesture).
    const resumed = ctxRef.current.resume();
    setError(null);
    setPhase('connecting');
    resumed.then(join).catch(fail);
  };

  const onEnded = () => {
    if (!playingRef.current) return;
    playingRef.current = false;
    setPhase('rejoining');
    join().catch(fail);
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const video = videoRef.current;
    if (!file || !video) return;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setFileName(file.name);
    setFileReady(false);
    setError(null);
    setPhase('loading');
    const loaded = waitMediaEvent(video, 'canplaythrough');
    video.src = url;
    video.load();
    loaded
      .then(() => rewind(video))
      .then(() => {
        setFileReady(true);
        setPhase('loaded');
      })
      .catch(fail);
  };

  useEffect(() => {
    return () => {
      const room = roomRef.current;
      roomRef.current = null;
      room?.disconnect();
      ctxRef.current?.close().catch(() => {});
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const nameMatch = fileName ? /^meeting(\d+)_([A-Za-z])\.mp4$/i.exec(fileName) : null;
  const fileWarning =
    nameMatch && (Number(nameMatch[1]) !== cfg.meeting || nameMatch[2].toUpperCase() !== id)
      ? `ファイル名 ${fileName} はこのウィンドウ（meeting${cfg.meeting}_${id}）と一致しません`
      : null;

  const busy = phase === 'connecting' || phase === 'ready' || phase === 'playing' || phase === 'rejoining';
  // After an error, 接続 retries from 0s (no mid-playback recovery).
  const canConnect = fileReady && (phase === 'loaded' || phase === 'error');

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'sans-serif' }}>
      <h2 style={{ margin: 0 }}>
        録画サクラ {id}（{roomDisplayName(cfg.room)} / {cfg.identity}）
      </h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <input type="file" accept="video/*" onChange={onFileChange} disabled={busy} />
        <button onClick={onConnect} disabled={!canConnect} style={{ padding: '6px 14px' }}>
          接続
        </button>
      </div>
      {fileWarning && (
        <div style={{ padding: 8, background: '#fff3cd', color: '#7a5200', border: '1px solid #e0b000' }}>
          ⚠ {fileWarning}
        </div>
      )}
      <div>
        状態：<strong>{PHASE_LABEL[phase]}</strong>
        {error && <span style={{ color: 'crimson', marginLeft: 8 }}>{error}</span>}
      </div>
      {/* Preview only: its audio is taken over by createMediaElementSource
          once 接続 is pressed, and never routed to the speakers. */}
      <video
        ref={videoRef}
        preload="auto"
        playsInline
        onEnded={onEnded}
        style={{ width: 480, maxWidth: '100%', background: '#000' }}
      />
    </div>
  );
};

export default Sakura;
