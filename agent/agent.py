from __future__ import annotations

import asyncio
import importlib
import json
import os
import time
from datetime import datetime
from typing import Any

from dotenv import load_dotenv
from livekit import agents, rtc

deepgram = importlib.import_module("livekit.plugins.deepgram")

load_dotenv()

AGENT_ROOM = os.environ.get("PMS_AGENT_ROOM", "room-a")
AGENT_IDENTITY = os.environ.get("PMS_AGENT_IDENTITY", "pms-agent-room-a")

SUMMON_KEYWORDS = [
    kw.strip()
    for kw in os.environ.get("PMS_SUMMON_KEYWORDS", "田中").split(",")
    if kw.strip()
]


def _matches_summon_keyword(text: str) -> bool:
    return any(kw in text for kw in SUMMON_KEYWORDS)


def _finite(value: Any) -> float | None:
    """Deepgram の start/end は NOT_GIVEN（センチネル）になり得るので数値だけ通す。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _frame_duration_sec(frame: Any) -> float:
    duration = _finite(getattr(frame, "duration", None))
    if duration is not None:
        return duration
    samples = getattr(frame, "samples_per_channel", None)
    rate = getattr(frame, "sample_rate", None)
    if samples and rate:
        return float(samples) / float(rate)
    return 0.0


class AudioClock:
    """Deepgram のストリーム相対秒 ↔ Epoch の対応を保持する。

    Deepgram の word start/end は「そこまでに投入された音声の累積長」で進む
    のであって、壁時計で進むのではない。したがって

        （ストリーム生成時刻）＋（相対秒）

    という固定アンカー方式は、音声が途切れた瞬間に壊れる。ミュート・パケット
    ロス・DTX・トラック再publish などで音声が流れなかった時間はそのまま音声
    クロックの遅れになり、しかも二度と取り戻せない（Deepgram は流れてこな
    かった音声を知らない）。長時間の会議ほど字幕の発話時刻が過去へずれ続け、
    ロスト区間と全く噛み合わなくなる。

    そこでアンカーを固定せず、フレームを投入するたびに「累積音声長」と「その
    瞬間の壁時計」を組で更新する。相対秒 s の Epoch は

        （最後に投入した壁時計）−（累積音声長 − s）

    で求まる。音声が止まれば累積音声長も壁時計も同時に止まるので、再開後は
    自動的に正しい対応へ戻る。ズレが蓄積しない。
    """

    __slots__ = ("pushed_sec", "wall_epoch")

    def __init__(self) -> None:
        self.pushed_sec = 0.0
        self.wall_epoch = time.time()

    def advance(self, duration_sec: float) -> None:
        self.pushed_sec += duration_sec
        self.wall_epoch = time.time()

    def to_epoch_ms(self, stream_sec: float) -> int:
        return int((self.wall_epoch - (self.pushed_sec - stream_sec)) * 1000)


# 発話終了から Deepgram が final を返すまでの現実的な上限。これを超えて過去に
# なる（＝クロックがずれた）結果は信用せず、確定時刻から組み立て直す。
MAX_SPEECH_LAG_MS = 15_000


def _speech_epoch_range_ms(alt: Any, clock: AudioClock, fallback_ms: int) -> tuple[int, int, str]:
    """SpeechData を「実際に発話された Epoch 区間」へ変換する。

    なお livekit-plugins-deepgram の stt.py は SpeechData.end_time を
    `next(word.get("end") for ...)` で組み立てており、これは「最後」ではなく
    「最初」の単語の end になってしまっている。そのため終端は words[-1] から
    自前で取り、取れないときだけ end_time にフォールバックする。
    """
    words = getattr(alt, "words", None) or []
    start_s = _finite(getattr(alt, "start_time", None))
    if start_s is None and words:
        start_s = _finite(getattr(words[0], "start_time", None))

    end_s = None
    if words:
        end_s = _finite(getattr(words[-1], "end_time", None))
    if end_s is None:
        end_s = _finite(getattr(alt, "end_time", None))

    if start_s is None and end_s is None:
        # 発話時刻が一切取れない（words 無し・タイムスタンプ無し）ときだけ、
        # 確定時刻で 1 点区間として近似する。
        return fallback_ms, fallback_ms, "fallback-finalized"

    if start_s is None:
        start_s = end_s
    if end_s is None or end_s < start_s:
        end_s = start_s

    start_ms = clock.to_epoch_ms(start_s)
    end_ms = clock.to_epoch_ms(end_s)

    # 最後の安全網。ストリーム再接続をまたぐと livekit-agents が start_time に
    # 壁時計ベースの start_time_offset を足してくるため、音声ベースの累積長と
    # 単位が食い違って現実離れした値になり得る。そのときは発話長だけ信用して
    # 確定時刻から逆算する（ロスト判定が黙って死ぬよりはるかにまし）。
    duration_ms = max(0, end_ms - start_ms)
    if end_ms > fallback_ms + 1_000 or fallback_ms - end_ms > MAX_SPEECH_LAG_MS:
        return fallback_ms - duration_ms, fallback_ms, "clock-resync"

    return start_ms, end_ms, "deepgram"


def _fmt_ts(ts: datetime) -> str:
    return ts.strftime("%Y-%m-%d %H:%M:%S")


def _extract_participant_fields(p: Any) -> dict:
    # オブジェクト型と辞書型の両方の参加者表現をサポート
    if p is None:
        return {"identity": None, "name": None, "metadata": None}

    if isinstance(p, dict):
        return {
            "identity": p.get("identity") or p.get("sid"),
            "name": p.get("name"),
            "metadata": p.get("metadata"),
        }

    return {
        "identity": getattr(p, "identity", getattr(p, "sid", None)),
        "name": getattr(p, "name", None),
        "metadata": getattr(p, "metadata", None),
    }


def log_participant(room_name: str, participant: Any, joined_at: datetime | None = None) -> None:
    if joined_at is None:
        joined_at = datetime.now()
    fields = _extract_participant_fields(participant)
    print("[room-participant]")
    print(f"room_name: {room_name}")
    print(f"identity: {fields.get('identity')}")
    print(f"name: {fields.get('name')}")
    print(f"metadata: {fields.get('metadata')}")
    print(f"joined_at: {_fmt_ts(joined_at)}")


class DeepgramTranscriptPrinter:
    def __init__(self, room: rtc.Room, stt_model: Any) -> None:
        self._room = room
        self._stt = stt_model
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._task_participants: dict[str, str] = {}
        self._closed = False

    def start(self) -> None:
        self._room.on("track_subscribed", self._on_track_subscribed)
        self._room.on("track_unsubscribed", self._on_track_unsubscribed)
        self._room.on("participant_disconnected", self._on_participant_disconnected)

        for participant in self._room.remote_participants.values():
            self._start_existing_tracks(participant)

    async def aclose(self) -> None:
        if self._closed:
            return

        self._closed = True
        self._room.off("track_subscribed", self._on_track_subscribed)
        self._room.off("track_unsubscribed", self._on_track_unsubscribed)
        self._room.off("participant_disconnected", self._on_participant_disconnected)

        tasks = list(self._tasks.values())
        self._tasks.clear()
        self._task_participants.clear()
        if tasks:
            await agents.utils.aio.cancel_and_wait(*tasks)

    def _start_existing_tracks(self, participant: rtc.RemoteParticipant) -> None:
        for publication in participant.track_publications.values():
            if publication.kind != rtc.TrackKind.KIND_AUDIO:
                continue
            if publication.track is None:
                continue
            self._start_transcription_task(participant.identity, publication)

    def _on_track_subscribed(
        self,
        track: rtc.Track,
        publication: rtc.TrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if publication.kind != rtc.TrackKind.KIND_AUDIO:
            return
        self._start_transcription_task(participant.identity, publication)

    def _on_track_unsubscribed(
        self,
        track: rtc.Track,
        publication: rtc.TrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        self._cancel_transcription_task(publication.sid)

    def _on_participant_disconnected(self, participant: rtc.RemoteParticipant) -> None:
        for sid, identity in list(self._task_participants.items()):
            if identity == participant.identity:
                self._cancel_transcription_task(sid)

    def _cancel_transcription_task(self, publication_sid: str) -> None:
        task = self._tasks.pop(publication_sid, None)
        self._task_participants.pop(publication_sid, None)
        if task is not None:
            task.cancel()

    def _start_transcription_task(self, participant_identity: str, publication: rtc.TrackPublication) -> None:
        if publication.sid in self._tasks:
            return

        if publication.track is None:
            return

        task = asyncio.create_task(
            self._transcribe_publication(participant_identity, publication),
            name=participant_identity,
        )
        self._tasks[publication.sid] = task
        self._task_participants[publication.sid] = participant_identity

        def _drop_task(_task: asyncio.Task[None]) -> None:
            self._tasks.pop(publication.sid, None)
            self._task_participants.pop(publication.sid, None)

        task.add_done_callback(_drop_task)

    async def _transcribe_publication(
        self, participant_identity: str, publication: rtc.TrackPublication
    ) -> None:
        if publication.track is None:
            return

        audio_stream = rtc.AudioStream.from_track(track=publication.track)
        try:
            async with self._stt.stream(language="ja") as stt_stream:
                # Deepgram の相対タイムスタンプを Epoch へ戻すための対応表。
                # 音声を投入するたびに更新するので、音声が途切れてもズレが
                # 蓄積しない（AudioClock の docstring 参照）。
                clock = AudioClock()

                async def _forward_audio() -> None:
                    try:
                        async for event in audio_stream:
                            stt_stream.push_frame(event.frame)
                            clock.advance(_frame_duration_sec(event.frame))
                    finally:
                        stt_stream.end_input()

                forward_task = asyncio.create_task(_forward_audio())
                try:
                    async for event in stt_stream:
                        if event.type != agents.stt.SpeechEventType.FINAL_TRANSCRIPT:
                            continue
                        if not event.alternatives:
                            continue

                        alt = event.alternatives[0]
                        text = alt.text.strip()
                        if not text:
                            continue

                        finalized_ms = int(time.time() * 1000)
                        speech_start_ms, speech_end_ms, speech_time_source = _speech_epoch_range_ms(
                            alt, clock, finalized_ms
                        )

                        print("[TRANSCRIPT]", flush=True)
                        print(f"room={self._room.name}", flush=True)
                        print(f"participant={participant_identity}", flush=True)
                        print(f"text={text}", flush=True)
                        print(
                            f"speech={speech_start_ms}..{speech_end_ms} "
                            f"({speech_time_source}, lag={finalized_ms - speech_end_ms}ms)",
                            flush=True,
                        )

                        payload = json.dumps({
                            "room": self._room.name,
                            "participant": participant_identity,
                            "text": text,
                            # 後方互換のため残すが、これは「Deepgram が確定させた時刻」で
                            # あって発話時刻ではない。ロスト判定には使わないこと。
                            "timestamp": finalized_ms,
                            "finalized_at": finalized_ms,
                            # ロスト区間との重なり判定に使う実発話区間。
                            "speech_start_ms": speech_start_ms,
                            "speech_end_ms": speech_end_ms,
                            "speech_time_source": speech_time_source,
                        }).encode("utf-8")
                        asyncio.create_task(
                            self._room.local_participant.publish_data(
                                payload,
                                topic="transcript",
                                reliable=True,
                            )
                        )

                        if _matches_summon_keyword(text):
                            summon_payload = json.dumps({
                                "participant": participant_identity,
                                "text": text,
                                "timestamp": finalized_ms,
                                "speech_start_ms": speech_start_ms,
                                "speech_end_ms": speech_end_ms,
                                "speech_time_source": speech_time_source,
                            }).encode("utf-8")
                            asyncio.create_task(
                                self._room.local_participant.publish_data(
                                    summon_payload,
                                    topic="summon",
                                    reliable=True,
                                )
                            )
                finally:
                    await agents.utils.aio.cancel_and_wait(forward_task)
        finally:
            await audio_stream.aclose()


async def entrypoint(ctx: agents.JobContext):
    deepgram_api_key = os.environ.get("DEEPGRAM_API_KEY")
    if not deepgram_api_key:
        raise RuntimeError("DEEPGRAM_API_KEY is not set")

    transcript_stt = deepgram.STT(
        api_key=deepgram_api_key,
        model="nova-3",
        language="ja",
        interim_results=False,
    )

    # ルームに接続（元の動作を維持）
    await ctx.connect()
    # 一般的な属性からルーム名を取得する
    room_name = None
    room = getattr(ctx, "room", None)
    room_name = getattr(room, "name", None) if room is not None else getattr(ctx, "room_name", None)
    room_name = room_name or getattr(ctx, "name", None) or "<unknown>"

    print("Agent connected to room")

    # Log existing participants if available (extended for LiveKit Room)
    try:
        participants = None
        # ルームの参加者の一般的な位置をチェック
        if room is not None:
            if hasattr(room, "participants"):
                participants = getattr(room, "participants")
            elif hasattr(room, "remote_participants"):
                participants = getattr(room, "remote_participants")
            elif hasattr(room, "_remote_participants"):
                participants = getattr(room, "_remote_participants")
        # ctx.participantsにフォールバック
        if participants is None and hasattr(ctx, "participants"):
            participants = getattr(ctx, "participants")

        # デバッグ用：参加者数が利用可能な場合はレポート
        if participants is None and room is not None and hasattr(room, "num_participants"):
            try:
                print(f"DEBUG: room.num_participants = {getattr(room, 'num_participants')}")
            except Exception:
                pass

        if participants is not None:
            # 参加者は辞書型またはリスト型の可能性あり
            items = participants.values() if hasattr(participants, "values") else participants
            for p in items:
                log_participant(room_name, p, datetime.now())
    except Exception as e:
        print(f"Warning: failed to enumerate existing participants: {e}")

    printer = DeepgramTranscriptPrinter(room, transcript_stt)
    printer.start()

    def _on_participant_connected(participant: rtc.RemoteParticipant) -> None:
        log_participant(room_name, participant, datetime.now())

    room.on("participant_connected", _on_participant_connected)

    async def _cleanup() -> None:
        room.off("participant_connected", _on_participant_connected)
        await printer.aclose()

    ctx.add_shutdown_callback(_cleanup)


if __name__ == "__main__":
    agents.cli.run_app(
        agents.WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name=AGENT_IDENTITY,
        )
    )