import asyncio
import sys
from dotenv import load_dotenv
from livekit import api

load_dotenv()

ROOM_AGENT_MAP = {
    "room-a": "pms-agent-room-a",
    "room-b": "pms-agent-room-b",
}


async def dispatch_room(lkapi: api.LiveKitAPI, room: str) -> None:
    agent_name = ROOM_AGENT_MAP[room]
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


asyncio.run(main())
