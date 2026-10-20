import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '@livekit/components-styles';
import { LiveKitRoom } from '@livekit/components-react';
import type { Room } from 'livekit-client';
import CommaTrackBridge, { type SakuraTrack } from '../components/CommaTrackBridge';
import PlaybackController, {
  type PlaybackControllerHandle,
  type DebugEvent,
  type CatchupStart,
} from '../components/PlaybackController';
import DebugReadout from '../components/DebugReadout';
import RealtimeOverlay from '../components/RealtimeOverlay';
import RecordingBadges from '../components/RecordingBadges';
import { useSubtitleSync, type SubtitleEntry } from '../hooks/useSubtitleSync';
import { useSummonSignal, overlapsLostWindow, type LostWindow } from '../hooks/useSummonSignal';
import { useCompositeMeetingStream } from '../hooks/useCompositeMeetingStream';
import { useRecordingControl } from '../hooks/useRecordingControl';
import { useSakuraStart } from '../hooks/useSakuraStart';
import type { MeetingId } from '../hooks/useMeetingRecorder';
import { speakerDisplay } from '../lib/speakerDisplay';
import { meetingDisplayName } from '../lib/meetingLabels';

type RoomSession = { token: string; url: string; room: string; identity: string; name?: string };

const MAX_EVENTS = 200;
const AT_BOTTOM_THRESHOLD = 30;
const CATCHUP_START_MARGIN_MS = 1000;
const READY_WAIT_MS = 15000;
// テスト用の呼びかけボタンを表示するか（本番実験時は false）
const SHOW_TEST_SUMMON_BUTTONS = true;
// 録画動画サクラ（/sakura）4人全員の ready が揃うまで開始ボタンを押せなくするか
// （生声サクラで実験する場合は false）
const REQUIRE_RECORDED_SAKURA_READY = true;

const headingStyle: React.CSSProperties = {
  flex: '1 1 0',
  minWidth: 0,
  padding: '8px 12px',
  fontSize: 16,
  fontWeight: 700,
  color: '#eee',
  textAlign: 'center',
  background: '#1a1a1a',
  borderBottom: '1px solid #555',
  boxSizing: 'border-box',
};

const roomFrameStyle: React.CSSProperties = {
  flex: '1 1 0',
  minWidth: 0,
  border: '2px solid #555',
  boxSizing: 'border-box',
};

