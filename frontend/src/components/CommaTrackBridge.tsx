import { useCallback, useEffect, useRef } from 'react';
import { useTracks, useRoomContext } from '@livekit/components-react';
import { Track, type Room } from 'livekit-client';

type Props = {
  onTrack: (track: MediaStreamTrack | null) => void;
  onAudioTrack?: (track: MediaStreamTrack | null) => void;
  onRoom?: (room: Room) => void;
};

/**
 * Lives inside a <LiveKitRoom>. Finds a remote participant's camera (and, if
 * requested, microphone) track and lifts its raw MediaStreamTrack (and the
 * Room instance) up via callbacks, so callers outside the LiveKitRoom
 * context can hand the tracks to useMeetingRecorder and the Room to
 * useSubtitleSync.
 *
 * Selection is pinned to a single remote *participant* (by identity) once
 * made, and only re-picked if that participant's tracks actually disappear
 * (unpublished/left) — `useTracks` re-derives its array on every relevant
 * RoomEvent (including frequent mic activity/level events for
 * [Camera, Microphone]), so with more than one remote participant a naive
 * `tracks.find(...)` re-run on every array change can flip between
 * different participants' tracks from poll to poll, restarting
 * useMeetingRecorder's setup before it ever completes.
 *
 * The audio publication's `track.attach()` is called on a hidden, muted
 * <audio> element before its `mediaStreamTrack` is handed out. This is not
 * optional bookkeeping: Chrome's WebRTC audio receive pipeline is
 * pull-driven — a remote audio track's MediaStreamTrack stays `readyState:
 * 'live'` but produces literally zero decoded samples until something
 * actually consumes it (an HTMLMediaElement playing it, or a
 * MediaStreamAudioSourceNode in a running AudioContext). Without this,
 * MediaRecorder sits in state 'recording' forever with no 'dataavailable'.
 * Video has no such requirement — Chrome's video receive pipeline decodes
 * continuously regardless of consumers — which is why only audio needed
 * this. The element is muted/hidden purely to activate decoding; once
 * active, the *same* MediaStreamTrack object is handed to useMeetingRecorder,
 * which now has real audio to combine with the video track for a single
 * MediaRecorder — actual audible playback happens later through that
 * recorded+synced <video> element in PlaybackController.
 */
const CommaTrackBridge: React.FC<Props> = ({ onTrack, onAudioTrack, onRoom }) => {
  const tracks = useTracks([Track.Source.Camera, Track.Source.Microphone]);
  const room = useRoomContext();
  const pinnedIdentity = useRef<string | null>(null);
  const attachedAudioSid = useRef<string | null>(null);
  const hiddenAudioElRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const remoteTracks = tracks.filter((t) => !t.participant.isLocal && t.publication?.track);
    const identities = new Set(remoteTracks.map((t) => t.participant.identity));
    const identity = identities.has(pinnedIdentity.current ?? '')
      ? pinnedIdentity.current
      : (remoteTracks[0]?.participant.identity ?? null);
    pinnedIdentity.current = identity;

    const videoTrack = remoteTracks.find(
      (t) => t.participant.identity === identity && t.source === Track.Source.Camera,
    );
    onTrack(videoTrack?.publication?.track?.mediaStreamTrack ?? null);

    if (onAudioTrack) {
      const audioTrack = remoteTracks.find(
        (t) => t.participant.identity === identity && t.source === Track.Source.Microphone,
      );
      const publication = audioTrack?.publication;
      const sid = publication?.trackSid ?? null;
      if (sid && sid !== attachedAudioSid.current && publication?.track && hiddenAudioElRef.current) {
        attachedAudioSid.current = sid;
        publication.track.attach(hiddenAudioElRef.current);
        // attach() may reassign srcObject/play() internally; (re-)assert mute
        // afterward so we never audibly leak this raw real-time audio — see
        // the imperative-mute note on the ref callback below for why the
        // JSX `muted` attribute alone isn't reliable enough here.
        hiddenAudioElRef.current.muted = true;
        hiddenAudioElRef.current.volume = 0;
        console.log('[CommaTrackBridge] attached audio track to kick-start decoding', sid);
      }
      onAudioTrack(publication?.track?.mediaStreamTrack ?? null);
    }
  }, [tracks, onTrack, onAudioTrack]);

  useEffect(() => {
    onRoom?.(room);
  }, [room, onRoom]);

  // React's `muted` JSX attribute on <audio>/<video> does not reliably set
  // the underlying IDL property (a known React/DOM quirk — same reason
  // preservesPitch is set imperatively elsewhere in this codebase), so this
  // element — whose only job is to silently kick-start Chrome's audio
  // decode pipeline, never to be audible — must be muted imperatively.
  const attachHiddenAudio = useCallback((el: HTMLAudioElement | null) => {
    hiddenAudioElRef.current = el;
    if (el) {
      el.muted = true;
      el.volume = 0;
    }
  }, []);

  return <audio ref={attachHiddenAudio} style={{ display: 'none' }} />;
};

export default CommaTrackBridge;
