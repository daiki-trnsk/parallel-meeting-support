import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '@livekit/components-styles';
import { LiveKitRoom } from '@livekit/components-react';
import type { Room } from 'livekit-client';
import CommaTrackBridge, { type SakuraTrack } from '../components/CommaTrackBridge';
import PlaybackController, {
  type PlaybackControllerHandle,
  type DebugEvent,
} from '../components/PlaybackController';
import DebugReadout from '../components/DebugReadout';
import RealtimeOverlay from '../components/RealtimeOverlay';
import { useSubtitleSync, type SubtitleEntry } from '../hooks/useSubtitleSync';
import { useSummonSignal, overlapsLostWindow, type LostWindow } from '../hooks/useSummonSignal';
import { useCompositeMeetingStream } from '../hooks/useCompositeMeetingStream';
import type { MeetingId } from '../hooks/useMeetingRecorder';
import { speakerDisplay } from '../lib/speakerDisplay';
import { meetingDisplayName } from '../lib/meetingLabels';

type RoomSession = { token: string; url: string; room: string; identity: string; name?: string };

const MAX_EVENTS = 200;
const AT_BOTTOM_THRESHOLD = 30;

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
  borderRight?: boolean;
}> = ({ entries, lostWindows, borderRight }) => {
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Our own scrollTop writes fire 'scroll' just like a user gesture would;
  // without this guard they can be misread as "the user scrolled away".
  const programmaticScrollUntilRef = useRef(0);

  // Highlighting is derived here, on every render, from the immutable
  // window history — never stamped onto entries when a window is created.
  // That is what makes late-arriving subtitles light up on their own and
  // keeps past windows highlighted when scrolling back through history.
  const rows = entries.map((entry) => ({
    entry,
    highlighted: overlapsLostWindow(entry, lostWindows),
  }));

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
        {rows.map(({ entry: s, highlighted }) => {
          const { label, color } = speakerDisplay(s.participant);
          return (
            <div
              key={s.id}
              style={
                highlighted
                  ? { background: 'rgba(255,152,0,0.18)', borderLeft: '3px solid #ff9800', paddingLeft: 5 }
                  : undefined
              }
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
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);

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

  const { visible: subtitles } = useSubtitleSync({ roomA, roomB });
  const {
    summonedRoom,
    lostWindows,
    clear: clearSummon,
    trigger: triggerSummon,
    markRealtimeReached,
  } = useSummonSignal({ roomA, roomB, getPlaybackEpochMs });
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
            setStarted(true);
          }}
          disabled={started || sakuraTracksA.length === 0 || sakuraTracksB.length === 0}
          style={{ padding: '6px 10px' }}
        >
          開始
        </button>
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
        {/* Debug buttons 普段は非表示 */}
        {/* <button
          onClick={() => triggerSummon('A')}
          disabled={!!summonedRoom}
          style={{ padding: '6px 10px', marginLeft: 'auto' }}
        >
          test : {meetingDisplayName('A')}呼びかけ
        </button>
        <button onClick={() => triggerSummon('B')} disabled={!!summonedRoom} style={{ padding: '6px 10px' }}>
          test : {meetingDisplayName('B')}呼びかけ
        </button> */}
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
              640x240 canvas (2 × 320x240 cells, see useCompositeMeetingStream),
              i.e. 8:3 per panel; two panels side by side ⇒ the row itself is
              16:3. The RealtimeOverlay during 応答 is absolutely positioned to
              `inset: 0` of this same box, so its height/scale never changes
              relative to the 倍速 view. */}
          <div
            style={{
              position: 'relative',
              display: 'flex',
              width: '100%',
              aspectRatio: '16 / 3',
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
            <SubtitleColumn entries={subtitlesA} lostWindows={lostWindowsA} />
            <SubtitleColumn entries={subtitlesB} lostWindows={lostWindowsB} />
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
