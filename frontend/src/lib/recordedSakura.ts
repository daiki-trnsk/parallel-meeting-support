/**
 * 録画動画サクラ（/sakura?id=A..D）と同時参加者側の開始制御で共有する定義。
 *
 * identity は既存の生声サクラと同じ participant-a..d を使う。Agent・字幕の
 * 話者表示（speakerDisplay）・CommaTrackBridge はこの identity 前提なので、
 * 供給元が動画になっても参加者側からは区別がつかない。
 */
export type SakuraId = 'A' | 'B' | 'C' | 'D';

export const SAKURA_IDS: SakuraId[] = ['A', 'B', 'C', 'D'];

export const RECORDED_SAKURA: Record<SakuraId, { identity: string; room: string; meeting: 1 | 2 }> = {
  A: { identity: 'participant-a', room: 'room-a', meeting: 1 },
  B: { identity: 'participant-b', room: 'room-a', meeting: 1 },
  C: { identity: 'participant-c', room: 'room-b', meeting: 2 },
  D: { identity: 'participant-d', room: 'room-b', meeting: 2 },
};

/** 同時参加者 → サクラの開始指示。payload は { action: 'start' }。 */
export const SAKURA_CONTROL_TOPIC = 'sakura-control';

/** publish 完了後にサクラが立てる participant attribute（値は '1'）。 */
export const SAKURA_READY_ATTR = 'ready';

export function isSakuraId(v: string | null): v is SakuraId {
  return v !== null && (SAKURA_IDS as string[]).includes(v);
}
