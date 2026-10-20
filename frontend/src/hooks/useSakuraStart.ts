import { useCallback, useEffect, useState } from 'react';
import { RoomEvent, type Room } from 'livekit-client';
import {
  RECORDED_SAKURA,
  SAKURA_CONTROL_TOPIC,
  SAKURA_IDS,
  SAKURA_READY_ATTR,
} from '../lib/recordedSakura';

const WATCHED_EVENTS = [
  RoomEvent.Connected,
  RoomEvent.Disconnected,
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ParticipantAttributesChanged,
] as const;

/**
 * 録画動画サクラ（/sakura）の開始制御。
 *
 * - allReady: サクラ4人（A〜D）全員が自分の会議の Room に居て、
 *   attributes.ready === '1' を立てているか。
 * - sendStart: 会議1・会議2の両 Room に start を reliable で送る。
 *   両方の publishData を await を挟まず同じ tick で呼ぶ。
 *
 * Used by both 実験群 (CommaDebug) and 統制群 (ControlDebug).
 */
export function useSakuraStart(params: { roomA: Room | null; roomB: Room | null }) {
  const { roomA, roomB } = params;
  const [allReady, setAllReady] = useState(false);

  useEffect(() => {
    const recompute = () => {
      setAllReady(
        SAKURA_IDS.every((id) => {
          const { identity, meeting } = RECORDED_SAKURA[id];
          const p = (meeting === 1 ? roomA : roomB)?.getParticipantByIdentity(identity);
          return p?.attributes[SAKURA_READY_ATTR] === '1';
        }),
      );
    };
    recompute();
    const rooms = [roomA, roomB].filter((r): r is Room => r !== null);
    rooms.forEach((r) => WATCHED_EVENTS.forEach((ev) => r.on(ev, recompute)));
    return () => {
      rooms.forEach((r) => WATCHED_EVENTS.forEach((ev) => r.off(ev, recompute)));
    };
  }, [roomA, roomB]);

  const sendStart = useCallback(() => {
    const payload = new TextEncoder().encode(JSON.stringify({ action: 'start', sent_at: Date.now() }));
    [roomA, roomB].forEach((room) => {
      room?.localParticipant
        .publishData(payload, { reliable: true, topic: SAKURA_CONTROL_TOPIC })
        .catch((e) => console.error('[sakura-start] start publish failed', e));
    });
  }, [roomA, roomB]);

  return { allReady, sendStart };
}
