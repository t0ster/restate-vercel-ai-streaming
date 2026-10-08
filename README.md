# restate-vercel-ai-streaming

Stream AI SDK UI events while Restate durably records model responses.

## Usage

```sh
bun add restate-vercel-ai-streaming ai @ai-sdk/openai @restatedev/restate-sdk
```

```ts
import { openai } from '@ai-sdk/openai';
import * as restate from '@restatedev/restate-sdk';
import { jsonSchema, type ModelMessage, stepCountIs, tool, type UIMessageChunk } from 'ai';
import { durableStreamText, SuperJsonSerde } from 'restate-vercel-ai-streaming';

const historySerde = new SuperJsonSerde<ModelMessage[]>();

const chat = restate.object({
  name: 'Chat',
  handlers: {
    reply: async (ctx: restate.ObjectContext, input: { prompt: string }) => {
      // Restate scopes state and serializes turns by chat ID (ctx.key).
      const history = (await ctx.get('history', historySerde)) ?? [];
      const messages: ModelMessage[] = [
        ...history,
        { role: 'user', content: input.prompt },
      ];
      const result = durableStreamText({
        ctx,
        model: openai('gpt-5.5'),
        messages,
        tools: {
          getDemoNumber: tool({
            description: 'Return the demo number.',
            inputSchema: jsonSchema<Record<string, never>>({
              type: 'object',
              properties: {},
              additionalProperties: false,
            }),
            execute: () => ctx.run('get demo number', () => 42),
          }),
        },
        stopWhen: stepCountIs(3),
      });

      const uiEvents: UIMessageChunk[] = [];
      for await (const event of result.stream) {
        uiEvents.push(event);
        // Replace this with your delivery transport, e.g. Redis pub/sub.
        console.log(event);
      }

      const { messages: responseMessages } = await result.response;
      ctx.set('history', [...messages, ...responseMessages], historySerde);
      return { uiEvents };
    },
  },
});

restate.serve({ services: [chat], port: 9080 });
```

Set `OPENAI_API_KEY`, run the service, and register it with your Restate server.
Invoke it through Restate, using the chat ID as the object key:

```sh
curl http://localhost:8080/Chat/my-chat-id/reply \
  -H 'content-type: application/json' \
  -H 'idempotency-key: my-request-id' \
  -d '{"prompt":"What is the demo number?"}'
```

Use the same chat ID for follow-up turns. Use a new request ID for each turn;
reuse it when retrying an uncertain request.

- `result.stream` emits native AI SDK UI events for your client transport.
- `result.response` resolves to `{ text, messages }` after durable completion.
- Model responses are persisted before application tools execute. Wrap tool
  work in `ctx.run`; external side effects still need their own idempotency.

The library does not manage HTTP delivery or chat history. It also exports
`SuperJsonSerde` for storing richer values in application-owned Restate state.

See the [chat demo](demo/README.md) for a complete UI, history, and retry flow.
