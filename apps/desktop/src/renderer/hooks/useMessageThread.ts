import { useCallback, useState } from 'react';
import type { GetMessagesResult, Message } from '@weagent/shared';
import {
  deleteCachedThread,
  getCachedThread,
  refreshThreadFromServer,
  setCachedThread,
} from './messageThreadCache';

export function useMessageThread() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const applyResult = useCallback((convId: string, result: GetMessagesResult, merge?: 'prepend') => {
    if (merge === 'prepend') {
      const cached = getCachedThread(convId);
      const merged = [...result.messages, ...(cached?.messages ?? [])];
      setCachedThread(convId, { messages: merged, hasMore: result.hasMore });
      setMessages(merged);
      setHasMore(result.hasMore);
      return merged;
    }
    setCachedThread(convId, { messages: result.messages, hasMore: result.hasMore });
    setMessages(result.messages);
    setHasMore(result.hasMore);
    return result.messages;
  }, []);

  const loadThread = useCallback(
    async (convId: string, opts?: { force?: boolean }) => {
      const cached = getCachedThread(convId);
      if (cached && !opts?.force) {
        setMessages(cached.messages);
        setHasMore(cached.hasMore);
        return cached.messages;
      }

      if (cached) {
        setMessages(cached.messages);
        setHasMore(cached.hasMore);
      }

      setLoading(true);
      try {
        const result = await refreshThreadFromServer(convId);
        return applyResult(convId, result);
      } finally {
        setLoading(false);
      }
    },
    [applyResult],
  );

  const loadOlder = useCallback(
    async (convId: string) => {
      const cached = getCachedThread(convId);
      if (!cached?.hasMore || cached.messages.length === 0) return;

      setLoadingMore(true);
      try {
        const result = await window.weagent.getMessages(convId, {
          limit: 30,
          before: cached.messages[0].createdAt,
        });
        applyResult(convId, result, 'prepend');
      } finally {
        setLoadingMore(false);
      }
    },
    [applyResult],
  );

  const replaceThread = useCallback(
    (convId: string, result: GetMessagesResult) => {
      applyResult(convId, result);
    },
    [applyResult],
  );

  const invalidate = useCallback((convId: string) => {
    deleteCachedThread(convId);
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setHasMore(false);
  }, []);

  return {
    messages,
    hasMore,
    loading,
    loadingMore,
    loadThread,
    loadOlder,
    replaceThread,
    invalidate,
    clear,
    setMessages,
  };
}
