"""実験データ用の会議音声録音（room ごとに全参加者をミックスした 16kHz モノラル WAV）。

文字起こし（DeepgramTranscriptPrinter）には一切手を触れない。

- 録音用の AudioStream はトラックごとに STT とは別に開く（STT が受け取る
  フレームを横取り・加工しない）。開いているのは録音中だけ。
- イベントループ側でやるのは「フレームを queue に put_nowait する」ことだけ。
  無音埋め・ミックス・WAV 書き込み・JSON 書き出しはすべて専用スレッドで行う。
  queue が満杯なら録音フレームの方を捨てる（STT・呼びかけ検知を待たせない）。
- 録音側の例外はすべてここで握りつぶしてログに出す。

開始: 同時参加者が「開始」を押すと、フロントが topic="record-control" で
{action:"start", session_id} を送ってくる（受信確認のため数秒おきに再送される）。
同時参加者は実験群（subject-01, CommaDebug）と統制群（subject-control-01,
ControlDebug）の 2 種類で、送信者の identity から群名を決めてディレクトリ名に入れる
（例: recordings/2026-10-13_15-30-12_control/roomA.wav。1 セッション = 1 ディレクトリで、
roomA / roomB の .wav と .json の 4 ファイルが入る）。
終了: 録音を開始した同時参加者がその room から退出したとき。agent 終了時も閉じる。

ミュート対策: WAV は壁時計基準で書く。どのトラックからもフレームが来ない
区間（ミュート・未publish・パケット途絶）は無音で埋まるので、ファイル上の
t 秒は常に「開始 epoch + t 秒」に一致する（字幕の speech_start_ms や
lost window と同じ時刻系で突き合わせられる）。
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import re
import threading
import time
import wave
from datetime import datetime
from typing import Any

import numpy as np
from livekit import rtc

RECORD_CONTROL_TOPIC = "record-control"
RECORD_STATUS_TOPIC = "record-status"

SAMPLE_RATE = 16_000
# 録音用 AudioStream のフレーム長。小さいほどイベントループへの FFI イベントが
# 増えるので、STT 側（既定 10ms）より大きめにして負荷を抑える。
FRAME_SIZE_MS = 100

# 書き込みスレッドへのキュー上限（100ms フレームで 1 トラック約 200 秒分）。
QUEUE_MAX_ITEMS = 2_000
# この秒数より古いタイムラインを確定させてファイルへ書き出す。到着の揺らぎで
# 少し遅れて届いたフレームも、この範囲内なら正しい位置にミックスできる。
FLUSH_LATENCY_SEC = 3.0
FLUSH_INTERVAL_SEC = 0.5
META_INTERVAL_SEC = 30.0
# 連続していたはずの位置より、これ以上遅れてフレームが届いたら「途切れていた」
# （ミュート等）とみなして到着時刻へ合わせ直す。間は無音になる。
GAP_RESYNC_SEC = 1.0
# 逆に到着時刻よりこれ以上先へ進んでしまったら合わせ直す（安全網）。
AHEAD_RESYNC_SEC = 3.0


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def _room_label(room_name: str) -> str:
    """'room-a' → 'roomA'"""
    return re.sub(r"[-_](\w)", lambda m: m.group(1).upper(), room_name) or "room"


def _safe_session_id(raw: Any) -> str:
    text = re.sub(r"[^0-9A-Za-z_-]", "", str(raw or ""))[:64]
    return text or datetime.now().strftime("%Y%m%d-%H%M%S")


def _session_dir_name(session_id: str, group: str) -> str:
    """'20261025-153436' + 'subject' → '2026-10-25_15-34-36_subject'"""
    m = re.fullmatch(r"(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})", session_id)
    stamp = "{}-{}-{}_{}-{}-{}".format(*m.groups()) if m else session_id
    return f"{stamp}_{group}"


def _parse_subject_groups(raw: str) -> dict[str, str]:
    groups: dict[str, str] = {}
    for item in raw.split(","):
        identity, _, group = item.partition(":")
        identity = identity.strip()
        group = re.sub(r"[^0-9A-Za-z_]", "", group) or "subject"
        if identity:
            groups[identity] = group
    return groups


def _log(msg: str) -> None:
    print(f"[recorder] {msg}", flush=True)


class _RecordingWriter(threading.Thread):
    """キューから受け取ったフレームを壁時計タイムラインにミックスして WAV に書く。"""

    def __init__(self, wav_path: str, meta_path: str, meta: dict[str, Any]) -> None:
        super().__init__(name=f"recorder-{os.path.basename(wav_path)}", daemon=True)
        self.wav_path = wav_path
        self.meta_path = meta_path
        self._meta = meta
        self._events: list[dict[str, Any]] = []
        self._queue: queue.Queue[tuple[Any, ...]] = queue.Queue(maxsize=QUEUE_MAX_ITEMS)

        # タイムラインの原点。サンプル 0 = start_epoch_ms。
        self._t0_mono = time.monotonic()
        self._meta["start_epoch_ms"] = int(time.time() * 1000)

        self._stop_requested = threading.Event()
        self._stop_mono: float | None = None

        # 以下はイベントループ側からも触るが、単純な int 加算のみ。
        self.dropped_frames = 0
        self.dropped_events = 0

        # 以下は書き込みスレッド専用。
        self._next_sample: dict[str, int] = {}
        self._flushed = 0
        self._pending = np.zeros(0, dtype=np.int32)
        self._resyncs = 0
        self._late_trimmed_samples = 0

    # ---- イベントループ側から呼ぶ（ブロックしない） ----

    def submit_frame(self, key: str, pcm: bytes) -> None:
        try:
            self._queue.put_nowait(("frame", key, time.monotonic(), pcm))
        except queue.Full:
            self.dropped_frames += 1

    def submit_event(self, event: dict[str, Any]) -> None:
        event = {"epoch_ms": int(time.time() * 1000), **event}
        try:
            self._queue.put_nowait(("event", event))
        except queue.Full:
            self.dropped_events += 1

    def request_stop(self, reason: str) -> None:
        if self._stop_requested.is_set():
            return
        self._meta["stop_reason"] = reason
        self._meta["stop_epoch_ms"] = int(time.time() * 1000)
        self._stop_mono = time.monotonic()
        self._stop_requested.set()

    # ---- 以下、書き込みスレッド ----

    def run(self) -> None:
        wav: wave.Wave_write | None = None
        try:
            wav = wave.open(self.wav_path, "wb")
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            self._write_meta(final=False)

            last_flush = last_meta = time.monotonic()
            while not self._stop_requested.is_set():
                try:
                    item = self._queue.get(timeout=0.2)
                    self._consume(item)
                except queue.Empty:
                    pass
                now = time.monotonic()
                if now - last_flush >= FLUSH_INTERVAL_SEC:
                    self._flush(wav, self._pos(now - FLUSH_LATENCY_SEC))
                    last_flush = now
                if now - last_meta >= META_INTERVAL_SEC:
                    self._write_meta(final=False)
                    last_meta = now

            # 停止要求までに積まれた分を書き切る。
            while True:
                try:
                    self._consume(self._queue.get_nowait())
                except queue.Empty:
                    break
            stop_pos = self._pos(self._stop_mono if self._stop_mono is not None else time.monotonic())
            self._flush(wav, max(stop_pos, self._flushed + len(self._pending)))
        except Exception as e:
            self._meta["writer_error"] = repr(e)
            _log(f"writer error ({self.wav_path}): {e!r}")
        finally:
            if wav is not None:
                try:
                    wav.close()
                except Exception as e:
                    _log(f"wav close failed ({self.wav_path}): {e!r}")
            try:
                self._write_meta(final=True)
            except Exception as e:
                _log(f"meta write failed ({self.meta_path}): {e!r}")
            _log(
                f"closed {self.wav_path} ({self._flushed / SAMPLE_RATE:.1f}s, "
                f"dropped_frames={self.dropped_frames})"
            )

    def _pos(self, mono: float) -> int:
        return max(0, int(round((mono - self._t0_mono) * SAMPLE_RATE)))

    def _consume(self, item: tuple[Any, ...]) -> None:
        if item[0] == "frame":
            _, key, arrival, pcm = item
            self._place(key, arrival, pcm)
        elif item[0] == "event":
            self._events.append(item[1])

    def _place(self, key: str, arrival: float, pcm: bytes) -> None:
        samples = np.frombuffer(pcm, dtype=np.int16)
        n = len(samples)
        if n == 0:
            return
        arrival_end = self._pos(arrival)
        expected = self._next_sample.get(key)
        # 通常はサンプル数で連続に並べる（到着の揺らぎで音声を崩さない）。
        # 大きく遅れて届いた＝途切れていた場合だけ到着時刻へ合わせ直す。
        if (
            expected is None
            or arrival_end - (expected + n) > GAP_RESYNC_SEC * SAMPLE_RATE
            or (expected + n) - arrival_end > AHEAD_RESYNC_SEC * SAMPLE_RATE
        ):
            if expected is not None:
                self._resyncs += 1
            start = max(0, arrival_end - n)
        else:
            start = expected
        self._next_sample[key] = start + n

        offset = start - self._flushed
        if offset < 0:
            # 既に書き出し済みの範囲には入れられない（FLUSH_LATENCY_SEC 以上遅延）。
            self._late_trimmed_samples += min(n, -offset)
            samples = samples[-offset:]
            offset = 0
            if len(samples) == 0:
                return
        end = offset + len(samples)
        if end > len(self._pending):
            self._pending = np.concatenate(
                [self._pending, np.zeros(end - len(self._pending), dtype=np.int32)]
            )
        self._pending[offset:end] += samples

    def _flush(self, wav: wave.Wave_write, until: int) -> None:
        count = until - self._flushed
        if count <= 0:
            return
        if len(self._pending) < count:
            self._pending = np.concatenate(
                [self._pending, np.zeros(count - len(self._pending), dtype=np.int32)]
            )
        out = np.clip(self._pending[:count], -32768, 32767).astype("<i2")
        self._pending = self._pending[count:]
        self._flushed = until
        # wave は writeframes のたびにヘッダを書き直すので、途中で落ちても読める。
        wav.writeframes(out.tobytes())

    def _write_meta(self, final: bool) -> None:
        meta = dict(self._meta)
        meta.update(
            {
                "finalized": final,
                "duration_sec": round(self._flushed / SAMPLE_RATE, 3),
                "dropped_frames": self.dropped_frames,
                "dropped_events": self.dropped_events,
                "timeline_resyncs": self._resyncs,
                "late_trimmed_samples": self._late_trimmed_samples,
                "events": list(self._events),
            }
        )
        tmp = self.meta_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.meta_path)


class MeetingAudioRecorder:
    def __init__(
        self,
        room: rtc.Room,
        out_dir: str,
        subject_groups: dict[str, str],
        exclude_identities: set[str],
    ) -> None:
        self._room = room
        self._out_dir = out_dir
        # 同時参加者の identity → 群名（ファイル名に入る）
        self._subject_groups = subject_groups
        # 録音中のセッションを開始した同時参加者（この人の退出で終了する）
        self._active_subject: str | None = None
        self._exclude = exclude_identities
        self._label = _room_label(room.name or "room")
        self._writer: _RecordingWriter | None = None
        self._session_id: str | None = None
        self._captures: dict[str, asyncio.Task[None]] = {}
        self._closed = False
        self._handlers: dict[str, Any] = {
            "data_received": self._on_data_received,
            "participant_connected": self._on_participant_connected,
            "participant_disconnected": self._on_participant_disconnected,
            "track_subscribed": self._on_track_subscribed,
            "track_unsubscribed": self._on_track_unsubscribed,
            "track_muted": self._on_track_muted,
            "track_unmuted": self._on_track_unmuted,
        }

    def start(self) -> None:
        for event, handler in self._handlers.items():
            self._room.on(event, handler)
        _log(f"ready: {self._label} -> {self._out_dir} (waiting for start from {sorted(self._subject_groups)})")

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        for event, handler in self._handlers.items():
            try:
                self._room.off(event, handler)
            except Exception:
                pass
        writer = self._writer
        self._stop("agent-shutdown", publish=False)
        if writer is not None:
            try:
                await asyncio.to_thread(writer.join, 10.0)
            except Exception as e:
                _log(f"join failed: {e!r}")

    # ---- 開始・終了 ----

    def _begin(self, session_id: str, subject: str, sent_at: Any) -> None:
        group = self._subject_groups[subject]
        session_dir = os.path.join(self._out_dir, _session_dir_name(session_id, group))
        os.makedirs(session_dir, exist_ok=True)
        base = self._label
        part = 1
        while True:
            name = base if part == 1 else f"{base}-part{part}"
            wav_path = os.path.join(session_dir, name + ".wav")
            if not os.path.exists(wav_path):
                break
            part += 1
        meta = {
            "session_id": session_id,
            "room": self._room.name,
            "part": part,
            "file": os.path.basename(wav_path),
            "sample_rate": SAMPLE_RATE,
            "channels": 1,
            "sample_format": "s16le",
            "mix": "all remote participants in the room"
            + (f" except {sorted(self._exclude)}" if self._exclude else ""),
            "group": group,
            "subject_identity": subject,
            "start_requested_at_ms": sent_at if isinstance(sent_at, (int, float)) else None,
        }
        writer = _RecordingWriter(wav_path, os.path.join(session_dir, name + ".json"), meta)
        writer.start()
        self._writer = writer
        self._session_id = session_id
        self._active_subject = subject
        _log(f"start {wav_path}")
        writer.submit_event({"type": "recording_started"})

        for participant in self._room.remote_participants.values():
            writer.submit_event({"type": "present", "identity": participant.identity})
            for publication in participant.track_publications.values():
                self._open_capture(participant, publication)

    def _stop(self, reason: str, publish: bool = True) -> None:
        writer = self._writer
        if writer is None:
            return
        self._writer = None
        self._active_subject = None
        for task in self._captures.values():
            task.cancel()
        self._captures.clear()
        writer.submit_event({"type": "recording_stopped", "reason": reason})
        writer.request_stop(reason)
        _log(f"stop {writer.wav_path} ({reason})")
        if publish:
            self._publish_status(recording=False, file=os.path.basename(writer.wav_path))

    def _publish_status(self, recording: bool, file: str | None, to: str | None = None) -> None:
        payload = json.dumps(
            {
                "room": self._room.name,
                "recording": recording,
                "session_id": self._session_id,
                "file": file,
            }
        ).encode("utf-8")

        async def _send() -> None:
            try:
                await self._room.local_participant.publish_data(
                    payload,
                    topic=RECORD_STATUS_TOPIC,
                    reliable=True,
                    destination_identities=[to] if to else [],
                )
            except Exception as e:
                _log(f"status publish failed: {e!r}")

        asyncio.create_task(_send())

    # ---- 音声キャプチャ ----

    def _open_capture(self, participant: rtc.RemoteParticipant, publication: rtc.TrackPublication) -> None:
        writer = self._writer
        if writer is None or self._closed:
            return
        if publication.kind != rtc.TrackKind.KIND_AUDIO:
            return
        if participant.identity in self._exclude:
            return
        if publication.sid in self._captures or publication.track is None:
            return
        task = asyncio.create_task(
            self._capture(writer, participant.identity, publication),
            name=f"recorder-{participant.identity}",
        )
        self._captures[publication.sid] = task

        def _drop(_t: asyncio.Task[None], sid: str = publication.sid) -> None:
            if self._captures.get(sid) is _t:
                self._captures.pop(sid, None)

        task.add_done_callback(_drop)

    async def _capture(
        self, writer: _RecordingWriter, identity: str, publication: rtc.TrackPublication
    ) -> None:
        track = publication.track
        if track is None:
            return
        key = f"{identity}/{publication.sid}"
        try:
            stream = rtc.AudioStream.from_track(
                track=track,
                sample_rate=SAMPLE_RATE,
                num_channels=1,
                frame_size_ms=FRAME_SIZE_MS,
            )
        except Exception as e:
            _log(f"failed to open audio stream {key}: {e!r}")
            return
        try:
            async for event in stream:
                writer.submit_frame(key, bytes(event.frame.data))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            _log(f"capture error {key}: {e!r}")
        finally:
            try:
                await stream.aclose()
            except Exception:
                pass

    # ---- ルームイベント（すべて例外を外へ出さない） ----

    def _on_data_received(self, packet: rtc.DataPacket) -> None:
        try:
            if packet.topic != RECORD_CONTROL_TOPIC:
                return
            sender = packet.participant.identity if packet.participant else None
            if sender not in self._subject_groups:
                return
            msg = json.loads(bytes(packet.data).decode("utf-8"))
            if msg.get("action") != "start" or self._closed:
                return
            if self._writer is None:
                self._begin(_safe_session_id(msg.get("session_id")), sender, msg.get("sent_at"))
            # 録音中の再送（ハートビート）にも毎回応答し、フロントの表示を生かす。
            writer = self._writer
            self._publish_status(
                recording=writer is not None,
                file=os.path.basename(writer.wav_path) if writer else None,
                to=sender,
            )
        except Exception as e:
            _log(f"record-control handling failed: {e!r}")

    def _on_participant_connected(self, participant: rtc.RemoteParticipant) -> None:
        try:
            if self._writer is not None:
                self._writer.submit_event({"type": "participant_connected", "identity": participant.identity})
        except Exception as e:
            _log(f"participant_connected handling failed: {e!r}")

    def _on_participant_disconnected(self, participant: rtc.RemoteParticipant) -> None:
        try:
            if self._writer is None:
                return
            self._writer.submit_event({"type": "participant_disconnected", "identity": participant.identity})
            if participant.identity == self._active_subject:
                self._stop("subject-left")
        except Exception as e:
            _log(f"participant_disconnected handling failed: {e!r}")

    def _on_track_subscribed(
        self, track: rtc.Track, publication: rtc.TrackPublication, participant: rtc.RemoteParticipant
    ) -> None:
        try:
            if self._writer is None or publication.kind != rtc.TrackKind.KIND_AUDIO:
                return
            self._writer.submit_event({"type": "audio_subscribed", "identity": participant.identity})
            self._open_capture(participant, publication)
        except Exception as e:
            _log(f"track_subscribed handling failed: {e!r}")

    def _on_track_unsubscribed(
        self, track: rtc.Track, publication: rtc.TrackPublication, participant: rtc.RemoteParticipant
    ) -> None:
        try:
            task = self._captures.pop(publication.sid, None)
            if task is not None:
                task.cancel()
            if self._writer is not None and publication.kind == rtc.TrackKind.KIND_AUDIO:
                self._writer.submit_event({"type": "audio_unsubscribed", "identity": participant.identity})
        except Exception as e:
            _log(f"track_unsubscribed handling failed: {e!r}")

    def _on_track_muted(self, participant: rtc.Participant, publication: rtc.TrackPublication) -> None:
        self._mute_event("audio_muted", participant, publication)

    def _on_track_unmuted(self, participant: rtc.Participant, publication: rtc.TrackPublication) -> None:
        self._mute_event("audio_unmuted", participant, publication)

    def _mute_event(self, kind: str, participant: rtc.Participant, publication: rtc.TrackPublication) -> None:
        try:
            if self._writer is not None and publication.kind == rtc.TrackKind.KIND_AUDIO:
                self._writer.submit_event({"type": kind, "identity": participant.identity})
        except Exception as e:
            _log(f"{kind} handling failed: {e!r}")


def create_recorder(room: rtc.Room) -> MeetingAudioRecorder | None:
    """環境変数に従って録音器を作る。無効化されている・失敗した場合は None。"""
    try:
        if not _env_flag("PMS_RECORD", True):
            _log("disabled (PMS_RECORD=0)")
            return None
        out_dir = os.environ.get("PMS_RECORD_DIR") or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "recordings"
        )
        # "identity:群名" のカンマ区切り。群名はファイル名に入る。
        subject_groups = _parse_subject_groups(
            os.environ.get(
                "PMS_RECORD_SUBJECTS", "subject-01:subject,subject-control-01:control"
            )
        )
        exclude = {
            s.strip()
            for s in os.environ.get("PMS_RECORD_EXCLUDE_IDENTITIES", "").split(",")
            if s.strip()
        }
        recorder = MeetingAudioRecorder(room, out_dir, subject_groups, exclude)
        recorder.start()
        return recorder
    except Exception as e:
        _log(f"init failed, recording disabled: {e!r}")
        return None
