import asyncio
import sys
import time
from dotenv import load_dotenv
from livekit import api
from livekit.protocol import agent as agent_proto, models

load_dotenv()

ROOM_AGENT_MAP = {
    "room-a": "pms-agent-room-a",
    "room-b": "pms-agent-room-b",
}


# 作成直後でまだAgentが参加していないdispatchを「進行中」とみなす猶予。
PENDING_GRACE_SEC = 60


async def find_existing_agent(lkapi: api.LiveKitAPI, room: str, agent_name: str) -> str | None:
    """既にこのルームを担当しているAgentがいれば、その説明を返す（いなければ None）。

    1ルームにつきAgentは1つだけ。二重にいると字幕が二重になるため弾く。

    判定の基準は「実際にルームにいるAgent参加者」。dispatchのjob状態は
    ワーカーが落ちても RUNNING のまま残る（実測：参加者がいないのに RUNNING の
    dispatchが溜まる）ので、それを根拠にすると以後ずっと弾き続けてしまう。
    ただし dispatch 直後はAgentがまだ参加していないため、作成から
    PENDING_GRACE_SEC 以内でjobが未開始のdispatchだけは二重投入として弾く。
    """
    try:
        res = await lkapi.room.list_participants(api.ListParticipantsRequest(room=room))
        for p in res.participants:
            if p.kind == models.ParticipantInfo.Kind.AGENT:
                return f"agent participant {p.identity} is already in the room"
    except Exception:
        pass  # ルームがまだ存在しない。参加済みAgentは無い。

    now = time.time()
    for d in await lkapi.agent_dispatch.list_dispatch(room):
        if d.agent_name != agent_name or d.state.deleted_at:
            continue
        age_sec = now - d.state.created_at / 1e9
        started = any(
            j.state.status != agent_proto.JobStatus.JS_PENDING for j in d.state.jobs
        )
        if not started and age_sec < PENDING_GRACE_SEC:
            return f"dispatch {d.id} was created {age_sec:.0f}s ago and has not started yet"
    return None


async def dispatch_room(lkapi: api.LiveKitAPI, room: str) -> None:
    agent_name = ROOM_AGENT_MAP[room]
    existing = await find_existing_agent(lkapi, room, agent_name)
    if existing:
        print(f"SKIPPED: {room}: {existing}", file=sys.stderr)
        return
    d = await lkapi.agent_dispatch.create_dispatch(
        api.CreateAgentDispatchRequest(
            room=room,
            agent_name=agent_name,
            metadata="{}",
        )
    )
    print(f"dispatch_id={d.id}")
    print(f"agent_name={agent_name}")
    print(f"room={room}")
    print(f"metadata={d.metadata}")


async def main() -> None:
    args = sys.argv[1:]
    target_rooms = args if args else list(ROOM_AGENT_MAP.keys())

    unknown = [r for r in target_rooms if r not in ROOM_AGENT_MAP]
    if unknown:
        print(f"Error: unknown room(s): {unknown}", file=sys.stderr)
        print(f"Available rooms: {list(ROOM_AGENT_MAP.keys())}", file=sys.stderr)
        sys.exit(1)

    lkapi = api.LiveKitAPI()
    for room in target_rooms:
        print(f"--- dispatching to {room} ---")
        await dispatch_room(lkapi, room)
    await lkapi.aclose()


if __name__ == "__main__":
    asyncio.run(main())
