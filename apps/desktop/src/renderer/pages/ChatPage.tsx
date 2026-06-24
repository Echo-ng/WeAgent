import { memo, useEffect, useRef, useState } from 'react';
import type { AgentConfig, Conversation, Message, SavedImageAttachment, StreamEvent } from '@weagent/shared';
import {
  MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_ATTACHMENT_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  mergeStreamText,
  modelSupportsVision,
} from '@weagent/shared';
import { IconPlus, IconSend, IconSpark, IconStop, IconTrash } from '../components/Icons';
import { TracePanel, type TraceEntry } from '../components/TracePanel';
import { TaskPlanCard, extractTodoPlan, extractTurnIssues, type TodoPlanItem } from '../components/TaskPlanCard';
import { MarkdownContent } from '../components/MarkdownContent';
import { CopyTextButton } from '../components/CopyTextButton';
import { ChatImage, ImagePreviewProvider } from '../components/ImageLightbox';
import { CloseButton } from '../components/CloseButton';
import { useMessageThread } from '../hooks/useMessageThread';

interface Props {
  visible?: boolean;
  conversations: Conversation[];
  agents: AgentConfig[];
  onRefresh: () => Promise<void>;
  onDeleteConversation: (conversationId: string) => Promise<void>;
  streamEvents: StreamEvent[];
  streamEventsByConversation: Record<string, StreamEvent[]>;
  focusConversationId?: string | null;
  onFocusHandled?: () => void;
}

const SUGGESTIONS = [
  '帮我分析这个项目的结构',
  '审查最近修改的代码',
  '解释当前工作区的架构',
];

const TRACE_SKIP_TYPES = new Set([
  'text',
  'done',
  'conversation_updated',
  'agent_switch',
]);

const MAX_TRACE_ENTRIES = 120;

function traceDedupKey(e: StreamEvent): string | null {
  if (e.type === 'thinking') return null;
  if (e.type === 'tool_result') {
    return `tool:${e.metadata?.phase}:${e.metadata?.toolUseId ?? ''}:${e.content ?? ''}`;
  }
  if (e.type === 'trace') {
    return `trace:${(e.content ?? '').slice(0, 160)}`;
  }
  return `${e.type}:${e.content ?? ''}`;
}

function formatTurnDividerLabel(event: StreamEvent, turnIndex: number): string {
  const time = new Date(event.timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const channel = event.metadata?.channel === 'wechat' ? '微信' : '本地';
  return `第 ${turnIndex} 轮 · ${channel} · ${time}`;
}

function toTraceEntries(events: StreamEvent[], activeId: string | null): TraceEntry[] {
  const seen = new Set<string>();
  const entries: TraceEntry[] = [];
  let currentTurnId: string | null = null;
  let turnIndex = 0;

  const sorted = [...events]
    .filter((e) => !activeId || e.conversationId === activeId)
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const e of sorted) {
    const turnId = typeof e.metadata?.turnId === 'string' ? e.metadata.turnId : null;
    const isTurnStart = e.metadata?.kind === 'turn_start';
    const turnChanged = turnId != null && turnId !== currentTurnId;

    if (isTurnStart || turnChanged) {
      if (turnId) currentTurnId = turnId;
      turnIndex += 1;
      entries.push({
        id: `turn-${turnId ?? turnIndex}-${e.timestamp}`,
        type: 'turn_divider',
        kind: 'turn_divider',
        content: formatTurnDividerLabel(e, turnIndex),
        timestamp: e.timestamp,
      });
    }

    if (isTurnStart) continue;

    if (e.type === 'text' && (e.metadata?.final || e.metadata?.canonical) && e.content?.trim()) {
      const replyKey = `reply:${(e.content ?? '').slice(0, 120)}`;
      if (seen.has(replyKey)) continue;
      seen.add(replyKey);
      const preview =
        e.content.length > 240 ? `${e.content.slice(0, 240)}…` : e.content;
      entries.push({
        id: `${e.timestamp}-reply-${entries.length}`,
        type: 'trace',
        kind: 'entry',
        content: `【回复】${preview}`,
        timestamp: e.timestamp,
      });
      continue;
    }

    if (TRACE_SKIP_TYPES.has(e.type)) continue;
    if (e.type === 'trace' && !e.content?.trim()) continue;

    const phase = typeof e.metadata?.phase === 'string' ? e.metadata.phase : undefined;
    const dedupKey = traceDedupKey(e);
    if (dedupKey) {
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
    }

    entries.push({
      id: `${e.timestamp}-${e.type}-${entries.length}`,
      type: e.type,
      kind: 'entry',
      content: e.content ?? '',
      timestamp: e.timestamp,
      phase,
    });
  }

  return entries.slice(-MAX_TRACE_ENTRIES);
}

