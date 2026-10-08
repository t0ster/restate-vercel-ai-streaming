import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { Context, Serde } from '@restatedev/restate-sdk';
import {
  type ModelMessage,
  streamText,
  type ToolSet,
  toUIMessageStream,
  type UIMessageChunk,
  wrapLanguageModel,
} from 'ai';
import superjson from 'superjson';

/** Restate serialization preserving SuperJSON-supported values; not runtime validation. */
export class SuperJsonSerde<T> implements Serde<T> {
  contentType = 'application/json';

  serialize(value: T): Uint8Array {
    return new TextEncoder().encode(superjson.stringify(value));
  }

  deserialize(data: Uint8Array): T {
    return superjson.parse<T>(new TextDecoder().decode(data));
  }
}

/**
 * Streams AI SDK UI events while recording completed model responses in Restate.
 * Complete tool calls are released only after persistence; tool side effects
 * still require their own durable boundaries.
 *
 * Cancelling the UI reader detaches presentation without cancelling execution.
 * Buffers are unbounded, replay republishes UI events, provider HTTP metadata is
 * not forwarded, and interrupted work may repeat provisional output.
 */
export function durableStreamText({
  ctx,
  model,
  messages,
  tools,
  stopWhen,
  providerOptions,
}: {
  ctx: Context;
  model: LanguageModelV4;
  messages: ModelMessage[];
  tools: ToolSet;
  stopWhen?: Parameters<typeof streamText>[0]['stopWhen'];
  providerOptions?: Parameters<typeof streamText>[0]['providerOptions'];
}): {
  stream: ReadableStream<UIMessageChunk>;
  response: Promise<{ text: string; messages: ModelMessage[] }>;
} {
  let uiController: ReadableStreamDefaultController<UIMessageChunk> | undefined;
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      uiController = controller;
    },
    // Disconnecting presentation does not cancel durable execution.
    cancel() {
      uiController = undefined;
    },
  });

  const response = (async () => {
    try {
      const result = streamText({
        abortSignal: ctx.request().attemptCompletedSignal,
        model: wrapLanguageModel({
          model,
          middleware: {
            specificationVersion: 'v4',
            wrapStream: async ({ doStream }) => ({
              stream: new ReadableStream<LanguageModelV4StreamPart>({
                async start(controller) {
                  // Zero on replay: all recorded chunks must reach SDK execution.
                  let delivered = 0;
                  try {
                    const chunks = await ctx.run(
                      'durable model stream',
                      async () => {
                        const chunks: LanguageModelV4StreamPart[] = [];
                        const { stream } = await doStream();
                        const reader = stream.getReader();
                        let gated = false;
                        let finished = false;
                        try {
                          while (true) {
                            const { done, value: event } = await reader.read();
                            if (done) break;
                            if (event.type === 'error') throw event.error;
                            if (event.type === 'finish') finished = true;
                            // SDK may execute on tool-call, not just on finish.
                            // Preserve ordering by retaining the entire tail.
                            if (event.type === 'tool-call' || event.type === 'finish') {
                              gated = true;
                            }
                            chunks.push(event);
                            if (!gated) {
                              controller.enqueue(event);
                              delivered++;
                            }
                          }
                        } catch (error) {
                          // Stop the provider source without masking the original failure.
                          try {
                            await reader.cancel(error);
                          } catch {
                            // Cancellation may fail if the source has already errored.
                          }
                          throw error;
                        } finally {
                          reader.releaseLock();
                        }
                        if (!finished) {
                          throw new Error('Durable model stream ended without a finish event');
                        }
                        return chunks;
                      },
                      {
                        serde: new SuperJsonSerde<LanguageModelV4StreamPart[]>(),
                        // Partial output is not reconciled across retries.
                        maxRetryAttempts: 1,
                      },
                    );
                    for (const event of chunks.slice(delivered)) controller.enqueue(event);
                    controller.close();
                  } catch (error) {
                    controller.error(error);
                  }
                },
              }),
            }),
          },
        }),
        messages,
        tools,
        maxRetries: 0,
        ...(stopWhen === undefined ? {} : { stopWhen }),
        ...(providerOptions === undefined ? {} : { providerOptions }),
      });

      const uiStream = toUIMessageStream({
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              // Reject fatal generation errors instead of converting them into UI error text.
              // Let tool-error events pass through so the SDK can show them and the model can recover.
              if (part.type === 'error') throw part.error;
              controller.enqueue(part);
            },
          }),
        ),
        tools,
        generateMessageId: () => ctx.rand.uuidv4(),
        sendFinish: false,
        sendSources: true,
        sendReasoning: true,
      });
      for await (const event of uiStream) uiController?.enqueue(event);
      const text = await result.text;
      const responseMessages = await result.responseMessages;
      const recorded = await ctx.run(
        'durable final response',
        () => ({ text, messages: responseMessages }),
        { serde: new SuperJsonSerde<{ text: string; messages: ModelMessage[] }>() },
      );
      uiController?.enqueue({ type: 'finish' });
      uiController?.close();
      return recorded;
    } catch (error) {
      uiController?.error(error);
      throw error;
    }
  })();
  void response.catch(() => {});
  return { stream, response };
}
