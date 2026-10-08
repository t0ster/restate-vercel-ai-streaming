// Chat application: durable generation, conversation storage, and Redis delivery.

import { createOpenAI } from '@ai-sdk/openai';
import * as restate from '@restatedev/restate-sdk';
import {
  convertToModelMessages,
  jsonSchema,
  type ModelMessage,
  readUIMessageStream,
  stepCountIs,
  tool,
  type UIMessage,
  type UIMessageChunk,
  validateUIMessages,
} from 'ai';
import { createClient } from 'redis';
import { durableStreamText, SuperJsonSerde } from '../src/index.ts';

function log(stage: string, detail: unknown = '') {
  console.log(new Date().toISOString(), `[${stage}]`, detail);
}

const gateway = createOpenAI({
  ...(process.env.OPENAI_BASE_URL && { baseURL: process.env.OPENAI_BASE_URL }),
  ...(process.env.OPENAI_API_KEY && { apiKey: process.env.OPENAI_API_KEY }),
});

// Transport belongs to the service, not durableStreamText.
const publisher = createClient({
  url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  disableOfflineQueue: true,
  socket: { connectTimeout: 1000, reconnectStrategy: false },
});
publisher.on('error', (error) => console.error('Demo Redis publisher:', error));
await publisher.connect().catch((error) => {
  console.error('Demo Redis unavailable; live publication disabled:', error);
});

type ChatHistory = {
  modelMessages: ModelMessage[];
  uiMessages: UIMessage[];
  currentTurn?: { requestId: string; message: UIMessage; status: 'pending' | 'failed' };
};
const historySerde = new SuperJsonSerde<ChatHistory>();

const service = restate.object({
  name: 'DurableStreamingChatDemo',
  handlers: {
    history: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => {
      const history = await ctx.get('history', historySerde);
      return { messages: history?.uiMessages ?? [], currentTurn: history?.currentTurn ?? null };
    }),
    run: async (
      ctx: restate.ObjectContext,
      input: { requestId: string; message: unknown; channel?: string },
    ) => {
      let history: ChatHistory | undefined;
      try {
        const [userMessage] = await validateUIMessages({ messages: [input.message] });
        if (userMessage?.role !== 'user') {
          throw new restate.TerminalError('Expected a user message', { errorCode: 400 });
        }
        history = (await ctx.get('history', historySerde)) ?? {
          modelMessages: [],
          uiMessages: [],
        };
        history = {
          ...history,
          currentTurn: { requestId: input.requestId, message: userMessage, status: 'pending' },
        };
        // One state record keeps completed history and the current turn consistent for readers.
        ctx.set('history', history, historySerde);
        const messages: ModelMessage[] = [
          ...history.modelMessages,
          ...(await convertToModelMessages([userMessage])),
        ];
        const result = durableStreamText({
          ctx,
          model: gateway.responses(process.env.OPENAI_MODEL ?? 'gpt-5.5'),
          messages,
          stopWhen: stepCountIs(3),
          providerOptions: { openai: { store: false, reasoningEffort: 'low' } },
          tools: {
            getDemoNumber: tool({
              description: 'Return the number used in this demo.',
              inputSchema: jsonSchema<Record<string, never>>({
                type: 'object',
                properties: {},
                additionalProperties: false,
              }),
              execute: () =>
                ctx.run('demo number', () => {
                  log('TOOL EXECUTING', 'model response already persisted');
                  return { number: 42 };
                }),
            }),
          },
        });
        const uiEvents: UIMessageChunk[] = [];
        for await (const event of result.stream) {
          uiEvents.push(event);
          const message = JSON.stringify(event);
          log('UI', event.type);
          if (input.channel && publisher.isReady) {
            try {
              await publisher.publish(input.channel, message);
            } catch (error) {
              // Loss of live output does not invalidate durable execution.
              console.error('Demo UI event publication failed:', error);
            }
          }
        }
        const response = await result.response;
        // Let the SDK reconstruct the stored UI message; no custom event reducer.
        let assistant: UIMessage | undefined;
        for await (const message of readUIMessageStream({
          stream: new ReadableStream<UIMessageChunk>({
            start(controller) {
              for (const event of uiEvents) controller.enqueue(event);
              controller.close();
            },
          }),
          terminateOnError: true,
        })) {
          assistant = message;
        }
        if (!assistant) throw new restate.TerminalError('Demo produced no assistant message');
        ctx.set(
          'history',
          {
            modelMessages: [...messages, ...response.messages],
            uiMessages: [...history.uiMessages, userMessage, assistant],
          },
          historySerde,
        );
        log('DURABLE RESPONSE', 'history saved');
        return { uiEvents };
      } catch (error) {
        // Return a stable outcome even on Restate versions without the error-source HTTP header.
        if (error instanceof restate.TerminalError) {
          if (history?.currentTurn) {
            ctx.set(
              'history',
              { ...history, currentTurn: { ...history.currentTurn, status: 'failed' } },
              historySerde,
            );
          }
          return { error: 'execution-failed' };
        }
        throw error;
      }
    },
  },
});

restate.serve({ services: [service], port: 9092 });
