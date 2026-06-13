import type { Conversation, ScheduledTask } from '@weagent/shared';
import type { SessionManager } from './session-manager.js';

export interface ResolveTaskConversationResult {
  conversationId: string;
  channel: 'local' | 'remote';
  wechatPeerId?: string;
  /** 绑定的会话不存在，已回退到最新会话 */
  usedFallback: boolean;
  /** 是否应把新的 conversationId 写回任务 */
  shouldRebind: boolean;
}

function resolveActiveWechatConversation(
  sessionManager: SessionManager,
  conv: Conversation,
): { conversationId: string; wechatPeerId?: string } {
  if (conv.channel !== 'wechat' || !conv.channelPeerId) {
    return { conversationId: conv.id };
  }

  const peerId = conv.channelPeerId;
  const binding = sessionManager.getBinding('wechat', peerId);
  if (binding) {
    const active = sessionManager.getConversation(binding.conversationId);
    if (active) {
      return { conversationId: active.id, wechatPeerId: peerId };
    }
  }

  return { conversationId: conv.id, wechatPeerId: peerId };
}

/** 解析定时任务应在哪个会话中执行 */
export function resolveTaskConversation(
  task: ScheduledTask,
  sessionManager: SessionManager,
  getDefaultCwd: () => string,
): ResolveTaskConversationResult {
  let usedFallback = false;
  let targetId: string | undefined;
  let wechatPeerId: string | undefined;

  if (task.conversationId) {
    const bound = sessionManager.getConversation(task.conversationId);
    if (bound) {
      const resolved = resolveActiveWechatConversation(sessionManager, bound);
      targetId = resolved.conversationId;
      wechatPeerId = resolved.wechatPeerId;
    }
  }

  if (!targetId) {
    usedFallback = true;
    const latest = sessionManager.listConversations(1)[0];
    if (latest) {
      const resolved = resolveActiveWechatConversation(sessionManager, latest);
      targetId = resolved.conversationId;
      wechatPeerId = resolved.wechatPeerId;
    }
  }

  if (!targetId) {
    usedFallback = true;
    const conv = sessionManager.createConversation({
      title: `[定时] ${task.name}`,
      channel: 'local',
      cwd: task.cwd || getDefaultCwd(),
      activeAgentId: task.agentId,
    });
    targetId = conv.id;
  }

  const conv = sessionManager.getConversation(targetId)!;
  const active = resolveActiveWechatConversation(sessionManager, conv);
  targetId = active.conversationId;
  wechatPeerId = active.wechatPeerId ?? wechatPeerId;

  const channel = conv.channel === 'wechat' ? 'remote' : 'local';
  const shouldRebind =
    usedFallback && (!task.conversationId || task.conversationId !== targetId);

  return {
    conversationId: targetId,
    channel,
    wechatPeerId,
    usedFallback,
    shouldRebind,
  };
}
