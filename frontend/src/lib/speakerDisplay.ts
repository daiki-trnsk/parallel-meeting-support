/**
 * Maps a LiveKit identity (e.g. "participant-a") to the label/color shown
 * for that speaker — in subtitle lines (CommaDebug's SubtitleColumn) and
 * baked into each サクラ's video cell (useCompositeMeetingStream). Kept in
 * one place so both stay in sync.
 *
 * participant-a..d are the lettered サクラ; any other identity (the
 * 同時参加者's own, subject-01) falls back to "あなた" in white.
 */
export const SPEAKER_DISPLAY: Record<string, { label: string; color: string }> = {
  'participant-a': { label: 'Aさん', color: '#e05555' },
  'participant-b': { label: 'Bさん', color: '#5588ee' },
  'participant-c': { label: 'Cさん', color: '#4caf50' },
  'participant-d': { label: 'Dさん', color: '#e0c040' },
};
export const SELF_DISPLAY = { label: 'あなた', color: '#fff' };

export function speakerDisplay(identity: string): { label: string; color: string } {
  return SPEAKER_DISPLAY[identity] ?? SELF_DISPLAY;
}
