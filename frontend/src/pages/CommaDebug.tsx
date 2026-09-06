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
import {
  useSummonSignal,
  overlapsLostWindow,
  overlapsOneLostWindow,
  type LostWindow,
} from '../hooks/useSummonSignal';
import { useCompositeMeetingStream } from '../hooks/useCompositeMeetingStream';
import type { MeetingId } from '../hooks/useMeetingRecorder';

type RoomSession = { token: string; url: string; room: string; identity: string; name?: string };

const MAX_EVENTS = 200;
const AT_BOTTOM_THRESHOLD = 30;

// Mirrors TranscriptPanel.tsx's auto-scroll-to-latest / "return to latest"
// pattern: stays pinned to the bottom as new entries arrive, but stops
// auto-scrolling as soon as the user scrolls away from the bottom, until
// they explicitly ask to jump back.
//
// One addition: when a lost window appears for this room, the column pins
// that window's *first* line to the top instead of the bottom, so the
// question the user is about to answer cannot be pushed off-screen by
// whatever arrives next. Lines below it — including lost subtitles that
// land a second or two late — still flow in underneath.
//
// The pin deliberately follows only the newest window. Anchoring on "the
// first highlighted line" instead would drag the column back to a summon
// from minutes ago as soon as a second one happened, and "最新へ戻る"
// could never escape it: flipping autoScroll back on just re-ran the pin.
const SubtitleColumn: React.FC<{
  entries: SubtitleEntry[];
  lostWindows: LostWindow[];
  borderRight?: boolean;
}> = ({ entries, lostWindows, borderRight }) => {
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const entryElRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Our own scrollTop writes fire 'scroll' just like a user gesture would.
  // Without this guard, pinning to a lost window immediately looked like
  // "user scrolled away from the bottom" and switched autoScroll off,
  // leaving the column fighting itself.
  const programmaticScrollUntilRef = useRef(0);

  const latestWindowId = lostWindows.length > 0 ? lostWindows[lostWindows.length - 1].id : null;

  // Arm the pin on each *new* window, adjusting state during render (the
  // documented React pattern) rather than from an effect, so there is no
  // extra commit and no cascading-render lint violation.
  const [seenWindowId, setSeenWindowId] = useState<string | null>(latestWindowId);
  const [pinnedWindowId, setPinnedWindowId] = useState<string | null>(null);
  if (latestWindowId !== seenWindowId) {
    setSeenWindowId(latestWindowId);
    setPinnedWindowId(latestWindowId);
    // A summon just cost this room some footage — override any manual
    // scroll so the missed lines are actually on screen.
    setAutoScroll(true);
  }

  // Highlighting is derived here, on every render, from the immutable
  // window history — never stamped onto entries when a window is created.
  // That is what makes late-arriving subtitles light up on their own and
  // keeps past windows highlighted when scrolling back through history.
  const rows = entries.map((entry) => ({
    entry,
    highlighted: overlapsLostWindow(entry, lostWindows),
  }));

  const pinnedWindow = pinnedWindowId
    ? (lostWindows.find((w) => w.id === pinnedWindowId) ?? null)
    : null;
  const anchorEntryId = pinnedWindow
    ? (entries.find((e) => overlapsOneLostWindow(e, pinnedWindow))?.id ?? null)
    : null;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const anchorEl = anchorEntryId ? entryElRefs.current.get(anchorEntryId) : undefined;
    if (anchorEl) {
      // Pinned: hold this position and make sure the first missed line is on
      // screen — but move as little as possible to get it there. Yanking it
      // to the top of the column is what made the list look like it had
      // "jumped into the past"; usually it is already visible and the right
      // amount of scrolling is none at all.
      //
      // offsetTop is a position *within the scrolled content* only because
      // the scroll container is itself positioned (see position:'relative'
      // below); otherwise it would be measured from a far ancestor and land
      // nowhere near the intended line.
      const top = anchorEl.offsetTop;
      const bottom = top + anchorEl.offsetHeight;
      let target: number | null = null;
      if (top < el.scrollTop) target = top;
      else if (bottom > el.scrollTop + el.clientHeight) target = bottom - el.clientHeight;
      if (target !== null) {
        programmaticScrollUntilRef.current = Date.now() + 200;
        el.scrollTop = target;
      }
      return;
    }

    if (!autoScroll) return;
    const bottom = el.scrollHeight - el.clientHeight;
    if (Math.abs(el.scrollTop - bottom) < 1) return;
    programmaticScrollUntilRef.current = Date.now() + 200;
    el.scrollTop = el.scrollHeight;
  }, [entries, autoScroll, anchorEntryId, lostWindows]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (Date.now() < programmaticScrollUntilRef.current) return;
    // A real scroll gesture always wins: it releases the lost-window pin as
    // well as bottom-following, so the user can never be dragged back to a
    // position they just scrolled away from.
    setPinnedWindowId(null);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD;
    setAutoScroll(atBottom);
  }, []);

  // Releasing the pin is the part that makes this button actually work:
  // turning autoScroll back on alone just re-ran the pin and bounced the
  // column straight back to the lost window.
  const returnToLatest = () => {
    setPinnedWindowId(null);
    setAutoScroll(true);
    const el = scrollRef.current;
    if (el) {
      programmaticScrollUntilRef.current = Date.now() + 200;
      el.scrollTop = el.scrollHeight;
    }
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
        style={{
          flex: 1,
          overflowY: 'auto',
          // Makes this the offsetParent of the entry rows, so their
          // offsetTop is a scroll position in this list and nothing else.
          position: 'relative',
          padding: 8,
          color: '#ddd',
          fontSize: 13,
          textAlign: 'left',
        }}
      >
        {rows.map(({ entry: s, highlighted }) => {
          return (
            <div
              key={s.id}
              ref={(el) => {
                if (el) entryElRefs.current.set(s.id, el);
                else entryElRefs.current.delete(s.id);
              }}
              style={
                highlighted
                  ? { background: 'rgba(255,152,0,0.18)', borderLeft: '3px solid #ff9800', paddingLeft: 5 }
                  : undefined
              }
            >
              <span style={{ color: '#7aabff', marginRight: 6, fontWeight: 600 }}>{s.participant}</span>
              <span>{s.text}</span>
            </div>
          );
        })}
      </div>
      {(!autoScroll || pinnedWindowId !== null) && (
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

  // Mutes only the underlying <video> for the summoned meeting so its cycling
  // audio doesn't overlap the RealtimeOverlay's own live audio. Does not
  // touch PlaybackController's scheduling/catch-up logic in any way.
  useEffect(() => {
    (['A', 'B'] as MeetingId[]).forEach((m) => {
      controllerRef.current?.setMuted(m, summonedRoom === m);
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
      <div style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button onClick={() => navigate('/')} style={{ padding: '6px 10px' }}>
          戻る
        </button>
        <div style={{ color: '#ccc' }}>コマ単位バッファ追いつき倍速再生 — デバッグ</div>
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
        {summonedRoom && (
          <button
            onClick={clearSummon}
            style={{ padding: '6px 10px', background: '#ff9800', color: '#000', fontWeight: 600 }}
          >
            応答終了（{summonedRoom}）
          </button>
        )}
        <button onClick={() => triggerSummon('A')} disabled={!!summonedRoom} style={{ padding: '6px 10px' }}>
          テスト: Aを呼びかけ
        </button>
        <button onClick={() => triggerSummon('B')} disabled={!!summonedRoom} style={{ padding: '6px 10px' }}>
          テスト: Bを呼びかけ
        </button>
        <button onClick={() => setDebugOpen((v) => !v)} style={{ padding: '6px 10px', marginLeft: 'auto' }}>
          {debugOpen ? 'デバッグ情報を閉じる ▲' : 'デバッグ情報 ▼'}
        </button>
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
        <div style={{ position: 'relative', display: 'flex', flex: 1, overflow: 'hidden' }}>
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

        <div style={{ display: 'flex', height: 140, flexShrink: 0, borderTop: '1px solid #333' }}>
          <SubtitleColumn entries={subtitlesA} lostWindows={lostWindowsA} borderRight />
          <SubtitleColumn entries={subtitlesB} lostWindows={lostWindowsB} />
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
