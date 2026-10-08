# Stateful streaming chat demo

Chat history is stored in Restate, keyed by the session URL (`/<chatId>`).
Click **New** for a fresh session; completed turns survive refresh.

Attach files with the **+** menu or paste/drop them into the input.
Inline attachments are saved with history. Supported media depend
on the model. The UI displays files, reasoning, sources, and tool results.

## Run

From the repository root:

```sh
bun install
cp demo/.env.example demo/.env
```

Requires Restate ingress on `8082`, admin on `9070`, and Redis on `6379`.
Edit `demo/.env` with your OpenAI-compatible endpoint, API key, and model.
Bun loads it automatically. Set `REDIS_URL` to override local Redis.

Start each process in its own terminal:

```sh
bun run demo:agent
bun run demo:backend
bun run demo:ui
```

Register the object after the agent starts:

```sh
curl --fail http://localhost:9070/deployments \
  -H 'content-type: application/json' \
  -d '{"uri":"http://127.0.0.1:9092"}'
```

Open http://127.0.0.1:5174.

Each execution has a client-generated request ID used as Restate's idempotency key.
Network retries reuse it; confirmed terminal failures get a new ID on retry.
The same ID returns the original outcome, even if the input changes, within
Restate's retention period. Retries wait for completion, not a live stream.

Restate also stores the current turn. Refresh restores its user message and
reattaches with the same request ID, showing loading or the recorded failure.
Successful completion saves history and clears the current turn.

Local demo only: no authentication or live reconnect.