type ActivityPhase =
  | 'starting'
  | 'thinking'
  | 'tool'
  | 'approval'
  | 'writing'
  | 'error'
  | 'done';

interface TurnDisplay {
  phase: ActivityPhase;
  status: string;
  text: string;
  error: string;
  tips: string[];
  tools: Array<{ name: string; summary: string; pending?: boolean; toolUseId?: string }>;
  thinkingPreview: string;
  done: boolean;
}

const STATUS_ZH: Record<string, string> = {
  'Germinating...': '正在启动 Claude…',
  'Thinking...': '思考中…',
};

function localizeStatus(status: string): string {
  return STATUS_ZH[status] ?? status;
}

function phaseLabel(phase: ActivityPhase): string {
  switch (phase) {
    case 'starting':
      return '正在连接';
    case 'thinking':
      return '思考中';
    case 'tool':
      return '调用工具';
    case 'approval':
      return '等待审批';
    case 'writing':
      return '生成回复';
    case 'error':
      return '出错了';
    case 'done':
      return '完成';
  }
}

/** 仅从本轮发送之后的事件里解析 turnId，避免误用上一轮 */
function extractTurnIdSince(events: StreamEvent[], sendStartedAt: number): string | null {
  const since = sendStartedAt - 300;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.timestamp < since) break;
    if (e.metadata?.kind === 'turn_start' && typeof e.metadata.turnId === 'string') {
      return e.metadata.turnId;
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.timestamp < since) break;
    const id = e.metadata?.turnId;
    if (typeof id === 'string') return id;
  }
  return null;
}

function collectTurnEvents(
  streamEvents: StreamEvent[],
  streamEventsByConversation: Record<string, StreamEvent[]>,
  activeId: string,
  sending: boolean,
  currentTurnId: string | null,
  sendStartedAt: number,
): StreamEvent[] {
  if (!sending || !activeId || sendStartedAt <= 0) return [];

  const since = sendStartedAt - 300;
  const perConv = streamEventsByConversation[activeId];
  const forConv = (
    perConv ??
    streamEvents.filter((e) => e.conversationId === activeId)
  ).filter((e) => e.timestamp >= since);

  const turnId = currentTurnId ?? extractTurnIdSince(forConv, sendStartedAt);

  if (turnId) {
    return forConv.filter((e) => e.metadata?.turnId === turnId);
  }

  return forConv;
}

