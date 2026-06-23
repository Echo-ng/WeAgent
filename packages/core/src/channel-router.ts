import { randomUUID } from 'node:crypto';
import type { SavedImageAttachment, StreamEvent, WeChatIncomingMessage } from '@weagent/shared';
import { mergeStreamText, splitWeChatText } from '@weagent/shared';
import type { MultiAgentOrchestrator } from './orchestrator.js';
import type { SessionManager } from './session-manager.js';
import type { AgentRegistry } from './agent-registry.js';

export interface ChannelAdapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(toUserId: string, text: string, contextToken: string): Promise<void>;
  sendTyping?(toUserId: string, contextToken: string): Promise<void>;
}

export class ChannelRouter {
  private adapters = new Map<string, ChannelAdapter>();
  private defaultCwd: string;
  private wechatPeerQueues = new Map<string, Promise<void>>();

  constructor(
    private sessionManager: SessionManager,
    private orchestrator: MultiAgentOrchestrator,
    private agentRegistry: AgentRegistry,
    defaultCwd: string,
    private onEvent?: (event: StreamEvent) => void,
  ) {
    this.defaultCwd = defaultCwd;
  }

  setDefaultCwd(cwd: string): void {
    this.defaultCwd = cwd;
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  async startAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  getAdapter(name: string): ChannelAdapter | undefined {
    return this.adapters.get(name);
  }

  async handleWeChatMessage(msg: WeChatIncomingMessage): Promise<void> {
    const commandResult = this.handleCommand(msg);
    if (commandResult !== null) {
      const adapter = this.adapters.get('wechat');
      if (!adapter) return;
      for (const chunk of splitWeChatText(commandResult.text)) {
        await adapter.sendMessage(msg.fromUserId, chunk, msg.contextToken);
      }
      if (commandResult.conversationId) {
        this.onEvent?.({
          type: 'conversation_updated',
          conversationId: commandResult.conversationId,
          content: msg.text,
          metadata: {
            channel: 'wechat',
            peerId: msg.fromUserId,
            kind: commandResult.kind,
          },
          timestamp: Date.now(),
        });
      }
      return;
    }

    await this.withWeChatPeerLock(msg.fromUserId, () => this.processWeChatMessage(msg));
  }

  /** 定时任务：在指定会话执行并在微信渠道推送结果（如适用） */
  async executeScheduledTask(
    conversationId: string,
    prompt: string,
    meta: { taskId: string; runId: string; taskName: string; manual?: boolean },
  ): Promise<{ lastError: string; wechatError?: string }> {
    const conv = this.sessionManager.getConversation(conversationId);
    if (!conv) {
      return { lastError: '会话不存在' };
    }

    if (conv.channel === 'wechat' && conv.channelPeerId) {
      return this.withWeChatPeerLock(conv.channelPeerId, () =>
        this.executeScheduledTaskInConversation(conversationId, prompt, meta),
      );
    }

    return this.executeScheduledTaskInConversation(conversationId, prompt, meta);
  }

  private async executeScheduledTaskInConversation(
    conversationId: string,
    prompt: string,
    meta: { taskId: string; runId: string; taskName: string; manual?: boolean },
  ): Promise<{ lastError: string; wechatError?: string }> {
    const conv = this.sessionManager.getConversation(conversationId);
    if (!conv) {
      return { lastError: '会话不存在' };
    }

    const channel = conv.channel === 'wechat' ? 'remote' : 'local';
    const scheduledPrompt = `[定时任务] ${meta.taskName}\n\n${prompt}`;
    const { lastError, reply } = await this.runOrchestratorTurn(
      conversationId,
      scheduledPrompt,
      channel,
      {
        taskId: meta.taskId,
        runId: meta.runId,
        scheduled: true,
        manual: meta.manual ?? false,
      },
    );

    if (conv.channel !== 'wechat' || !conv.channelPeerId) {
      return { lastError };
    }

    const peerId = conv.channelPeerId;
    const contextToken = this.sessionManager.getWeChatContextToken(peerId);
    if (!contextToken) {
      const err =
        '微信会话上下文不可用，请先通过微信向机器人发送一条消息后再执行定时任务';
      return { lastError: lastError || err, wechatError: err };
    }

    const adapter = this.adapters.get('wechat');
    if (!adapter) {
      const err = '微信渠道未连接';
      return { lastError: lastError || err, wechatError: err };
    }

    const header = `【定时·${meta.taskName}】\n\n`;
    const outbound =
      lastError && !reply
        ? `【定时·${meta.taskName}】执行失败：${lastError}`
        : header + reply;

    try {
      for (const chunk of splitWeChatText(outbound)) {
        await adapter.sendMessage(peerId, chunk, contextToken);
      }
      return { lastError };
    } catch (err) {
      const sendErr = err instanceof Error ? err.message : String(err);
      return {
        lastError: lastError || sendErr,
        wechatError: `微信推送失败：${sendErr}`,
      };
    }
  }

  private async runOrchestratorTurn(
    conversationId: string,
    prompt: string,
    channel: 'local' | 'remote',
    extraMeta?: Record<string, unknown>,
  ): Promise<{ lastError: string; reply: string }> {
    let fallbackReply = '';
    let fallbackError = '';
    let canonicalReply = '';
    let lastError = '';

    try {
      for await (const event of this.orchestrator.handleMessage(conversationId, prompt, channel)) {
        this.onEvent?.({
          ...event,
          metadata: { ...event.metadata, ...extraMeta },
        });
        if (event.type === 'text') {
          if (event.metadata?.canonical) {
            canonicalReply = event.content ?? '';
          } else if (event.metadata?.final) {
            fallbackReply = event.content ?? '';
          } else if (event.content) {
            fallbackReply = mergeStreamText(fallbackReply, event.content);
          }
        }
        if (event.type === 'error' && event.content) {
          fallbackError = event.content;
          lastError = event.content;
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      fallbackError = lastError;
    }

    const recent = this.sessionManager.getMessages(conversationId, { limit: 10 }).messages;
    const lastUser = [...recent].reverse().find((m) => m.role === 'user');
    const savedAssistant = [...recent]
      .reverse()
      .find(
        (m) =>
          m.role === 'assistant' &&
          (!lastUser || m.createdAt >= lastUser.createdAt),
      );

    const reply =
      canonicalReply ||
      savedAssistant?.content ||
      fallbackReply ||
      fallbackError ||
      '';

    if (!lastError && fallbackError) {
      lastError = fallbackError;
    }

    this.onEvent?.({
      type: 'conversation_updated',
      conversationId,
      content: reply || lastError || '',
      metadata: { ...extraMeta, channel },
      timestamp: Date.now(),
    });

    return { lastError, reply };
  }

  private async withWeChatPeerLock<T>(
    peerId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.wechatPeerQueues.get(peerId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = prev.then(() => gate);
    this.wechatPeerQueues.set(peerId, next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.wechatPeerQueues.get(peerId) === next) {
        this.wechatPeerQueues.delete(peerId);
      }
    }
  }

  private async processWeChatMessage(msg: WeChatIncomingMessage): Promise<void> {
    const adapter = this.adapters.get('wechat');
    if (!adapter) return;

    await adapter.sendTyping?.(msg.fromUserId, msg.contextToken);
    await adapter.sendMessage(msg.fromUserId, '已收到，正在处理…', msg.contextToken);

    const conv = this.sessionManager.getOrCreateForChannel(
      'wechat',
      msg.fromUserId,
      this.defaultCwd,
      this.orchestrator.getConfig().defaultAgentId,
    );
    this.sessionManager.updateWeChatContext(msg.fromUserId, msg.contextToken);

    const turnId = randomUUID();
    this.onEvent?.({
      type: 'status',
      conversationId: conv.id,
      content: '微信消息处理中…',
      metadata: { kind: 'turn_start', turnId, channel: 'wechat' },
      timestamp: Date.now(),
    });

    let fallbackReply = '';
    let fallbackError = '';
    let canonicalReply = '';

    try {
      for await (const event of this.orchestrator.handleMessage(conv.id, msg.text, 'remote')) {
        this.onEvent?.({
          ...event,
          metadata: { ...event.metadata, turnId, channel: 'wechat' },
        });
        if (event.type === 'text') {
          if (event.metadata?.canonical) {
            canonicalReply = event.content ?? '';
          } else if (event.metadata?.final) {
            fallbackReply = event.content ?? '';
          } else if (event.content) {
            fallbackReply = mergeStreamText(fallbackReply, event.content);
          }
        }
        if (event.type === 'error') {
          fallbackError = event.content ?? fallbackError;
        }
      }
    } catch (err) {
      fallbackError = err instanceof Error ? err.message : String(err);
    }

    const recent = this.sessionManager.getMessages(conv.id, { limit: 10 }).messages;
    const lastUser = [...recent].reverse().find((m) => m.role === 'user');
    const savedAssistant = [...recent]
      .reverse()
      .find(
        (m) =>
          m.role === 'assistant' &&
          (!lastUser || m.createdAt >= lastUser.createdAt),
      );

    const reply =
      canonicalReply ||
      savedAssistant?.content ||
      fallbackReply ||
      fallbackError ||
      '（无文本回复）';
    const chunks = splitWeChatText(reply);

    try {
      for (const chunk of chunks) {
        await adapter.sendMessage(msg.fromUserId, chunk, msg.contextToken);
      }
    } catch (err) {
      const sendErr = err instanceof Error ? err.message : String(err);
      try {
        await adapter.sendMessage(
          msg.fromUserId,
          `回复发送失败：${sendErr.slice(0, 200)}`,
          msg.contextToken,
        );
      } catch {
        // ignore secondary failure
      }
    }

    this.onEvent?.({
      type: 'conversation_updated',
      conversationId: conv.id,
      content: msg.text,
      metadata: { channel: 'wechat', peerId: msg.fromUserId },
      timestamp: Date.now(),
    });
  }

  async handleLocalMessage(
    conversationId: string,
    text: string,
    opts?: { attachments?: SavedImageAttachment[] },
  ): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const event of this.orchestrator.handleMessage(
      conversationId,
      text,
      'local',
      opts,
    )) {
      events.push(event);
      this.onEvent?.(event);
    }
    return events;
  }

  private handleCommand(msg: WeChatIncomingMessage): WeChatCommandResult | null {
    const text = msg.text.trim();
    const peerId = msg.fromUserId;

    if (text === '/new') {
      const conv = this.sessionManager.createConversation({
        title: `微信对话 ${new Date().toLocaleString('zh-CN')}`,
        channel: 'wechat',
        channelPeerId: peerId,
        cwd: this.defaultCwd,
      });
      this.sessionManager.switchConversation('wechat', peerId, conv.id);
      this.orchestrator.resetClaudeSession(conv.id);
      return {
        text: `已创建新对话：${conv.id.slice(0, 8)}`,
        conversationId: conv.id,
        kind: 'wechat_new',
      };
    }

    if (text === '/list') {
      const convs = this.sessionManager.listConversations(10);
      if (convs.length === 0) return { text: '暂无对话' };
      return {
        text: convs
          .map((c) => `${c.id.slice(0, 8)} - ${c.title} (${c.channel})`)
          .join('\n'),
      };
    }

    if (text.startsWith('/switch ')) {
      const idPrefix = text.slice(8).trim();
      const conv = this.sessionManager
        .listConversations(50)
        .find((c) => c.id.startsWith(idPrefix));
      if (!conv) return { text: `未找到对话：${idPrefix}` };
      this.sessionManager.switchConversation('wechat', peerId, conv.id);
      return {
        text: `已切换到：${conv.title} (${conv.id.slice(0, 8)})`,
        conversationId: conv.id,
        kind: 'wechat_switch',
      };
    }

    if (text.startsWith('/agent ')) {
      const agentName = text.slice(7).trim();
      const agent =
        this.agentRegistry.get(agentName) ??
        this.agentRegistry.list().find((a) => a.name.includes(agentName));
      if (!agent) {
        const list = this.agentRegistry.list().map((a) => a.id).join(', ');
        return { text: `未找到 Agent。可用：${list}` };
      }
      const conv = this.sessionManager.getOrCreateForChannel('wechat', peerId, this.defaultCwd);
      this.sessionManager.updateConversation(conv.id, { activeAgentId: agent.id });
      return {
        text: `已切换 Agent：${agent.name} (${agent.id})`,
        conversationId: conv.id,
        kind: 'wechat_agent',
      };
    }

    if (text === '/status') {
      const conv = this.sessionManager.getOrCreateForChannel('wechat', peerId, this.defaultCwd);
      const agent = conv.activeAgentId
        ? this.agentRegistry.get(conv.activeAgentId)
        : undefined;
      const config = this.orchestrator.getConfig();
      return {
        text: [
          `对话：${conv.title} (${conv.id.slice(0, 8)})`,
          `工作区：${conv.cwd || this.defaultCwd || '未设置'}`,
          `Agent：${agent?.name ?? config.defaultAgentId}`,
          `协作模式：${config.mode}`,
        ].join('\n'),
      };
    }

    return null;
  }
}

interface WeChatCommandResult {
  text: string;
  conversationId?: string;
  kind?: 'wechat_new' | 'wechat_switch' | 'wechat_agent';
}
