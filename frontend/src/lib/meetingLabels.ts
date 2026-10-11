/**
 * User-facing display names for the two parallel meetings. Internally the
 * LiveKit room names (room-a/room-b) and MeetingId ('A'/'B') stay as they
 * are everywhere else in the code (session storage, data-channel payloads,
 * debug logs) — only what's actually rendered on screen is relabelled here,
 * in one place, so every screen (CommaDebug, ControlDebug, Meeting,
 * TranscriptPanel, DebugReadout, Home) stays in sync.
 */
export function roomDisplayName(room: string): string {
  if (room === 'room-a') return '会議1';
  if (room === 'room-b') return '会議2';
  return room;
}

export function meetingDisplayName(meeting: 'A' | 'B'): string {
  return meeting === 'A' ? '会議1' : '会議2';
}
