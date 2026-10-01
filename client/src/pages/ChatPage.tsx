import { getSocket } from '@/lib/socket';
import { useEffect, useState } from 'react';
import { Card, EmptyState, PageLoader } from '@/components/ui';

interface ConversationRow {
  id: string;
  counterpart: { id: string; name: string } | null;
  preview: string;
  unread: number;
}

export function ChatPage() {
  const [conversations, setConversations] = useState<ConversationRow[] | null>(null);

  useEffect(() => {
    const socket = getSocket();
    const load = async () => {
      try {
        const response = await fetch('/api/chat/conversations', { credentials: 'include' });
        const body = (await response.json()) as { data?: { conversations: ConversationRow[] } };
        setConversations(body.data?.conversations ?? []);
      } catch {
        setConversations([]);
      }
    };
    void load();
    socket.connect();
    const onUpdate = () => void load();
    socket.on('conversation:updated', onUpdate);
    return () => {
      socket.off('conversation:updated', onUpdate);
    };
  }, []);

  if (conversations === null) return <PageLoader />;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-5 py-14">
      <h1 className="text-display text-4xl font-semibold tracking-tight">Messages</h1>
      {conversations.length === 0 ? (
        <EmptyState title="No conversations yet" hint="Start a thread from a project or booking." />
      ) : (
        <div className="space-y-3">
          {conversations.map((c) => (
            <Card key={c.id} className="flex items-center justify-between gap-4">
              <div>
                <p className="font-medium text-white">{c.counterpart?.name ?? 'Unknown'}</p>
                <p className="truncate text-sm text-ink-400">{c.preview}</p>
              </div>
              {c.unread > 0 && (
                <span className="rounded-full bg-amber-400 px-2.5 py-1 text-xs font-semibold text-ink-950">
                  {c.unread}
                </span>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
