from __future__ import annotations

import asyncio
import importlib
import json
import os
from datetime import datetime
from typing import Any

from dotenv import load_dotenv
from livekit import agents, rtc

deepgram = importlib.import_module("livekit.plugins.deepgram")

load_dotenv()

AGENT_ROOM = os.environ.get("PMS_AGENT_ROOM", "room-a")
AGENT_IDENTITY = os.environ.get("PMS_AGENT_IDENTITY", "pms-agent-room-a")


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
                async def _forward_audio() -> None:
                    try:
                        async for event in audio_stream:
                            stt_stream.push_frame(event.frame)
                    finally:
                        stt_stream.end_input()

                forward_task = asyncio.create_task(_forward_audio())
                try:
                    async for event in stt_stream:
                        if event.type != agents.stt.SpeechEventType.FINAL_TRANSCRIPT:
                            continue
                        if not event.alternatives:
                            continue

                        text = event.alternatives[0].text.strip()
                        if not text:
                            continue

                        print("[TRANSCRIPT]", flush=True)
                        print(f"room={self._room.name}", flush=True)
                        print(f"participant={participant_identity}", flush=True)
                        print(f"text={text}", flush=True)

                        payload = json.dumps({
                            "room": self._room.name,
                            "participant": participant_identity,
                            "text": text,
                        }).encode("utf-8")
                        asyncio.create_task(
                            self._room.local_participant.publish_data(
                                payload,
                                topic="transcript",
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