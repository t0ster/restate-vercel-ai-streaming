// Example backend. Redis carries SDK-generated UI events from the chat object.
// Chat history is held by a keyed Restate object; retries reuse its recorded UI events.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, rpc } from '@restatedev/restate-sdk-clients';
import { createUIMessageStream, pipeUIMessageStreamToResponse, type UIMessageChunk } from 'ai';
import { createClient } from 'redis';
import type { ChatService } from './agent.ts';

const restate = connect({ url: process.env.RESTATE_INGRESS_URL ?? 'http://localhost:8082' });
const chatService: ChatService = { name: 'DurableStreamingChatDemo' };

async function getChatHistory(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const chatId = url.searchParams.get('chatId');
  if (!chatId || !/^[a-zA-Z0-9_-]{1,80}$/.test(chatId)) {
    response.writeHead(400).end('Invalid chatId');
    return;
  }
  try {
    const history = await restate.objectClient(chatService, chatId).history();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(history));
  } catch (error) {
    console.error('Demo history request failed:', error);
    response.writeHead(502).end('History unavailable');
  }
}

async function parseChatRequest(request: IncomingMessage) {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) body += chunk;
  const input: unknown = JSON.parse(body);
  if (
    typeof input !== 'object' ||
    input === null ||
    !('message' in input) ||
    !('requestId' in input) ||
    typeof input.requestId !== 'string' ||
    !input.requestId ||
    !('chatId' in input) ||
    typeof input.chatId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(input.chatId)
  ) {
    throw new Error('Demo chat requires chatId, requestId, and message');
  }
  return { message: input.message, requestId: input.requestId, chatId: input.chatId };
}

async function streamChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let input: Awaited<ReturnType<typeof parseChatRequest>>;
  try {
    input = await parseChatRequest(request);
  } catch {
    response.writeHead(400).end('Expected chatId, requestId, and message');
    return;
  }

  const { message, requestId, chatId } = input;
  const channel = `durable-streaming-demo:${randomUUID()}`;
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({
        type: 'data-delivery-status',
        data: { status: 'waiting' },
        transient: true,
      });
      const subscriber = createClient({
        url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      });
      subscriber.on('error', (error) => console.error('Redis subscriber:', error));
      let eventFailure: { error: unknown } | undefined;
      let receivedLiveEvents = false;
      const writeEvent = (event: UIMessageChunk) => {
        if (event.type !== 'finish') writer.write(event);
      };
      try {
        await subscriber.connect();
        await subscriber.subscribe(channel, (message) => {
          if (eventFailure) return;
          try {
            if (!receivedLiveEvents) {
              writer.write({
                type: 'data-delivery-status',
                data: { status: 'streaming' },
                transient: true,
              });
            }
            writeEvent(JSON.parse(message));
            receivedLiveEvents = true;
          } catch (error) {
            eventFailure = { error };
          }
        });

        console.log('Subscribed; invoking Restate:', channel);
        const result = await restate
          .objectClient(chatService, chatId)
          .run({ requestId, message, channel }, rpc.opts({ idempotencyKey: requestId }));
        // The chat object awaits each publish. Wait for the unsubscribe acknowledgement so
        // preceding messages on this subscription are processed before finish.
        await subscriber.unsubscribe(channel);
        if (eventFailure) throw eventFailure.error;

        // A duplicate invocation publishes to the original request's channel, not this one.
        if (!receivedLiveEvents) {
          writer.write({
            type: 'data-delivery-status',
            data: { status: 'replaying' },
            transient: true,
          });
          for (const event of result.uiEvents) writeEvent(event);
        }

        // Provider finish events do not finish the UI message. Only successful
        // completion of the Restate invocation reaches this line.
        writer.write({ type: 'finish' });
        // Returning from execute closes the stream; there is no writer.close().
      } finally {
        if (subscriber.isOpen) subscriber.destroy();
      }
    },
    onError: (error) => {
      console.error('Demo chat failed:', error);
      return 'Chat request failed.';
    },
  });

  try {
    await pipeUIMessageStreamToResponse({ response, stream });
  } catch (error) {
    console.error('Demo HTTP stream failed:', error);
    response.destroy();
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/api/chat/history') {
    return getChatHistory(request, response);
  }
  if (request.method === 'POST' && request.url === '/api/chat') {
    return streamChat(request, response);
  }
  response.writeHead(404).end();
}).listen(Number(process.env.BACKEND_PORT ?? 3002), '127.0.0.1', () => {
  console.log(`Demo backend: http://localhost:${process.env.BACKEND_PORT ?? 3002}/api/chat`);
});
