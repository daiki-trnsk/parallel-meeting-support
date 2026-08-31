import { useEffect, useMemo, useRef } from 'react';
import { useTracks, useRoomContext } from '@livekit/components-react';
import { Track, type Room } from 'livekit-client';

export const MAX_SAKURA_PER_ROOM = 2;

export type SakuraTrack = {
  identity: string;
  video: MediaStreamTrack | null;
  audio: MediaStreamTrack | null;
};

type Props = {
  onTracks: (tracks: SakuraTrack[]) => void;
  onRoom?: (room: Room) => void;
};

/**
 * Lives inside a <LiveKitRoom>. Finds up to MAX_SAKURA_PER_ROOM remote
 * participants' (サクラ) camera + microphone tracks and lifts them up via
 * callback, so callers outside the LiveKitRoom context can composite them
 * (see useCompositeMeetingStream) before handing off to useMeetingRecorder.
 *
 * The pinned identity *set* (not a single identity, as in the earlier
 * single-サクラ version) is sticky: once MAX_SAKURA_PER_ROOM identities are
 * chosen, membership only changes for slots whose participant's tracks
 * actually disappear (unpublished/left) — `useTracks` re-derives its array
 * on every relevant RoomEvent (including frequent mic activity/level events),
 * so with multiple remote participants a naive re-derivation on every array
 * change can flip which participants are selected from poll to poll,
 * restarting downstream recording/compositing before it ever completes.
 *
 * Each pinned participant's audio publication is `track.attach()`ed to its
 * own hidden, muted <audio> element to kick-start Chrome's pull-driven WebRTC
 * audio decode pipeline: a remote audio track's MediaStreamTrack stays
 * `readyState: 'live'` but produces zero decoded samples until something
 * actually consumes it (an HTMLMediaElement playing it, or a
 * MediaStreamAudioSourceNode in a running AudioContext). Video has no such
 * requirement — Chrome's video receive pipeline decodes continuously
 * regardless of consumers — which is why only audio needs this element.
 */
const CommaTrackBridge: React.FC<Props> = ({ onTracks, onRoom }) => {
  const tracks = useTracks([Track.Source.Camera, Track.Source.Microphone]);
  const room = useRoomContext();
  const pinnedIdentities = useRef<string[]>([]);
  const attachedAudioSids = useRef<Map<string, string>>(new Map());
  const hiddenAudioElRefs = useRef<(HTMLAudioElement | null)[]>(
    Array(MAX_SAKURA_PER_ROOM).fill(null),
  );

  useEffect(() => {
    const remoteTracks = tracks.filter((t) => !t.participant.isLocal && t.publication?.track);
    const identities = Array.from(new Set(remoteTracks.map((t) => t.participant.identity)));

    const stillPresent = pinnedIdentities.current.filter((id) => identities.includes(id));
    const pinned =
      stillPresent.length === MAX_SAKURA_PER_ROOM
        ? stillPresent
        : [...stillPresent, ...identities.filter((id) => !stillPresent.includes(id)).sort()].slice(
            0,
            MAX_SAKURA_PER_ROOM,
          );
    pinnedIdentities.current = pinned;

    const sakuraTracks: SakuraTrack[] = pinned.map((identity, index) => {
      const videoTrack = remoteTracks.find(
        (t) => t.participant.identity === identity && t.source === Track.Source.Camera,
      );
      const audioTrack = remoteTracks.find(
        (t) => t.participant.identity === identity && t.source === Track.Source.Microphone,
      );
      const publication = audioTrack?.publication;
      const sid = publication?.trackSid ?? null;
      const audioEl = hiddenAudioElRefs.current[index];
      if (sid && sid !== attachedAudioSids.current.get(identity) && publication?.track && audioEl) {
        attachedAudioSids.current.set(identity, sid);
        publication.track.attach(audioEl);
        // attach() may reassign srcObject/play() internally; (re-)assert mute
        // afterward so we never audibly leak this raw real-time audio — see
        // the imperative-mute note on the ref callback below for why the
        // JSX `muted` attribute alone isn't reliable enough here.
        audioEl.muted = true;
        audioEl.volume = 0;
        console.log('[CommaTrackBridge] attached audio track to kick-start decoding', identity, sid);
      }
      return {
        identity,
        video: videoTrack?.publication?.track?.mediaStreamTrack ?? null,
        audio: publication?.track?.mediaStreamTrack ?? null,
      };
    });

    onTracks(sakuraTracks);
  }, [tracks, onTracks]);

  useEffect(() => {
    onRoom?.(room);
  }, [room, onRoom]);

  // React's `muted` JSX attribute on <audio>/<video> does not reliably set
  // the underlying IDL property (a known React/DOM quirk — same reason
  // preservesPitch is set imperatively elsewhere in this codebase), so these
  // elements — whose only job is to silently kick-start Chrome's audio
  // decode pipeline, never to be audible — must be muted imperatively.
  //
  // Built once via useMemo (not inline per-render arrow functions): a new
  // function identity on every render would make React detach+reattach the
  // ref on every render, which is unnecessary churn here.
  const attachHiddenAudioCallbacks = useMemo(
    () =>
      Array.from({ length: MAX_SAKURA_PER_ROOM }, (_, i) => (el: HTMLAudioElement | null) => {
        hiddenAudioElRefs.current[i] = el;
        if (el) {
          el.muted = true;
          el.volume = 0;
        }
      }),
    [],
  );

  return (
    <>
      {attachHiddenAudioCallbacks.map((cb, i) => (
        <audio key={i} ref={cb} style={{ display: 'none' }} />
      ))}
    </>
  );
};

export default CommaTrackBridge;
