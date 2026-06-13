from dotenv import load_dotenv
from livekit import agents
from datetime import datetime
from typing import Any
import asyncio

load_dotenv()


def _fmt_ts(ts: datetime) -> str:
    return ts.strftime("%Y-%m-%d %H:%M:%S")


def _extract_participant_fields(p: Any) -> dict:
    # support both object-like and dict-like participant representations
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


async def entrypoint(ctx: agents.JobContext):
    # connect to the room (keeps original behavior)
    await ctx.connect()
    # try to obtain room name from common attributes
    room_name = None
    room = getattr(ctx, "room", None)
    room_name = getattr(room, "name", None) if room is not None else getattr(ctx, "room_name", None)
    room_name = room_name or getattr(ctx, "name", None) or "<unknown>"

    print("Agent connected to room")

    # Log existing participants if available
    try:
        participants = None
        # common locations for participants
        if room is not None and hasattr(room, "participants"):
            participants = getattr(room, "participants")
        elif hasattr(ctx, "participants"):
            participants = getattr(ctx, "participants")

        if participants is not None:
            # participants may be a dict-like or list-like
            items = participants.values() if hasattr(participants, "values") else participants
            for p in items:
                log_participant(room_name, p, datetime.now())
    except Exception as e:
        print(f"Warning: failed to enumerate existing participants: {e}")

    # Register handler for new participants where possible
    async def _on_participant_joined(p):
        try:
            log_participant(room_name, p, datetime.now())
        except Exception as e:
            print(f"Error logging participant: {e}")

    # Synchronous wrapper required by some SDKs' `.on()` API. It schedules the async handler.
    def _on_participant_joined_sync(p):
        try:
            asyncio.create_task(_on_participant_joined(p))
        except Exception as e:
            print(f"Error scheduling participant handler: {e}")

    # Try several common event registration patterns
    try:
        if room is not None and hasattr(room, "on"):
            # room.on("participant_connected"/"participant_joined") expects a sync callback
            try:
                room.on("participant_connected", _on_participant_joined_sync)
            except Exception:
                room.on("participant_joined", _on_participant_joined_sync)
        elif hasattr(ctx, "on"):
            try:
                ctx.on("participant_connected", _on_participant_joined_sync)
            except Exception:
                ctx.on("participant_joined", _on_participant_joined_sync)
        elif hasattr(ctx, "on_participant_joined"):
            # some SDKs expose a dedicated decorator-like API; wrap similarly
            try:
                ctx.on_participant_joined(_on_participant_joined_sync)
            except Exception:
                # fallback: schedule directly in case it expects sync
                ctx.on_participant_joined(lambda p: asyncio.create_task(_on_participant_joined(p)))
    except Exception as e:
        print(f"Warning: failed to register participant-joined handler: {e}")


if __name__ == "__main__":
    agents.cli.run_app(
        agents.WorkerOptions(entrypoint_fnc=entrypoint)
    )