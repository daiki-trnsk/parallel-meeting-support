import { useCallback, useEffect, useRef, useState } from 'react';
import { pickSupportedMimeType } from '../lib/codec';
import { createSourceBufferQueue, type SourceBufferQueue } from '../lib/sourceBufferQueue';

export type MeetingId = 'A' | 'B';

export type RecorderState = 'idle' | 'starting' | 'recording' | 'error';

export type UseMeetingRecorderOptions = {
  timesliceMs?: number;
  maxBufferedSeconds?: number;
  evictionSafetyMarginSec?: number;
};

export type UseMeetingRecorderResult = {
  mediaRef: (el: HTMLMediaElement | null) => void;
  state: RecorderState;
  error: Error | null;
  mimeType: string | null;
  recordingStartEpochMs: number | null;
  recordingStartPerf: number | null;
  getBuffered: () => TimeRanges | null;
  requestEviction: (protectFromTimeSec: number) => void;
};

const DEFAULT_TIMESLICE_MS = 250;
const DEFAULT_MAX_BUFFERED_SECONDS = 60;
const DEFAULT_EVICTION_SAFETY_MARGIN_SEC = 5;

/**
 * Records a video track (plus, if provided, a paired audio track combined
 * into the same MediaStream) via a single MediaRecorder into a
 * MediaSource/SourceBuffer, for continuous background "DVR" playback.
 *
 * An earlier version split video and audio into two fully independent
 * MediaRecorder instances after combined recording appeared to hang
 * (recorder stuck in state 'recording', never firing 'start' or
 * 'dataavailable'). That turned out to be a red herring: the real cause was
 * that the remote audio MediaStreamTrack was never actually producing
 * decoded samples in the first place — Chrome's WebRTC audio receive
 * pipeline is pull-driven and only decodes once something consumes the
 * track (an HTMLMediaElement playing it, or a running AudioContext). Once
 * CommaTrackBridge calls `track.attach()` on the audio publication before
 * handing out its MediaStreamTrack, combined recording works fine, so video
 * and audio are back to a single recorder/MediaSource per meeting.
 */
