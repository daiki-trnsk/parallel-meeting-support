const CANDIDATE_MIME_TYPES_AUDIO_VIDEO = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const CANDIDATE_MIME_TYPES_VIDEO_ONLY = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function pickSupportedMimeType(withAudio: boolean = false): string | null {
  const candidates = withAudio ? CANDIDATE_MIME_TYPES_AUDIO_VIDEO : CANDIDATE_MIME_TYPES_VIDEO_ONLY;
  for (const candidate of candidates) {
    const recorderOk =
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate);
    const sourceOk =
      typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(candidate);
    if (recorderOk && sourceOk) {
      return candidate;
    }
  }
  return null;
}