export function ChatPage({
  visible = true,
  conversations,
  agents,
  onRefresh,
  onDeleteConversation,
  streamEvents,
  streamEventsByConversation,
  focusConversationId,
  onFocusHandled,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] = useState<'all' | 'local' | 'wechat'>('all');
  const {
    messages,
    hasMore,
    loading: loadingHistory,
    loadingMore,
    loadThread,
    loadOlder,
    replaceThread,
    invalidate,
    clear,
    setMessages,
  } = useMessageThread();
  const [input, setInput] = useState('');
  const [sendingConvIds, setSendingConvIds] = useState<Set<string>>(() => new Set());
  const [stoppingConvIds, setStoppingConvIds] = useState<Set<string>>(() => new Set());
  const [turnIdsByConv, setTurnIdsByConv] = useState<Record<string, string>>({});
  const [elapsedSec, setElapsedSec] = useState(0);
  const [liveTrace, setLiveTrace] = useState<TraceEntry[]>([]);
  const [initializing, setInitializing] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<SavedImageAttachment[]>([]);
  const [attachError, setAttachError] = useState('');
  const sendingConvIdsRef = useRef(new Set<string>());
  const stoppingConvIdsRef = useRef(new Set<string>());
  const sendStartedAtByConvRef = useRef(new Map<string, number>());
  const seenExternalTurnStartsRef = useRef(new Set<string>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollModeRef = useRef<ScrollBehavior>('instant');
  const wasVisibleRef = useRef(visible);

  const syncSendingConvIds = () => setSendingConvIds(new Set(sendingConvIdsRef.current));
  const syncStoppingConvIds = () => setStoppingConvIds(new Set(stoppingConvIdsRef.current));

  const focusInput = () => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const markConvSending = (convId: string, startedAt = Date.now()) => {
    sendingConvIdsRef.current.add(convId);
    sendStartedAtByConvRef.current.set(convId, startedAt);
    setTurnIdsByConv((prev) => {
      if (!(convId in prev)) return prev;
      const next = { ...prev };
      delete next[convId];
      return next;
    });
    syncSendingConvIds();
  };

  const markConvIdle = (convId: string) => {
    sendingConvIdsRef.current.delete(convId);
    sendStartedAtByConvRef.current.delete(convId);
    stoppingConvIdsRef.current.delete(convId);
    setTurnIdsByConv((prev) => {
      if (!(convId in prev)) return prev;
      const next = { ...prev };
      delete next[convId];
      return next;
    });
    syncSendingConvIds();
    syncStoppingConvIds();
  };

  const activeConv = conversations.find((c) => c.id === activeId);
  const activeAgent =
    agents.find((a) => a.id === activeConv?.activeAgentId) ??
    agents.find((a) => a.id === 'general') ??
    agents[0];
  const visionSupported = modelSupportsVision(activeAgent?.model);

  const filteredConversations = conversations.filter((c) => {
    if (channelFilter === 'all') return true;
    if (channelFilter === 'wechat') return c.channel === 'wechat';
    return c.channel === 'local';
  });

  useEffect(() => {
    if (!focusConversationId) return;
    const conv = conversations.find((c) => c.id === focusConversationId);
    if (conv?.channel === 'wechat') {
      setChannelFilter('wechat');
    }
    setActiveId(focusConversationId);
    onFocusHandled?.();
  }, [focusConversationId, conversations, onFocusHandled]);

  useEffect(() => {
    if (filteredConversations.length === 0) {
      const activeInAll = Boolean(activeId && conversations.some((c) => c.id === activeId));
      if (activeInAll) {
        setChannelFilter('all');
        return;
      }
      if (activeId) {
        setActiveId(null);
        clear();
      }
      return;
    }
    if (!activeId || !filteredConversations.some((c) => c.id === activeId)) {
      const activeInAll = Boolean(activeId && conversations.some((c) => c.id === activeId));
      if (activeInAll) {
        setChannelFilter('all');
        return;
      }
      setActiveId(filteredConversations[0].id);
    }
  }, [filteredConversations, activeId, clear, conversations]);

  useEffect(() => {
    if (!activeId) return;
    scrollModeRef.current = 'instant';
    void loadThread(activeId);
  }, [activeId, loadThread]);

  useEffect(() => {
    const becameVisible = visible && !wasVisibleRef.current;
    if (becameVisible && activeId) {
      void loadThread(activeId, { force: true });
      focusInput();
    } else if (visible && activeId) {
      focusInput();
    }
    wasVisibleRef.current = visible;
  }, [visible, activeId, loadThread]);

  useEffect(() => {
    if (!activeId) return;
    const shouldRefresh = (e: StreamEvent) =>
      e.conversationId === activeId &&
      (e.type === 'conversation_updated' ||
        e.type === 'done' ||
        e.metadata?.kind === 'task_completed' ||
        e.metadata?.kind === 'task_failed');

    for (let i = streamEvents.length - 1; i >= 0; i--) {
      if (shouldRefresh(streamEvents[i])) {
        invalidate(activeId);
        void loadThread(activeId, { force: true });
        break;
      }
    }
  }, [streamEvents, activeId, invalidate, loadThread]);

  const isActiveConvSending = Boolean(activeId && sendingConvIds.has(activeId));
  const isActiveConvStopping = Boolean(activeId && stoppingConvIds.has(activeId));

  useEffect(() => {
    for (let i = streamEvents.length - 1; i >= 0; i--) {
      const e = streamEvents[i];
      if (!e.conversationId) continue;
      if (sendingConvIdsRef.current.has(e.conversationId)) continue;
      if (e.metadata?.kind === 'task_started') {
        const key = String(e.metadata.runId ?? `${e.conversationId}:${e.timestamp}`);
        if (seenExternalTurnStartsRef.current.has(key)) continue;
        seenExternalTurnStartsRef.current.add(key);
        markConvSending(e.conversationId, e.timestamp);
      }
    }
  }, [streamEvents]);

  useEffect(() => {
    if (!isActiveConvSending || !activeId) {
      setElapsedSec(0);
      return;
    }
    const startedAt = sendStartedAtByConvRef.current.get(activeId) ?? Date.now();
    const tick = () => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [isActiveConvSending, activeId]);

  useEffect(() => {
    if (!activeId || !sendingConvIds.has(activeId)) return;
    const startedAt = sendStartedAtByConvRef.current.get(activeId);
    if (!startedAt) return;
    const since = startedAt - 300;
    for (let i = streamEvents.length - 1; i >= 0; i--) {
      const e = streamEvents[i];
      if (e.conversationId !== activeId || e.timestamp < since) continue;
      if (e.metadata?.kind === 'turn_start' && typeof e.metadata.turnId === 'string') {
        setTurnIdsByConv((prev) =>
          prev[activeId] === e.metadata!.turnId
            ? prev
            : { ...prev, [activeId]: e.metadata!.turnId as string },
        );
        break;
      }
    }
  }, [streamEvents, activeId, sendingConvIds]);

  useEffect(() => {
    for (const convId of [...sendingConvIdsRef.current]) {
      const startedAt = sendStartedAtByConvRef.current.get(convId) ?? 0;
      const perConv = streamEventsByConversation[convId];
      const events =
        perConv ??
        streamEvents.filter((e) => e.conversationId === convId);
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        // 只检测本轮（发送时间之后）的事件，避免命中上一轮遗留的 done/cancelled
        if (e.timestamp < startedAt - 300) break;
        if (
          e.type === 'done' ||
          e.metadata?.cancelled ||
          e.metadata?.kind === 'task_completed' ||
          e.metadata?.kind === 'task_failed'
        ) {
          markConvIdle(convId);
          if (activeId === convId) focusInput();
          break;
        }
      }
    }
  }, [streamEvents, streamEventsByConversation, activeId, sendingConvIds]);

  useEffect(() => {
    const convEvents = activeId ? streamEventsByConversation[activeId] ?? [] : [];
    const traceEvents = convEvents.length > 0 ? convEvents : streamEvents;
    setLiveTrace(toTraceEntries(traceEvents, activeId));
  }, [streamEvents, streamEventsByConversation, activeId]);

  const activeTurnId = activeId ? turnIdsByConv[activeId] ?? null : null;
  const activeSendStartedAt =
    activeId && isActiveConvSending
      ? sendStartedAtByConvRef.current.get(activeId) ?? 0
      : 0;

  const turnEvents = collectTurnEvents(
    streamEvents,
    streamEventsByConversation,
    activeId ?? '',
    isActiveConvSending,
    activeTurnId,
    activeSendStartedAt,
  );

  const liveTurn = deriveTurnDisplay(turnEvents);

  const todoPlan = isActiveConvSending ? extractTodoPlan(turnEvents) : [];
  const turnIssues = isActiveConvSending ? extractTurnIssues(turnEvents) : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: scrollModeRef.current });
    scrollModeRef.current = 'smooth';
  }, [messages, isActiveConvSending, activeTurnId, streamEvents.length, todoPlan.length, activeId, streamEventsByConversation]);

  const adjustTextareaHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '24px';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };

  const ensureConversation = async (): Promise<string | null> => {
    if (activeId) return activeId;
    setInitializing(true);
    try {
      const conv = await window.weagent.createConversation(formatTitle());
      await onRefresh();
      setActiveId(conv.id);
      return conv.id;
    } finally {
      setInitializing(false);
    }
  };

  const createConv = async () => {
    const conv = await window.weagent.createConversation(formatTitle());
    await onRefresh();
    setActiveId(conv.id);
    setTimeout(focusInput, 50);
  };

  const deleteConv = async (id: string, title: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!window.confirm(`确定删除对话「${title}」？\n\n消息记录将被永久删除，此操作不可恢复。`)) {
      return;
    }
    await onDeleteConversation(id);
    invalidate(id);
    if (activeId === id) {
      clear();
      setActiveId(null);
      setLiveTrace([]);
      markConvIdle(id);
    }
  };

  const addImageFiles = async (files: FileList | File[]) => {
    setAttachError('');
    const list = Array.from(files);
    if (list.length === 0) return;

    const convId = await ensureConversation();
    if (!convId) return;

    const remaining = MAX_IMAGE_ATTACHMENTS_PER_MESSAGE - pendingAttachments.length;
    if (remaining <= 0) {
      setAttachError(`最多上传 ${MAX_IMAGE_ATTACHMENTS_PER_MESSAGE} 张图片`);
      return;
    }

    const toAdd = list.slice(0, remaining);
    const saved: SavedImageAttachment[] = [];

    try {
      for (const file of toAdd) {
        if (!SUPPORTED_IMAGE_MIME_TYPES.includes(file.type as (typeof SUPPORTED_IMAGE_MIME_TYPES)[number])) {
          throw new Error(`不支持的格式：${file.name}`);
        }
        if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
          throw new Error(`${file.name} 超过 4MB 限制`);
        }
        const base64 = await fileToBase64(file);
        const attachment = await window.weagent.saveImageAttachment(convId, {
          fileName: file.name,
          mimeType: file.type,
          base64,
        });
        saved.push(attachment);
      }
      setPendingAttachments((prev) => [...prev, ...saved]);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    }
  };

  const removePendingAttachment = (id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const stopSending = async () => {
    const convId = activeId;
    if (!convId || !sendingConvIds.has(convId) || stoppingConvIds.has(convId)) return;
    stoppingConvIdsRef.current.add(convId);
    syncStoppingConvIds();
    try {
      await window.weagent.cancelConversation(convId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          conversationId: convId,
          role: 'assistant',
          content: `停止失败：${message}`,
          contentType: 'error',
          createdAt: Date.now(),
        },
      ]);
    } finally {
      stoppingConvIdsRef.current.delete(convId);
      syncStoppingConvIds();
    }
  };

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    const attachments = [...pendingAttachments];
    const convId = await ensureConversation();
    if (!convId) return;
    if ((!text && attachments.length === 0) || sendingConvIds.has(convId)) return;

    markConvSending(convId);
    scrollModeRef.current = 'smooth';
    if (!textOverride) {
      setInput('');
      setPendingAttachments([]);
      if (textareaRef.current) textareaRef.current.style.height = '24px';
    }

    const displayContent =
      text || (attachments.length > 0 ? `[${attachments.length} 张图片]` : '');

    setMessages((prev) => [
      ...prev,
      {
        id: `temp-${Date.now()}`,
        conversationId: convId,
        role: 'user',
        content: displayContent,
        contentType: 'text',
        metadata: attachments.length
          ? {
              attachments: attachments.map((a) => ({
                kind: 'image',
                fileName: a.fileName,
                path: a.path,
                mimeType: a.mimeType,
                previewDataUrl: a.previewDataUrl,
              })),
            }
          : undefined,
        createdAt: Date.now(),
      },
    ]);

    try {
      const result = await window.weagent.sendMessage(convId, text, {
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      replaceThread(convId, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          conversationId: convId,
          role: 'assistant',
          content: `发送失败：${message}`,
          contentType: 'error',
          createdAt: Date.now(),
        },
      ]);
    } finally {
      markConvIdle(convId);
      focusInput();
    }
  };

  const hasMessages = messages.length > 0;

  return (
    <ImagePreviewProvider>
    <div className="chat-layout">
      <div className="conv-list">
        <div className="conv-list-header">
          <button onClick={() => void createConv()}>
            <IconPlus style={{ width: 14, height: 14 }} />
            新建对话
          </button>
        </div>
        <div className="conv-filter-tabs">
          {(['all', 'local', 'wechat'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={`conv-filter-tab${channelFilter === key ? ' active' : ''}`}
              onClick={() => setChannelFilter(key)}
            >
              {key === 'all' ? '全部' : key === 'local' ? '本地' : '微信'}
            </button>
          ))}
        </div>
        <div className="conv-list-scroll">
          {filteredConversations.map((c) => (
            <div
              key={c.id}
              className={`conv-item ${activeId === c.id ? 'active' : ''}`}
              onClick={() => setActiveId(c.id)}
            >
              <div className="conv-item-row">
                <div className="conv-item-title">{c.title}</div>
                <button
                  type="button"
                  className="conv-item-delete icon-btn ghost"
                  title="删除对话"
                  aria-label="删除对话"
                  onClick={(e) => void deleteConv(c.id, c.title, e)}
                >
                  <IconTrash />
                </button>
              </div>
              <div className="conv-item-meta">
                <span className={`conv-channel-tag ${c.channel}`}>{c.channel}</span>
                {c.id.slice(0, 8)}
              </div>
            </div>
          ))}
          {filteredConversations.length === 0 && (
            <div className="empty-state" style={{ padding: '32px 16px' }}>
              暂无对话记录
            </div>
          )}
        </div>
      </div>

      <div className="chat-area">
        {activeConv && (
          <>
            <div className="chat-header">
              <div>
                <div className="chat-header-title">{activeConv.title}</div>
                <div className="chat-header-sub">
                  {activeConv.cwd || '未设置工作区'} · {activeConv.activeAgentId ?? 'default'}
                </div>
              </div>
              <button
                type="button"
                className="secondary icon-btn"
                title="删除对话"
                aria-label="删除对话"
                onClick={() => void deleteConv(activeConv.id, activeConv.title)}
              >
                <IconTrash />
              </button>
            </div>
            {isActiveConvSending && (
              <div className="chat-activity-bar" role="status" aria-live="polite">
                <span className="activity-pulse" aria-hidden />
                <span className="chat-activity-label">
                  AI 正在{phaseLabel(liveTurn.phase)}…
                </span>
                <TypingDots />
                <span className="chat-activity-elapsed">{elapsedSec}s</span>
              </div>
            )}
          </>
        )}

        <div className="messages terminal-scroll">
          {!hasMessages && !isActiveConvSending && (
            <div className="welcome-screen">
              <div className="welcome-icon-wrap">
                <IconSpark />
              </div>
              <h2>与 Claude Code 对话</h2>
              <p>
                连接本地 Claude Code，支持微信远程操控、多 Agent 协作。
                直接在下方输入，或在设置中配置工作区。
              </p>
              <div className="welcome-chips">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="welcome-chip"
                    onClick={() => void send(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="terminal-transcript">
            {loadingHistory && messages.length === 0 && (
              <div className="history-loading">加载对话中…</div>
            )}

            {hasMore && messages.length > 0 && (
              <button
                type="button"
                className="load-more-btn"
                disabled={loadingMore}
                onClick={() => activeId && void loadOlder(activeId)}
              >
                {loadingMore ? '加载中…' : '加载更早消息'}
              </button>
            )}

            {messages.map((m) => (
              <TerminalMessage key={m.id} message={m} />
            ))}

            {isActiveConvSending && (
              <LiveTurnBlock
                turn={liveTurn}
                elapsedSec={elapsedSec}
                todoPlan={todoPlan}
                turnIssues={turnIssues}
              />
            )}
          </div>

          <div ref={messagesEndRef} />
        </div>

        <div className="chat-input-area terminal-input-area">
          {pendingAttachments.length > 0 && (
            <div className="chat-attachments-preview">
              {pendingAttachments.map((att) => (
                <div key={att.id} className="chat-attachment-chip">
                  {att.previewDataUrl && (
                    <ChatImage
                      src={att.previewDataUrl}
                      alt={att.fileName}
                      className="chat-attachment-thumb"
                      filePath={att.path}
                    />
                  )}
                  <span className="chat-attachment-name">{att.fileName}</span>
                  <CloseButton
                    size="sm"
                    variant="ghost"
                    className="chat-attachment-remove"
                    onClick={() => removePendingAttachment(att.id)}
                    aria-label="移除图片"
                  />
                </div>
              ))}
            </div>
          )}
          {attachError && <div className="chat-attach-error">{attachError}</div>}
          {pendingAttachments.length > 0 && !visionSupported && (
            <div className="chat-attach-warn">
              当前模型{activeAgent?.model ? `（${activeAgent.model}）` : ''} 可能无法识图，
              Claude Code 或显示 [Unsupported Image]。
            </div>
          )}
          <div
            className="terminal-input-row"
            onMouseDown={(e) => {
              const target = e.target as HTMLElement;
              if (target.closest('button') || target.tagName === 'TEXTAREA') return;
              e.preventDefault();
              focusInput();
            }}
          >
            <span className="term-prompt">&gt;</span>
            <textarea
              ref={textareaRef}
              className="terminal-input"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                adjustTextareaHeight();
              }}
              placeholder=""
              onPaste={(e) => {
                const items = e.clipboardData?.items;
                if (!items) return;
                const imageFiles: File[] = [];
                for (const item of items) {
                  if (item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) imageFiles.push(file);
                  }
                }
                if (imageFiles.length > 0) {
                  e.preventDefault();
                  void addImageFiles(imageFiles);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={initializing}
              readOnly={isActiveConvSending}
              rows={1}
            />
            <button
              className={`send-btn icon-btn terminal-send${isActiveConvSending ? ' is-stop' : ''}`}
              onClick={() => void (isActiveConvSending ? stopSending() : send())}
              disabled={
                isActiveConvSending
                  ? isActiveConvStopping || initializing
                  : (!input.trim() && pendingAttachments.length === 0) || initializing
              }
              title={isActiveConvSending ? '停止生成' : '发送'}
            >
              {isActiveConvSending ? <IconStop /> : <IconSend />}
            </button>
          </div>
          <div className={`chat-input-hint${isActiveConvSending ? ' is-busy' : ''}`}>
            {isActiveConvSending ? (
              <>
                <span className="activity-pulse activity-pulse-sm" aria-hidden />
                {isActiveConvStopping ? '正在停止…' : `正在等待回复 · 已用时 ${elapsedSec}s`}
                {!isActiveConvStopping && ' · 点击右侧按钮停止'}
                {liveTurn.phase === 'approval' &&
                  activeConv?.channel === 'wechat' &&
                  ' · 敏感工具操作可在「审批队列」处理'}
              </>
            ) : (
              'Enter 发送 · Shift+Enter 换行 · 可粘贴图片（PNG/JPG/WebP，单张 ≤4MB）'
            )}
          </div>
        </div>
      </div>

      <TracePanel entries={liveTrace} />
    </div>
    </ImagePreviewProvider>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('读取图片失败'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function messageAttachments(message: Message): Array<{
  previewDataUrl?: string;
  fileName?: string;
  path?: string;
}> {
  const raw = message.metadata?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a === 'object' && (a as { kind?: string }).kind === 'image')
    .map((a) => {
      const att = a as { previewDataUrl?: string; fileName?: string; path?: string };
      return {
        previewDataUrl: att.previewDataUrl,
        fileName: att.fileName,
        path: att.path,
      };
    });
}

function messageCopyText(message: Message): string {
  const attachments = messageAttachments(message);
  const parts: string[] = [];
  if (message.content?.trim()) parts.push(message.content.trim());
  if (attachments.length > 0) {
    const names = attachments.map((a) => a.fileName ?? '图片').join('、');
    parts.push(`[${attachments.length} 张图片：${names}]`);
  }
  return parts.join('\n\n');
}

function ChatTurnActions({
  copyText,
  align = 'start',
}: {
  copyText: string;
  align?: 'start' | 'end';
}) {
  return (
    <div className={`chat-turn-actions chat-turn-actions-${align}`}>
      <CopyTextButton text={copyText} />
    </div>
  );
}

const TerminalMessage = memo(function TerminalMessage({ message }: { message: Message }) {
  const copyText = messageCopyText(message);

  if (message.role === 'user') {
    const attachments = messageAttachments(message);
    return (
      <div className="chat-turn chat-turn-user">
        <div className="chat-turn-avatar chat-turn-avatar-user" aria-hidden>
          我
        </div>
        <div className="chat-turn-content">
          <span className="chat-turn-label">你</span>
          <div className="chat-turn-bubble chat-turn-bubble-user">
            {attachments.length > 0 && (
              <div className="term-user-images">
                {attachments.map((att, i) => (
                  <ChatImage
                    key={`${message.id}-img-${i}`}
                    src={att.previewDataUrl}
                    alt={att.fileName ?? '图片'}
                    className="term-user-image"
                    filePath={att.path}
                  />
                ))}
              </div>
            )}
            {message.content && <div className="chat-turn-user-text">{message.content}</div>}
          </div>
          <ChatTurnActions copyText={copyText} align="end" />
        </div>
      </div>
    );
  }

  if (message.contentType === 'error') {
    return (
      <div className="chat-turn chat-turn-assistant">
        <div className="chat-turn-avatar chat-turn-avatar-assistant" aria-hidden>
          <IconSpark width={14} height={14} />
        </div>
        <div className="chat-turn-content">
          <span className="chat-turn-label">Claude Code</span>
          <div className="chat-turn-bubble chat-turn-bubble-assistant chat-turn-bubble-error">
            {message.content}
          </div>
          <ChatTurnActions copyText={message.content} />
        </div>
      </div>
    );
  }

  return (
    <div className="chat-turn chat-turn-assistant">
      <div className="chat-turn-avatar chat-turn-avatar-assistant" aria-hidden>
        <IconSpark width={14} height={14} />
      </div>
      <div className="chat-turn-content">
        <span className="chat-turn-label">Claude Code</span>
        <div className="chat-turn-bubble chat-turn-bubble-assistant">
          <MarkdownContent content={message.content} className="term-assistant-md chat-turn-md" />
        </div>
        <ChatTurnActions copyText={message.content} />
      </div>
    </div>
  );
});

function TypingDots() {
  return (
    <span className="typing-dots" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

function LiveTurnBlock({
  turn,
  elapsedSec,
  todoPlan = [],
  turnIssues = [],
}: {
  turn: TurnDisplay;
  elapsedSec: number;
  todoPlan?: TodoPlanItem[];
  turnIssues?: string[];
}) {
  const streaming = turn.text && !turn.done && !turn.error;
  const showIdle = !turn.text && !turn.error && !turn.done;

  return (
    <div className="chat-turn chat-turn-assistant chat-turn-live" role="status" aria-live="polite">
      <div className="chat-turn-avatar chat-turn-avatar-assistant" aria-hidden>
        <IconSpark width={14} height={14} />
      </div>
      <div className="chat-turn-content">
        <span className="chat-turn-label">Claude Code</span>
        <div className="chat-turn-bubble chat-turn-bubble-assistant chat-turn-bubble-live">
          <div className="activity-header">
            <span className="activity-pulse" aria-hidden />
            <span className={`activity-phase activity-phase-${turn.phase}`}>
              {phaseLabel(turn.phase)}
            </span>
            {!turn.done && !turn.error && <TypingDots />}
            <span className="activity-elapsed">{elapsedSec}s</span>
          </div>

          {todoPlan.length > 0 && (
            <TaskPlanCard items={todoPlan} issues={turnIssues} compact />
          )}

          {showIdle && (
            <div className="activity-status-line">{turn.status}</div>
          )}

          {turn.thinkingPreview && !turn.text && (
            <div className="activity-thinking">{turn.thinkingPreview}…</div>
          )}

          {turn.tools.map((tool, i) => (
            <div
              key={`${tool.name}-${i}`}
              className={`term-line term-tool${tool.pending ? ' term-tool-pending' : ''}`}
            >
              <span className="term-tool-name">{tool.name}</span>
              {tool.summary && <span className="term-tool-summary">{tool.summary}</span>}
              {tool.pending && <span className="term-tool-badge">审批中</span>}
            </div>
          ))}

          {turn.tips.map((tip, i) => (
            <div key={i} className="term-line term-tip">
              └ {tip}
            </div>
          ))}

          {turn.text && (
            <MarkdownContent
              content={turn.text}
              className={`term-assistant-md chat-turn-md term-live-md${streaming ? ' is-streaming' : ''}`}
            />
          )}

          {turn.error && (
            <div className="term-line term-error activity-error">
              <span className="activity-error-icon" aria-hidden>✕</span>
              {turn.error}
            </div>
          )}
        </div>
        {turn.text && <ChatTurnActions copyText={turn.text} />}
      </div>
    </div>
  );
}

function deriveTurnDisplay(events: StreamEvent[]): TurnDisplay {
  let status = localizeStatus('Germinating...');
  let streamText = '';
  let finalText = '';
  let error = '';
  let done = false;
  let thinkingPreview = '';
  let hadThinking = false;
  let lastPhase: ActivityPhase = 'starting';
  const tips: string[] = [];
  const tools: Array<{ name: string; summary: string; pending?: boolean; toolUseId?: string }> = [];
  const pendingApprovals = new Set<string>();

  for (const e of events) {
    if (e.metadata?.kind === 'turn_start') continue;

    switch (e.type) {
      case 'status':
        if (e.content) status = localizeStatus(e.content);
        lastPhase = 'starting';
        break;
      case 'thinking':
        hadThinking = true;
        status = localizeStatus('Thinking...');
        if (e.content) {
          thinkingPreview =
            e.content.length > 160 ? e.content.slice(-160) : e.content;
        }
        lastPhase = 'thinking';
        break;
      case 'text':
        if (e.content) {
          streamText = mergeStreamText(streamText, e.content);
          if (e.metadata?.final) {
            finalText = streamText;
          }
        }
        lastPhase = 'writing';
        break;
      case 'error':
        error = e.content ?? '未知错误';
        lastPhase = 'error';
        break;
      case 'tip':
        if (e.content) tips.push(e.content);
        break;
      case 'tool_result': {
        const toolUseId = String(e.metadata?.toolUseId ?? '');
        const phase = e.metadata?.phase === 'call' ? 'call' : 'result';
        if (phase === 'call') {
          const existing = toolUseId
            ? tools.find((t) => t.toolUseId === toolUseId)
            : undefined;
          if (!existing) {
            tools.push({
              name: String(e.metadata?.toolName ?? 'tool'),
              summary: summarizeToolEvent(e),
              toolUseId: toolUseId || undefined,
            });
          }
          status = `正在调用 ${e.metadata?.toolName ?? '工具'}…`;
          lastPhase = 'tool';
        } else {
          // 工具已执行完成：清除审批等待，并把对应卡片从「审批中」更新为结果
          if (toolUseId) pendingApprovals.delete(toolUseId);
          const target = toolUseId
            ? tools.find((t) => t.toolUseId === toolUseId)
            : undefined;
          if (target) {
            target.pending = false;
            if (e.content) target.summary = e.content;
          }
          lastPhase = 'tool';
        }
        break;
      }
      case 'approval_required': {
        const toolUseId = String(e.metadata?.toolUseId ?? '');
        if (toolUseId) pendingApprovals.add(toolUseId);
        const existing = toolUseId
          ? tools.find((t) => t.toolUseId === toolUseId)
          : undefined;
        if (!existing) {
          tools.push({
            name: String(e.metadata?.toolName ?? 'tool'),
            summary: summarizeToolEvent(e),
            pending: true,
            toolUseId: toolUseId || undefined,
          });
        }
        status = `等待审批：${e.metadata?.toolName ?? '工具'}`;
        lastPhase = 'approval';
        break;
      }
      case 'trace': {
        const toolName = e.metadata?.toolName;
        if (e.metadata?.phase === 'call' && toolName) {
          tools.push({
            name: String(toolName),
            summary: e.content?.slice(0, 120) ?? '',
          });
          status = `正在调用 ${toolName}…`;
          lastPhase = 'tool';
        }
        break;
      }
      case 'done':
        done = true;
        lastPhase = 'done';
        break;
      default:
        break;
    }
  }

  let phase: ActivityPhase = lastPhase;
  if (error) phase = 'error';
  else if (done) phase = 'done';
  else if (pendingApprovals.size > 0) phase = 'approval';
  else if (finalText || streamText) phase = 'writing';
  else if (tools.length > 0) phase = 'tool';
  else if (hadThinking) phase = 'thinking';

  if (phase === 'writing' && !streamText && !finalText) {
    status = '正在生成回复…';
  }

  return {
    phase,
    status,
    text: finalText || streamText,
    error,
    tips,
    tools,
    thinkingPreview,
    done,
  };
}

function summarizeToolEvent(event: StreamEvent): string {
  if (event.type === 'approval_required') return '等待审批…';
  return event.content ?? '';
}

function formatTitle(): string {
  return `对话 ${new Date().toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}
