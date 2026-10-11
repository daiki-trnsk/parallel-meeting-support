import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '@livekit/components-styles';
import {
  LiveKitRoom,
  ParticipantPlaceholder,
  ParticipantTile,
  RoomAudioRenderer,
  VideoConference,
  VideoTrack,
  isTrackReference,
  useTracks,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import TranscriptPanel from '../components/TranscriptPanel';
import MicToggleButton from '../components/MicToggleButton';
import { roomDisplayName } from '../lib/meetingLabels';
import { SPEAKER_DISPLAY, participantTileLabel } from '../lib/speakerDisplay';

const MAX_TILES = 4;

type TrackSlot = ReturnType<typeof useTracks>[number];

/**
 * One cell of SakuraMeetingView's fixed 2x2 grid. Deliberately bypasses
 * ParticipantTile's own default content (which would show LiveKit's own
 * ParticipantName, i.e. the raw identity like "participant-a") — children
 * given to ParticipantTile replace that default entirely, so only our own
 * video + name label render. Label text is always plain white here: this
 * screen is サクラ's own, and the lettered/colored name styling used on the
 * 同時参加者's screens (speakerDisplay's per-identity colors) isn't needed.
 */
const SakuraParticipantTile: React.FC<{ trackRef: TrackSlot }> = ({ trackRef }) => {
  const label = participantTileLabel(trackRef.participant.identity);
  return (
    <ParticipantTile trackRef={trackRef} disableSpeakingIndicator style={{ height: '100%', width: '100%' }}>
      {isTrackReference(trackRef) ? <VideoTrack trackRef={trackRef} /> : <ParticipantPlaceholder />}
      <div
        style={{
          position: 'absolute',
          left: 6,
          bottom: 6,
          height: 20,
          lineHeight: '20px',
          padding: '0 6px',
          fontSize: 14,
          fontFamily: 'sans-serif',
          color: '#fff',
          background: 'rgba(0,0,0,0.55)',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
    </ParticipantTile>
  );
};

/**
 * サクラ's own single-room meeting view. Deliberately not VideoConference:
 * that component bundles its own ControlBar (camera/chat/screen-share/leave
 * controls) which this screen has no use for — サクラ only ever needs to
 * mute/unmute themselves, so a fixed grid + MicToggleButton is composed
 * directly instead. RoomAudioRenderer is required here since VideoConference
 * normally supplies it implicitly.
 *
 * Always a fixed 2x2 grid of MAX_TILES equal-size cells — never LiveKit's
 * own GridLayout, which reflows cell size/count with the number of
 * participants (1 tile fills the whole area, 3 goes 2-over-1, etc.) and
 * resizes cells to fit each video's own aspect ratio. Here an empty slot
 * just stays blank, so neither participant count nor any one video's own
 * dimensions ever change the size of the others.
 */
const SakuraMeetingView: React.FC = () => {
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare]);
  const slots: (TrackSlot | undefined)[] = Array.from({ length: MAX_TILES }, (_, i) => tracks[i]);
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Outer box centers the grid and gives it room to shrink on either
          axis; the grid itself is the thing with a fixed aspect-ratio
          (standard 4:3 webcam ratio), so resizing the window/display only
          scales the whole 2x2 block uniformly — it never changes the
          proportions of any individual cell the way `flex:1` sizing (width
          from the row, height from the column, independently) did before. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          background: '#000',
        }}
      >
        <div
          style={{
            width: 'auto',
            height: 'auto',
            maxWidth: '100%',
            maxHeight: '100%',
            aspectRatio: '4 / 3',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gridTemplateRows: '1fr 1fr',
            gap: 2,
            background: '#000',
          }}
        >
          {slots.map((trackRef, i) => (
            <div key={i} style={{ position: 'relative', overflow: 'hidden', background: '#000' }}>
              {trackRef && <SakuraParticipantTile trackRef={trackRef} />}
            </div>
          ))}
        </div>
      </div>
      <RoomAudioRenderer />
      <div style={{ display: 'flex', justifyContent: 'center', padding: 12, flexShrink: 0 }}>
        <MicToggleButton />
      </div>
    </div>
  );
};

type RoomSession = { token: string; url: string; room: string; identity: string; name?: string };

const Meeting: React.FC = () => {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<RoomSession[] | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem('livekit_session');
    if (!raw) {
      navigate('/');
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const list: RoomSession[] = Array.isArray(parsed) ? parsed : [parsed];
      if (list.length === 0) throw new Error('empty');
      setSessions(list);
    } catch (e) {
      sessionStorage.removeItem('livekit_session');
      navigate('/');
    }
  }, [navigate]);

  if (!sessions) {
    return <div style={{ padding: 24 }}>Loading...</div>;
  }

  // サクラ identities (participant-a..d) show as "あなた：Aさん" etc., so the
  // performer can see at a glance which lettered label the 同時参加者's
  // screens show them under. Any other identity keeps the old raw display.
  const selfSpeaker = SPEAKER_DISPLAY[sessions[0].identity];
  const displayName = selfSpeaker ? `あなた：${selfSpeaker.label}` : sessions[0].name ?? sessions[0].identity;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button onClick={() => navigate('/')} style={{ padding: '6px 10px' }}>
          戻る
        </button>
        <div>{displayName}</div>
      </div>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {sessions.map((s, i) => (
          <div
            key={s.room}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              borderLeft: i > 0 ? '2px solid #444' : undefined,
              overflow: 'hidden',
            }}
          >
            {sessions.length > 1 && (
              <div
                style={{
                  padding: '2px 8px',
                  fontSize: 12,
                  background: '#222',
                  color: '#aaa',
                  flexShrink: 0,
                }}
              >
                {roomDisplayName(s.room)}
              </div>
            )}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {sessions.length > 1 ? (
                <LiveKitRoom
                  serverUrl={s.url}
                  token={s.token}
                  connect={true}
                  video
                  audio
                  style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
                >
                  {/* auto (not hidden): LiveKit's own grid layout needs more
                      height than this box has as participant count changes
                      (1 vs 3 tiles, etc.) — with `hidden` that extra height
                      was silently clipped, hiding the mic/camera control bar
                      that sits at the bottom of VideoConference's own layout.
                      `auto` keeps the control bar reachable via scroll
                      instead of clipping it away. */}
                  <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                    <VideoConference />
                  </div>
                  <TranscriptPanel roomLabel={roomDisplayName(s.room)} />
                </LiveKitRoom>
              ) : (
                <LiveKitRoom
                  serverUrl={s.url}
                  token={s.token}
                  connect={true}
                  video
                  audio
                  style={{ height: '100%', overflow: 'auto' }}
                >
                  <SakuraMeetingView />
                </LiveKitRoom>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Meeting;