export function useMeetingRecorder(
  track: MediaStreamTrack | null,
  audioTrack: MediaStreamTrack | null,
  meetingId: MeetingId,
  options: UseMeetingRecorderOptions = {},
): UseMeetingRecorderResult {
  const timesliceMs = options.timesliceMs ?? DEFAULT_TIMESLICE_MS;
  const maxBufferedSeconds = options.maxBufferedSeconds ?? DEFAULT_MAX_BUFFERED_SECONDS;
  const evictionSafetyMarginSec =
    options.evictionSafetyMarginSec ?? DEFAULT_EVICTION_SAFETY_MARGIN_SEC;

  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [recordingStartEpochMs, setRecordingStartEpochMs] = useState<number | null>(null);
  const [recordingStartPerf, setRecordingStartPerf] = useState<number | null>(null);

  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const queueRef = useRef<SourceBufferQueue | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const mediaElRef = useRef<HTMLMediaElement | null>(null);

  const mediaRef = useCallback((el: HTMLMediaElement | null) => {
    mediaElRef.current = el;
    if (el && mediaSourceRef.current) {
      const url = URL.createObjectURL(mediaSourceRef.current);
      objectUrlRef.current = url;
      el.src = url;
    }
  }, []);

  useEffect(() => {
    if (!track) {
      return;
    }

    let cancelled = false;
    setState('starting');
    setError(null);

    let mt = pickSupportedMimeType(!!audioTrack);
    let effectiveAudioTrack = audioTrack;
    if (!mt && audioTrack) {
      // Combined audio+video codec unsupported in this browser — degrade to
      // video-only rather than failing the whole pipeline (audio is a nice-
      // to-have; a working silent video beats no video at all).
      console.warn(
        `[useMeetingRecorder:${meetingId}] no audio+video mimeType supported, falling back to video-only`,
      );
      mt = pickSupportedMimeType(false);
      effectiveAudioTrack = null;
    }
    if (!mt) {
      setState('error');
      setError(new Error('No supported mimeType for both MediaRecorder and MediaSource'));
      return;
    }
    console.log(
      `[useMeetingRecorder:${meetingId}] using mimeType=${mt} withAudio=${!!effectiveAudioTrack}`,
    );
    setMimeType(mt);

    const mediaSource = new MediaSource();
    mediaSourceRef.current = mediaSource;

    if (mediaElRef.current) {
      const url = URL.createObjectURL(mediaSource);
      objectUrlRef.current = url;
      mediaElRef.current.src = url;
    }

    let recorder: MediaRecorder | null = null;

    const onSourceOpen = () => {
      if (cancelled) return;
      console.log(`[useMeetingRecorder:${meetingId}] sourceopen`);
      try {
        const sb = mediaSource.addSourceBuffer(mt);
        // `queue` is captured locally and used directly below so this
        // recorder's chunks always append to *this* sb/queue pair, even if
        // a second effect instance (e.g. React StrictMode's dev double-
        // invoke) overwrites the shared refs in the meantime.
        const queue = createSourceBufferQueue(sb, meetingId);
        sourceBufferRef.current = sb;
        queueRef.current = queue;

        const stream = effectiveAudioTrack
          ? new MediaStream([track, effectiveAudioTrack])
          : new MediaStream([track]);
        recorder = new MediaRecorder(stream, { mimeType: mt });
        recorderRef.current = recorder;

        recorder.ondataavailable = (ev: BlobEvent) => {
          if (cancelled || !ev.data.size) return;
          ev.data
            .arrayBuffer()
            .then((buf) => {
              if (cancelled) return;
              queue.enqueue(() => {
                if (cancelled || mediaSource.readyState !== 'open') return;
                try {
                  sb.appendBuffer(buf);
                } catch (e) {
                  console.error(`[useMeetingRecorder:${meetingId}] appendBuffer failed`, e);
                }
              });
            })
            .catch((e) => console.error(`[useMeetingRecorder:${meetingId}] arrayBuffer failed`, e));
        };

        recorder.onstart = () => {
          if (cancelled) return;
          const epochMs = Date.now();
          const perf = performance.now();
          setRecordingStartEpochMs(epochMs);
          setRecordingStartPerf(perf);
          setState('recording');
          console.log(`[useMeetingRecorder:${meetingId}] recorder started`);
        };

        recorder.onerror = (ev) => {
          if (cancelled) return;
          console.error(`[useMeetingRecorder:${meetingId}] recorder error`, ev);
          setState('error');
          setError(new Error('MediaRecorder error'));
        };

        recorder.start(timesliceMs);
      } catch (e) {
        console.error(`[useMeetingRecorder:${meetingId}] setup failed (mt=${mt})`, e);
        setState('error');
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    };

    mediaSource.addEventListener('sourceopen', onSourceOpen);

    return () => {
      cancelled = true;
      mediaSource.removeEventListener('sourceopen', onSourceOpen);
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstart = null;
        recorder.onerror = null;
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      }
      recorderRef.current = null;
      queueRef.current?.dispose();
      queueRef.current = null;
      sourceBufferRef.current = null;
      mediaSourceRef.current = null;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      setRecordingStartEpochMs(null);
      setRecordingStartPerf(null);
    };
  }, [track, audioTrack, meetingId, timesliceMs]);

  const getBuffered = useCallback((): TimeRanges | null => {
    return sourceBufferRef.current?.buffered ?? null;
  }, []);

  const requestEviction = useCallback(
    (protectFromTimeSec: number) => {
      const sb = sourceBufferRef.current;
      const queue = queueRef.current;
      if (!sb || !queue) return;
      const buffered = sb.buffered;
      if (buffered.length === 0) return;

      const bufferedStart = buffered.start(0);
      const bufferedEnd = buffered.end(buffered.length - 1);
      if (bufferedEnd - bufferedStart <= maxBufferedSeconds) return;

      const removalEnd = Math.min(
        bufferedEnd - maxBufferedSeconds,
        protectFromTimeSec - evictionSafetyMarginSec,
      );
      if (removalEnd <= bufferedStart + 0.1) return;

      queue.enqueue(() => {
        try {
          sb.remove(bufferedStart, removalEnd);
        } catch (e) {
          console.error(`[useMeetingRecorder:${meetingId}] remove failed`, e);
        }
      });
    },
    [maxBufferedSeconds, evictionSafetyMarginSec, meetingId],
  );

  return {
    mediaRef,
    state: track ? state : 'idle',
    error,
    mimeType,
    recordingStartEpochMs,
    recordingStartPerf,
    getBuffered,
    requestEviction,
  };
}
