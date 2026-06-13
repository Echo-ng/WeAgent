import type { GetMessagesResult, Message } from '@weagent/shared';

const PAGE_SIZE = 30;

export interface CachedThread {
  messages: Message[];
  hasMore: boolean;
}

const threadCache = new Map<string, CachedThread>();

export function getCachedThread(convId: string): CachedThread | undefined {
  return threadCache.get(convId);
}

export function setCachedThread(convId: string, thread: CachedThread): void {
  threadCache.set(convId, thread);
}

export function deleteCachedThread(convId: string): void {
  threadCache.delete(convId);
}

export async function refreshThreadFromServer(convId: string): Promise<GetMessagesResult> {
  const result = await window.weagent.getMessages(convId, { limit: PAGE_SIZE });
  setCachedThread(convId, { messages: result.messages, hasMore: result.hasMore });
  return result;
}
