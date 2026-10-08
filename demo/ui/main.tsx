// Example chat UI. Restate stores history; useChat applies live UI events.

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, isToolUIPart, type UIMessage } from 'ai';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from '@/components/ai-elements/attachments';
import { CodeBlock } from '@/components/ai-elements/code-block';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import './style.css';

const sessionPath = /^\/([a-zA-Z0-9_-]{1,80})\/?$/.exec(window.location.pathname);
const chatId = sessionPath?.[1] ?? crypto.randomUUID();
if (!sessionPath) window.history.replaceState(null, '', `/${chatId}`);

const transport = new DefaultChatTransport({
  api: '/api/chat',
  prepareSendMessagesRequest: ({ messages, body }) => {
    const latestUser = [...messages].reverse().find((message) => message.role === 'user');
    return { body: { ...body, message: latestUser, chatId } };
  },
});

function ChatAttachmentPreviews() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <Attachments variant="inline">
      {attachments.files.map((file) => (
        <Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
          <AttachmentPreview />
          <AttachmentInfo />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  );
}

type DeliveryStatus = 'waiting' | 'streaming' | 'replaying';

function StreamingChatDemo() {
  const [deliveryStatus, setDeliveryStatus] = useState<DeliveryStatus>('waiting');
  const requestId = useRef('');
  const [prompt, setPrompt] = useState(
    'Call getDemoNumber once, then explain the number in three short sentences.',
  );
  const { messages, setMessages, sendMessage, regenerate, status, error } = useChat({
    id: chatId,
    transport,
    onData: (part) => {
      if (part.type === 'data-delivery-status') {
        setDeliveryStatus((part.data as { status: DeliveryStatus }).status);
      }
    },
  });
  const [loaded, setLoaded] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [attachmentError, setAttachmentError] = useState<string>();
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`/api/chat/history?chatId=${encodeURIComponent(chatId)}`);
        if (!response.ok) throw new Error('Could not load chat history');
        const {
          messages: history,
          currentTurn,
        }: {
          messages: UIMessage[];
          currentTurn: {
            requestId: string;
            message: UIMessage;
            status: 'pending' | 'failed';
          } | null;
        } = await response.json();
        if (active) {
          setMessages(currentTurn ? [...history, currentTurn.message] : history);
          setLoaded(true);
          if (currentTurn) {
            requestId.current = currentTurn.requestId;
            // Reattach even to failed turns: the recorded outcome restores useChat's native error.
            void regenerate({ body: { requestId: requestId.current } });
          }
        }
      } catch (error) {
        if (active) setHistoryError(error instanceof Error ? error.message : 'History unavailable');
      }
    })();
    return () => {
      active = false;
    };
  }, [setMessages, regenerate]);
  const busy = status === 'submitted' || status === 'streaming';

  return (
    <TooltipProvider>
      <main className="mx-auto flex h-dvh max-w-4xl flex-col px-4">
        <header className="border-b py-5">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-xl font-semibold tracking-tight">Durable chat</h1>
            <Button
              variant="outline"
              onClick={() => {
                window.location.assign(`/${crypto.randomUUID()}`);
              }}
            >
              New
            </Button>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">AI SDK + Restate · AI Elements</p>
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">Chat {chatId}</p>
        </header>

        <Conversation className="min-h-0 flex-1">
          <ConversationContent>
            {messages.length === 0 && (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Send a prompt to watch durable tool execution and live text.
              </p>
            )}
            {messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.parts.map((part, index) => {
                    if (part.type === 'text') {
                      // biome-ignore lint/suspicious/noArrayIndexKey: Streamed text parts have no ID; their positions stay stable as content grows.
                      return <MessageResponse key={index}>{part.text}</MessageResponse>;
                    }
                    if (part.type === 'reasoning') {
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: SDK reasoning parts retain their positions during streaming.
                        <Reasoning key={index} isStreaming={part.state === 'streaming'}>
                          <ReasoningTrigger />
                          <ReasoningContent>{part.text}</ReasoningContent>
                        </Reasoning>
                      );
                    }
                    if (
                      part.type === 'file' ||
                      part.type === 'reasoning-file' ||
                      part.type === 'source-document'
                    ) {
                      const id = `${message.id}-${index}`;
                      const data =
                        part.type === 'reasoning-file'
                          ? { ...part, type: 'file' as const, id }
                          : { ...part, id };
                      return (
                        <Attachments key={id} variant="list">
                          <Attachment data={data}>
                            <AttachmentPreview />
                            <AttachmentInfo />
                            {'url' in part && (
                              <a
                                href={part.url}
                                download={
                                  'filename' in part
                                    ? (part.filename ?? 'attachment')
                                    : 'attachment'
                                }
                                target="_blank"
                                rel="noreferrer"
                                className="text-sm underline"
                              >
                                Open file
                              </a>
                            )}
                          </Attachment>
                        </Attachments>
                      );
                    }
                    if (part.type === 'source-url') {
                      return (
                        <Sources key={part.sourceId}>
                          <SourcesTrigger count={1} />
                          <SourcesContent>
                            <Source href={part.url} title={part.title ?? part.url} />
                          </SourcesContent>
                        </Sources>
                      );
                    }
                    if (isToolUIPart(part)) {
                      return (
                        <Tool key={part.toolCallId} defaultOpen>
                          {part.type === 'dynamic-tool' ? (
                            <ToolHeader
                              type={part.type}
                              state={part.state}
                              toolName={part.toolName}
                            />
                          ) : (
                            <ToolHeader type={part.type} state={part.state} />
                          )}
                          <ToolContent>
                            {part.input !== undefined && <ToolInput input={part.input} />}
                            <ToolOutput output={part.output} errorText={part.errorText} />
                          </ToolContent>
                        </Tool>
                      );
                    }
                    if (part.type === 'step-start') return null;
                    // Custom content/data has application-specific semantics; show it without dropping it.
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: SDK parts retain their positions during streaming.
                      <CodeBlock key={index} code={JSON.stringify(part, null, 2)} language="json" />
                    );
                  })}
                </MessageContent>
              </Message>
            ))}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <footer className="border-t py-4">
          <PromptInput
            multiple
            onError={({ message }) => setAttachmentError(message)}
            onSubmit={async ({ text, files }) => {
              if (!loaded || busy || (!text.trim() && files.length === 0)) return;
              setAttachmentError(undefined);
              setPrompt('');
              requestId.current = crypto.randomUUID();
              await sendMessage(
                { text: text.trim(), files },
                { body: { requestId: requestId.current } },
              );
            }}
          >
            <ChatAttachmentPreviews />
            <PromptInputTextarea
              aria-label="Prompt"
              placeholder="Ask something…"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <PromptInputFooter>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger aria-label="Add attachments" />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
              <span className="ml-auto px-2 text-right text-xs text-muted-foreground" role="status">
                {!loaded
                  ? 'Loading history…'
                  : busy
                    ? deliveryStatus === 'streaming'
                      ? 'Receiving live response…'
                      : 'Waiting for response…'
                    : status === 'ready'
                      ? messages.length
                        ? 'Completed'
                        : 'Ready'
                      : status}
              </span>
              <PromptInputSubmit
                aria-label="Send message"
                status={status}
                disabled={!loaded || busy}
              />
            </PromptInputFooter>
          </PromptInput>
          {(error || historyError || attachmentError) && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error?.message === 'execution-failed'
                ? 'Execution failed. Retry starts a new execution.'
                : error?.message === 'delivery-failed'
                  ? 'Connection failed. Retry retrieves the existing execution.'
                  : (error?.message ?? historyError ?? attachmentError)}
            </p>
          )}
          {error && (
            <Button
              variant="outline"
              className="mt-2"
              disabled={busy}
              onClick={() => {
                if (error.message === 'execution-failed') requestId.current = crypto.randomUUID();
                void regenerate({ body: { requestId: requestId.current } });
              }}
            >
              Retry
            </Button>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Refresh restores pending turns and waits for their result. Network retries reuse the
            execution; terminal failures start a new one.
          </p>
        </footer>
      </main>
    </TooltipProvider>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Demo React root is missing');
createRoot(root).render(<StreamingChatDemo />);