// Mirrors TranscriptPanel.tsx's auto-scroll-to-latest / "return to latest"
// pattern: stays pinned to the bottom as new entries arrive, but stops
// auto-scrolling as soon as the user scrolls away from the bottom, until
// they explicitly ask to jump back.
//
// The column deliberately does NOT move itself to show lost-window lines.
// An earlier version scrolled back to the first missed line when a summon
// landed; following the live tail at all times turned out to read far
// better, and the highlight alone is enough to pick the missed lines out.
// Scrolling back through them is a manual act, and "最新へ戻る" exists only
// to undo it.
const SubtitleColumn: React.FC<{
  entries: SubtitleEntry[];
  lostWindows: LostWindow[];
  /** Footage this room's 2x catch-up is currently playing through, or null. */
  catchupWindow: { startEpochMs: number; endEpochMs: number } | null;
  borderRight?: boolean;
}> = ({ entries, lostWindows, catchupWindow, borderRight }) => {
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Our own scrollTop writes fire 'scroll' just like a user gesture would;
  // without this guard they can be misread as "the user scrolled away".
  const programmaticScrollUntilRef = useRef(0);

  // Highlighting is derived here, on every render, from the immutable
  // window history — never stamped onto entries when a window is created.
  // That is what makes late-arriving subtitles light up on their own and
  // keeps past windows highlighted when scrolling back through history.
  //
  // The catch-up highlight uses the same whole-line overlap rule, and yields
  // to the lost highlight: a line in both shows as lost.
  //
  // The window start is widened by CATCHUP_START_MARGIN_MS so the line that
  // was being spoken at the moment of the focus switch is included in full:
  // speech times and media positions skew by up to ~1s, which otherwise lets
  // that line (or the one just before a silence) fall just outside the range.
  const rows = entries.map((entry) => {
    const lost = overlapsLostWindow(entry, lostWindows);
    const catchingUp =
      !lost &&
      catchupWindow !== null &&
      entry.speechStartEpochMs <= catchupWindow.endEpochMs &&
      entry.speechEndEpochMs >= catchupWindow.startEpochMs - CATCHUP_START_MARGIN_MS;
    return { entry, highlighted: lost, catchingUp };
  });

  const scrollToLatest = (el: HTMLDivElement) => {
    programmaticScrollUntilRef.current = Date.now() + 200;
    el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!autoScroll || !el) return;
    scrollToLatest(el);
  }, [entries, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (Date.now() < programmaticScrollUntilRef.current) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD;
    setAutoScroll(atBottom);
  }, []);

  const returnToLatest = () => {
    setAutoScroll(true);
    const el = scrollRef.current;
    if (el) scrollToLatest(el);
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
        {rows.map(({ entry: s, highlighted, catchingUp }) => {
          const { label, color } = speakerDisplay(s.participant);
          return (
            <div
              key={s.id}
              // Every row reserves the same 3px border + 5px padding, so the
              // text's left edge never shifts with the highlight.
              style={{
                borderLeft: `3px solid ${
                  highlighted ? '#ff9800' : catchingUp ? '#9e9e9e' : 'transparent'
                }`,
                paddingLeft: 5,
                background: highlighted
                  ? 'rgba(255,152,0,0.18)'
                  : catchingUp
                    ? 'rgba(158,158,158,0.22)'
                    : undefined,
              }}
            >
              <span style={{ color, marginRight: 6, fontWeight: 600 }}>{label}</span>
              <span style={{ color: '#fff' }}>{s.text}</span>
            </div>
          );
        })}
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
  const [sakuraTracksA, setSakuraTracksA] = useState<SakuraTrack[]>([]);
  const [sakuraTracksB, setSakuraTracksB] = useState<SakuraTrack[]>([]);
  const [roomA, setRoomA] = useState<Room | null>(null);
  const [roomB, setRoomB] = useState<Room | null>(null);
  const [started, setStarted] = useState(false);
  // 開始ボタンは、両ルームにサクラが揃ってから READY_WAIT_MS 経過するまで押せない。
  // 録画バッファが溜まり、交互倍速の初期(1倍速warmup)区間も過ぎた状態で始めるため。
  const [ready, setReady] = useState(false);
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [debugOpen] = useState(false);

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

  const sakuraPresent = sakuraTracksA.length > 0 && sakuraTracksB.length > 0;
  useEffect(() => {
    if (!sakuraPresent || ready) return;
    const id = window.setTimeout(() => setReady(true), READY_WAIT_MS);
    return () => window.clearTimeout(id);
  }, [sakuraPresent, ready]);

  const onDebugEvent = useCallback((e: DebugEvent) => {
    setEvents((prev) => {
      const next = [...prev, e];
      return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
    });
  }, []);

  // "Where in wall-clock time is the footage currently on screen for this
  // meeting?" — the bridge that lets a summon be turned into a lost window
  // measured on the same clock the subtitles carry.
  const getPlaybackEpochMs = useCallback(
    (meeting: MeetingId) => controllerRef.current?.getPlaybackEpochMs(meeting) ?? null,
    [],
  );

  // Footage the focused room's 2x catch-up is playing through: from where it
  // was seeked to at the focus switch, out to the newest buffered frame. The
  // start is fixed for the whole turn; the end is re-polled so lines landing
  // (or footage buffering) mid-turn are included. Cleared when focus moves on.
  const [catchup, setCatchup] = useState<CatchupStart>(null);
  const [catchupEndEpochMs, setCatchupEndEpochMs] = useState<number | null>(null);
  useEffect(() => {
    if (!catchup) {
      setCatchupEndEpochMs(null);
      return;
    }
    const update = () =>
      setCatchupEndEpochMs(controllerRef.current?.getLiveEdgeEpochMs(catchup.meeting) ?? null);
    update();
    const interval = window.setInterval(update, 500);
    return () => window.clearInterval(interval);
  }, [catchup]);
  // Hidden (not cleared) for the whole realtime response: the catch-up state
  // above keeps running underneath, so the highlight reappears on its own the
  // moment the response ends, if that turn is still playing.
  const catchupWindowFor = (meeting: MeetingId) =>
    summonedRoom === null && catchup && catchup.meeting === meeting && catchupEndEpochMs !== null
      ? { startEpochMs: catchup.startEpochMs, endEpochMs: catchupEndEpochMs }
      : null;

  const { visible: subtitles } = useSubtitleSync({ roomA, roomB });
  const {
    summonedRoom,
    lostWindows,
    clear: clearSummon,
    trigger: triggerSummon,
    markRealtimeReached,
  } = useSummonSignal({ roomA, roomB, getPlaybackEpochMs, enabled: started });
  const { start: startRecording, state: recordingState } = useRecordingControl({ roomA, roomB });
  const { allReady: sakuraAllReady, sendStart: sendSakuraStart } = useSakuraStart({ roomA, roomB });
  const startable = ready && (!REQUIRE_RECORDED_SAKURA_READY || sakuraAllReady);
  const { videoTrack: trackA, audioTrack: audioTrackA } = useCompositeMeetingStream(
    sakuraTracksA,
    'A',
  );
  const { videoTrack: trackB, audioTrack: audioTrackB } = useCompositeMeetingStream(
    sakuraTracksB,
    'B',
  );

  // Silences *both* cycling <video> elements for the duration of a response.
  // The user is holding a live conversation over the RealtimeOverlay; 2x
  // catch-up audio from either meeting underneath — the summoned one or the
  // other — is noise on that call, not something they can follow anyway.
  // Restored the instant summonedRoom goes back to null. Touches nothing but
  // el.muted: playback rate, scheduling and catch-up all keep running, so
  // the footage still rolls past exactly as the lost-window bookkeeping in
  // useSummonSignal assumes.
  useEffect(() => {
    const responding = summonedRoom !== null;
    (['A', 'B'] as MeetingId[]).forEach((m) => {
      controllerRef.current?.setMuted(m, responding);
    });
  }, [summonedRoom]);

  // Both LiveKitRoom connections are mounted with audio={false} — the local
  // mic is never published by default (the 同時参加者 normally just watches
  // both meetings). While summoned, publish the mic to *only* that room so
  // サクラ actually hear the response; the other room's mic stays off so the
  // user's voice never leaks into the meeting they're not addressing.
  useEffect(() => {
    roomA?.localParticipant.setMicrophoneEnabled(summonedRoom === 'A').catch((e) => {
      console.error('[comma-debug] setMicrophoneEnabled(A) failed', e);
    });
    roomB?.localParticipant.setMicrophoneEnabled(summonedRoom === 'B').catch((e) => {
      console.error('[comma-debug] setMicrophoneEnabled(B) failed', e);
    });
  }, [summonedRoom, roomA, roomB]);

  if (!sessions) {
    return <div style={{ padding: 24 }}>Loading...</div>;
  }

  const sessionA = sessions[0];
  const sessionB = sessions[1];
  const subtitlesA = subtitles.filter((s) => s.room === 'A');
  const subtitlesB = subtitles.filter((s) => s.room === 'B');
  const lostWindowsA = lostWindows.filter((w) => w.room === 'A');
  const lostWindowsB = lostWindows.filter((w) => w.room === 'B');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#000' }}>
      <div style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, position: 'relative' }}>
        <button onClick={() => navigate('/')} style={{ padding: '6px 10px' }}>
          戻る
        </button>
        <div style={{ color: '#ccc' }}>あなた：田中さん</div>
        <button
          onClick={() => {
            // Call synchronously from this click handler (not from an effect)
            // so the browser's unmuted-autoplay policy sees a direct user
            // gesture before comma playback (with audio) actually starts.
            controllerRef.current?.unlockPlayback();
            sendSakuraStart();
            setStarted(true);
            startRecording();
          }}
          disabled={started || !startable}
          className={startable && !started ? 'comma-start-pulse' : undefined}
          style={{ padding: '6px 10px' }}
        >
          {startable || started ? '開始' : '準備中…'}
        </button>
        {/* Experiment audio recording (agent side) acknowledgement per room. */}
        {started && <RecordingBadges state={recordingState} />}
        {/* Always rendered and always horizontally centred (absolute, so the
            variable-width left/right groups never shift it). Inactive exactly
            like 開始 while not responding; active + blinking orange (light
            ⇄ dark, see .comma-responding-pulse in index.css) while a summon
            is being answered. */}
        <button
          onClick={clearSummon}
          disabled={!summonedRoom}
          className={summonedRoom ? 'comma-responding-pulse' : undefined}
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '6px 10px',
            fontWeight: 600,
            // Explicit bg/color is required here, so the browser's own
            // disabled-greying (which the plain 開始 button relies on) never
            // kicks in — spell both states out by hand instead.
            background: summonedRoom ? '#ff9800' : '#3a3a3a',
            color: summonedRoom ? '#000' : '#777',
            border: summonedRoom ? '1px solid #ff9800' : '1px solid #555',
            cursor: summonedRoom ? 'pointer' : 'default',
          }}
        >
          応答終了{summonedRoom ? `（${meetingDisplayName(summonedRoom)}）` : ''}
        </button>
        {/* Legend for the subtitle highlights; swatches mirror the real row
            styles in SubtitleColumn. Pushed to the right edge. */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 20, color: '#ccc', fontSize: 13 }}>
          {[
            { label: '再生中区間', background: 'rgba(158,158,158,0.22)', border: '#9e9e9e' },
            { label: '消失区間', background: 'rgba(255,152,0,0.18)', border: '#ff9800' },
          ].map((item) => (
            <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  display: 'inline-block',
                  width: 24,
                  height: 14,
                  background: item.background,
                  borderLeft: `3px solid ${item.border}`,
                  boxSizing: 'border-box',
                }}
              />
              {item.label}
            </div>
          ))}
        </div>
        {/* Debug buttons: SHOW_TEST_SUMMON_BUTTONS で表示切替 */}
        {SHOW_TEST_SUMMON_BUTTONS && (
          <>
            <button onClick={() => triggerSummon('A')} disabled={!!summonedRoom} style={{ padding: '6px 10px' }}>
              test : {meetingDisplayName('A')}呼びかけ
            </button>
            <button onClick={() => triggerSummon('B')} disabled={!!summonedRoom} style={{ padding: '6px 10px' }}>
              test : {meetingDisplayName('B')}呼びかけ
            </button>
          </>
        )}
        {/* <button onClick={() => setDebugOpen((v) => !v)} style={{ padding: '6px 10px' }}>
          {debugOpen ? 'デバッグ情報を閉じる ▲' : 'デバッグ情報 ▼'}
        </button> */}
      </div>

      {/* Hidden LiveKitRoom connections — only used to obtain the remote camera/mic MediaStreamTrack + Room */}
      <div style={{ display: 'none' }}>
        <LiveKitRoom serverUrl={sessionA.url} token={sessionA.token} connect video audio={false}>
          <CommaTrackBridge onTracks={setSakuraTracksA} onRoom={setRoomA} />
        </LiveKitRoom>
        <LiveKitRoom serverUrl={sessionB.url} token={sessionB.token} connect video audio={false}>
          <CommaTrackBridge onTracks={setSakuraTracksB} onRoom={setRoomB} />
        </LiveKitRoom>
      </div>

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
        {/* Wraps the heading + video + subtitle rows for both rooms, so a
            single absolute frame overlay below can draw one continuous
            border around each room's whole column (heading through
            subtitles) without having to touch PlaybackController's or
            SubtitleColumn's own internals — every row here splits 50/50 via
            `flex: 1`, so the frame halves line up with all three rows. */}
        <div
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', width: '100%', flexShrink: 0 }}>
            <div style={headingStyle}>{meetingDisplayName('A')}</div>
            <div style={headingStyle}>{meetingDisplayName('B')}</div>
          </div>

          {/* Video row height is pinned to the footage's own aspect ratio
              instead of `flex: 1`, so there is no tall black letterbox band
              above/below the two 倍速 panels and the subtitle area can start
              right under the visible frame. Each room's composite stream is a
              640x180 canvas (2 × 320x180 cells, see useCompositeMeetingStream),
              i.e. 32:9 per panel; two panels side by side ⇒ the row itself is
              64:9. The RealtimeOverlay during 応答 is absolutely positioned to
              `inset: 0` of this same box, so its height/scale never changes
              relative to the 倍速 view. */}
          <div
            style={{
              position: 'relative',
              display: 'flex',
              width: '100%',
              aspectRatio: '64 / 9',
              maxHeight: '68vh',
              flexShrink: 0,
              overflow: 'hidden',
            }}
          >
            <PlaybackController
              ref={controllerRef}
              trackA={trackA}
              trackB={trackB}
              audioTrackA={audioTrackA}
              audioTrackB={audioTrackB}
              started={started}
              onDebugEvent={onDebugEvent}
              onCatchupChange={setCatchup}
            />
            {/* Overlaid on top of (never replacing) PlaybackController's own
                A/B panels below, which keep cycling untouched underneath. */}
            <div style={{ position: 'absolute', inset: 0, display: 'flex', pointerEvents: 'none' }}>
              <div style={{ flex: '1 1 0', minWidth: 0, position: 'relative', overflow: 'hidden' }}>
                {summonedRoom === 'A' && (
                  <RealtimeOverlay tracks={sakuraTracksA} onLive={() => markRealtimeReached('A')} />
                )}
              </div>
              <div style={{ flex: '1 1 0', minWidth: 0, position: 'relative', overflow: 'hidden' }}>
                {summonedRoom === 'B' && (
                  <RealtimeOverlay tracks={sakuraTracksB} onLive={() => markRealtimeReached('B')} />
                )}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flex: 1, minHeight: 120, flexShrink: 1 }}>
            <SubtitleColumn
              entries={subtitlesA}
              lostWindows={lostWindowsA}
              catchupWindow={catchupWindowFor('A')}
            />
            <SubtitleColumn
              entries={subtitlesB}
              lostWindows={lostWindowsB}
              catchupWindow={catchupWindowFor('B')}
            />
          </div>

          {/* Frame overlay: draws the border around each room's whole column
              (heading through subtitles). Purely visual — pointerEvents:none
              so it never intercepts clicks on SubtitleColumn's own
              「最新へ戻る」 button underneath. */}
          <div style={{ position: 'absolute', inset: 0, display: 'flex', pointerEvents: 'none' }}>
            <div style={roomFrameStyle} />
            <div style={roomFrameStyle} />
          </div>
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
            <DebugReadout controllerRef={controllerRef} events={events} lostWindows={lostWindows} />
          </div>
        )}
      </div>
    </div>
  );
};

export default CommaDebug;
