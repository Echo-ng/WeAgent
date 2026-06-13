import type { Conversation, GetMessagesOptions, Message } from '@weagent/shared';
import { DatabaseService } from './database.js';

export class SessionManager {
  constructor(private db: DatabaseService) {}

  createConversation(input: {
    title: string;
    channel?: Conversation['channel'];
    channelPeerId?: string;
    cwd: string;
    activeAgentId?: string;
  }): Conversation {
    return this.db.createConversation({
      title: input.title,
      channel: input.channel ?? 'local',
      channelPeerId: input.channelPeerId,
      cwd: input.cwd,
      activeAgentId: input.activeAgentId,
    });
  }

  getOrCreateForChannel(
    channel: string,
    peerId: string,
    cwd: string,
    activeAgentId?: string,
  ): Conversation {
    const binding = this.db.getBinding(channel, peerId);
    if (binding) {
      const conv = this.db.getConversation(binding.conversationId);
      if (conv) return conv;
    }
    const conv = this.createConversation({
      title: `${channel} - ${peerId.slice(0, 8)}`,
      channel: channel as Conversation['channel'],
      channelPeerId: peerId,
      cwd,
      activeAgentId,
    });
    this.db.setBinding({ channel, peerId, conversationId: conv.id });
    return conv;
  }

  switchConversation(channel: string, peerId: string, conversationId: string): boolean {
    const conv = this.db.getConversation(conversationId);
    if (!conv) return false;
    this.db.setBinding({ channel, peerId, conversationId });
    return true;
  }

  getBinding(channel: string, peerId: string) {
    return this.db.getBinding(channel, peerId);
  }

  updateWeChatContext(peerId: string, contextToken: string): void {
    if (!contextToken.trim()) return;
    this.db.updateBindingContextToken('wechat', peerId, contextToken);
  }

  getWeChatContextToken(peerId: string): string | undefined {
    return this.db.getBinding('wechat', peerId)?.lastContextToken;
  }

  getConversation(id: string): Conversation | null {
    return this.db.getConversation(id);
  }

  listConversations(limit?: number): Conversation[] {
    return this.db.listConversations(limit);
  }

  updateConversation(id: string, patch: Partial<Conversation>): Conversation | null {
    return this.db.updateConversation(id, patch);
  }

  addUserMessage(
    conversationId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Message {
    return this.db.addMessage({
      conversationId,
      role: 'user',
      content,
      contentType: 'text',
      metadata,
    });
  }

  addAssistantMessage(
    conversationId: string,
    content: string,
    contentType: Message['contentType'] = 'text',
    metadata?: Record<string, unknown>,
  ): Message {
    return this.db.addMessage({
      conversationId,
      role: 'assistant',
      content,
      contentType,
      metadata,
    });
  }

  getMessages(conversationId: string, options?: GetMessagesOptions) {
    return this.db.getMessages(conversationId, options);
  }

  hasAssistantMessage(conversationId: string): boolean {
    return this.db.hasAssistantMessage(conversationId);
  }

  deleteConversation(id: string): boolean {
    return this.db.deleteConversation(id);
  }
}
