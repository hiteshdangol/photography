import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Send } from 'lucide-react';
import { toast } from 'sonner';
import { request, errorMessage } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAuth } from '@/context/AuthContext';
import { Avatar, Button, Card, EmptyState, PageLoader } from '@/components/ui';
import { cn } from '@/lib/cn';

interface ConversationRow {
  id: string;
  projectId: string | null;
  counterpart: { id: string; name: string; avatar?: string | null; role?: string } | null;
  lastMessageAt: string | null;
  preview: string | null;
  messageCount: number;
  unread: number;
}

interface MessageRow {
  id: string;
  conversationId: string;
  senderId: string;
  senderRole: string;
  message: string;
  deleted: boolean;
  mine: boolean;
  editedAt: string | null;
  createdAt: string;
}

/** Payload of the server's `message:new` broadcast (sockets/io.ts). */
interface SocketMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderRole: string;
  message: string;
  createdAt: string;
  tempId?: string | null;
}

const messagesKey = (conversationId: string) => ['chat', 'messages', conversationId] as const;

export function ChatPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('c');

  const [draft, setDraft] = useState('');
  const [peerTyping, setPeerTyping] = useState(false);
  const [peerOnline, setPeerOnline] = useState<boolean | null>(null);
  const typingStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);

  const conversations = useQuery({
    queryKey: ['chat', 'conversations'],
    queryFn: () => request<{ conversations: ConversationRow[] }>({ url: '/chat/conversations' }),
  });

  // Memoised so the derived-thread and default-selection effects below do not
  // re-run on every render just because the fallback array is new.
  const rows = useMemo(() => conversations.data?.conversations ?? [], [conversations.data]);
  const active = useMemo(() => rows.find((c) => c.id === selectedId) ?? null, [rows, selectedId]);

  // Default to the newest thread so the page is never an empty two-pane layout.
  useEffect(() => {
    if (selectedId || rows.length === 0) return;
    setSearchParams({ c: rows[0]!.id }, { replace: true });
  }, [rows, selectedId, setSearchParams]);

  const messages = useQuery({
    queryKey: messagesKey(selectedId ?? ''),
    queryFn: () =>
      request<{ messages: MessageRow[]; hasMore: boolean; nextBefore: string | null }>({
        url: `/chat/conversations/${selectedId}/messages`,
      }),
    enabled: Boolean(selectedId),
  });

  /* --- realtime ---------------------------------------------------------- */

  useEffect(() => {
    const socket = getSocket();
    socket.connect();

    const join = () => {
      if (selectedId) socket.emit('conversation:join', { conversationId: selectedId });
    };
    const onNew = (payload: SocketMessage) => {
      queryClient.setQueryData<{ messages: MessageRow[]; hasMore: boolean; nextBefore: string | null }>(
        messagesKey(payload.conversationId),
        (previous) => {
          const list = previous?.messages ?? [];
          // The sender already appended optimistically; drop the echo.
          if (list.some((m) => m.id === payload.id)) return previous;
          const incoming: MessageRow = {
            id: payload.id,
            conversationId: payload.conversationId,
            senderId: payload.senderId,
            senderRole: payload.senderRole,
            message: payload.message,
            deleted: false,
            mine: payload.senderId === user?.id,
            editedAt: null,
            createdAt: payload.createdAt,
          };
          return { messages: [...list, incoming], hasMore: previous?.hasMore ?? false, nextBefore: previous?.nextBefore ?? null };
        },
      );
      void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
    };

    const onConversationUpdated = () => {
      void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
    };
    const onTypingStart = (payload: { conversationId: string; userId: string }) => {
      if (payload.conversationId !== selectedId || payload.userId === user?.id) return;
      setPeerTyping(true);
    };
    const onTypingStop = (payload: { conversationId: string; userId: string }) => {
      if (payload.conversationId !== selectedId || payload.userId === user?.id) return;
      setPeerTyping(false);
    };
    const onPresence = (payload: { userId: string; online: boolean }) => {
      if (!active || payload.userId !== active.counterpart?.id) return;
      setPeerOnline(payload.online);
    };

    socket.on('connect', join);
    socket.on('message:new', onNew);
    socket.on('chat:message', onNew);
    socket.on('conversation:updated', onConversationUpdated);
    socket.on('typing:start', onTypingStart);
    socket.on('typing:stop', onTypingStop);
    socket.on('presence:online', onPresence);
    socket.on('presence:offline', onPresence);
    socket.on('presence:state', onPresence);
    join();

    return () => {
      if (selectedId) socket.emit('conversation:leave', { conversationId: selectedId });
      socket.off('connect', join);
      socket.off('message:new', onNew);
      socket.off('chat:message', onNew);
      socket.off('conversation:updated', onConversationUpdated);
      socket.off('typing:start', onTypingStart);
      socket.off('typing:stop', onTypingStop);
      socket.off('presence:online', onPresence);
      socket.off('presence:offline', onPresence);
      socket.off('presence:state', onPresence);
    };
  }, [selectedId, user?.id, active, queryClient]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.data?.messages.length, peerTyping]);

  const send = useMutation({
    mutationFn: (message: string) =>
      request<{ message: MessageRow }>({
        url: `/chat/conversations/${selectedId}/messages`,
        method: 'POST',
        data: { message },
      }),
    onSuccess: () => {
      setDraft('');
      void queryClient.invalidateQueries({ queryKey: ['chat', 'messages', selectedId] });
      void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not send that message.')),
  });

  function onDraftChange(value: string) {
    setDraft(value);
    const socket = getSocket();
    if (!selectedId) return;

    socket.emit('typing:start', { conversationId: selectedId });
    if (typingStopTimer.current) clearTimeout(typingStopTimer.current);
    typingStopTimer.current = setTimeout(() => {
      socket.emit('typing:stop', { conversationId: selectedId });
    }, 1200);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !selectedId) return;
    send.mutate(body);
  }

  if (conversations.isPending) return <PageLoader />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-display text-3xl font-semibold tracking-tight">Messages</h1>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No conversations yet" hint="Start a thread from a project or booking." />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          {/* Thread list */}
          <div className="space-y-2">
            {rows.map((conversation) => {
              const isActive = conversation.id === selectedId;
              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => setSearchParams({ c: conversation.id })}
                  aria-current={isActive ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                    isActive
                      ? 'border-amber-400/40 bg-ink-800'
                      : 'border-ink-700 bg-ink-900/60 hover:border-ink-600 hover:bg-ink-800/60',
                  )}
                >
                  <Avatar name={conversation.counterpart?.name} src={conversation.counterpart?.avatar} size={40} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-white">
                      {conversation.counterpart?.name ?? 'Unknown'}
                    </span>
                    <span className="block truncate text-xs text-ink-400">
                      {conversation.preview ?? 'No messages yet'}
                    </span>
                  </span>
                  {conversation.unread > 0 && (
                    <span className="rounded-full bg-amber-400 px-2 py-0.5 text-xs font-semibold text-ink-950">
                      {conversation.unread}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Thread */}
          <Card className="flex min-h-[60vh] flex-col p-0">
            {!active ? (
              <div className="flex flex-1 items-center justify-center p-6">
                <EmptyState title="Pick a conversation" hint="Choose a thread on the left." />
              </div>
            ) : (
              <>
                <header className="flex items-center gap-3 border-b border-ink-700 px-5 py-4">
                  <Avatar name={active.counterpart?.name} src={active.counterpart?.avatar} size={36} />
                  <div>
                    <p className="text-sm font-medium text-white">{active.counterpart?.name ?? 'Unknown'}</p>
                    <p className="text-xs text-ink-400">
                      {peerTyping ? (
                        <span className="text-amber-300">typing…</span>
                      ) : peerOnline === null ? (
                        active.counterpart?.role ?? ''
                      ) : peerOnline ? (
                        'Online'
                      ) : (
                        'Offline'
                      )}
                    </p>
                  </div>
                </header>

                <div className="flex-1 space-y-3 overflow-y-auto px-5 py-5">
                  {messages.isPending ? (
                    <p className="text-sm text-ink-400">Loading messages…</p>
                  ) : messages.isError ? (
                    <EmptyState title="We could not load this conversation." hint="Try again in a moment." />
                  ) : (messages.data?.messages.length ?? 0) === 0 ? (
                    <EmptyState title="No messages yet" hint="Say hello to get started." />
                  ) : (
                    messages.data!.messages.map((message) => (
                      <div
                        key={message.id}
                        className={cn('flex', message.mine ? 'justify-end' : 'justify-start')}
                      >
                        <div
                          className={cn(
                            'max-w-[min(34rem,80%)] rounded-2xl px-4 py-2.5 text-sm',
                            message.mine
                              ? 'bg-amber-400 text-ink-950'
                              : 'border border-ink-700 bg-ink-800 text-ink-100',
                          )}
                        >
                          {message.deleted ? (
                            <em className="text-ink-400">Message deleted</em>
                          ) : (
                            <>
                              <p className="whitespace-pre-wrap break-words">{message.message}</p>
                              <p
                                className={cn(
                                  'mt-1 text-[10px]',
                                  message.mine ? 'text-ink-800' : 'text-ink-500',
                                )}
                              >
                                {new Date(message.createdAt).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                                {message.editedAt ? ' · edited' : ''}
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={listEndRef} />
                </div>

                <form onSubmit={submit} className="flex items-end gap-2 border-t border-ink-700 px-5 py-4">
                  <label className="flex-1" htmlFor="chat-draft">
                    <span className="sr-only">Message</span>
                    <textarea
                      id="chat-draft"
                      rows={1}
                      value={draft}
                      onChange={(event) => onDraftChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          submit(event);
                        }
                      }}
                      placeholder="Write a message…"
                      className="max-h-32 min-h-11 w-full resize-none rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-3 text-sm text-white placeholder:text-ink-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/20"
                    />
                  </label>
                  <Button type="submit" disabled={!draft.trim()} loading={send.isPending} aria-label="Send message">
                    <Send className="size-4" />
                  </Button>
                </form>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}