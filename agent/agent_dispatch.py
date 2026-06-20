import asyncio
from dotenv import load_dotenv
from livekit import api

load_dotenv()

async def main():
    lkapi = api.LiveKitAPI()

    dispatch = await lkapi.agent_dispatch.create_dispatch(
        api.CreateAgentDispatchRequest(
            room="experiment-001",
            agent_name="pms-agent",
            metadata="{}",
        )
    )

    print(dispatch)
    await lkapi.aclose()

asyncio.run(main())