from dotenv import load_dotenv
from livekit import agents

load_dotenv()

async def entrypoint(ctx: agents.JobContext):
    await ctx.connect()
    print("Agent connected to room")

if __name__ == "__main__":
    agents.cli.run_app(
        agents.WorkerOptions(entrypoint_fnc=entrypoint)
    )