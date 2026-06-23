import { useCallback, useEffect, useState } from 'react';
import type { AgentConfig, AppSettings, Conversation, OrchestratorConfig, ScheduledTask, StreamEvent, ToolApprovalRequest } from '@weagent/shared';
import { ChatPage } from './pages/ChatPage';
import { refreshThreadFromServer } from './hooks/messageThreadCache';
import { AgentsPage } from './pages/AgentsPage';
import { OrchestratorPage } from './pages/OrchestratorPage';
import { ChannelsPage } from './pages/ChannelsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { TasksPage } from './pages/TasksPage';
import {
  IconAgent,
  IconChannel,
  IconChat,
  IconClock,
  IconFlow,
  IconSettings,
  IconShield,
} from './components/Icons';

type Page = 'chat' | 'agents' | 'orchestrator' | 'tasks' | 'channels' | 'settings' | 'approvals';

const NAV: { id: Page; label: string; Icon: typeof IconChat; section?: string }[] = [
  { id: 'chat', label: '对话', Icon: IconChat, section: '工作区' },
  { id: 'agents', label: 'Agent', Icon: IconAgent },
  { id: 'orchestrator', label: '协作编排', Icon: IconFlow },
  { id: 'tasks', label: '定时任务', Icon: IconClock, section: '自动化' },
  { id: 'channels', label: '渠道', Icon: IconChannel, section: '连接' },
  { id: 'approvals', label: '审批队列', Icon: IconShield },
  { id: 'settings', label: '设置', Icon: IconSettings },
];

const PAGE_META: Record<Page, { title: string; desc?: string }> = {
  chat: { title: '对话' },
  agents: { title: 'Agent 管理', desc: '配置专用 Agent 与工作区、工具权限' },
  orchestrator: { title: '协作编排', desc: 'Router / Pipeline / Parallel 多 Agent 协作' },
  tasks: { title: '定时任务', desc: '按日程自动执行 Claude 任务，如盘前策略、收盘复盘' },
  channels: { title: '渠道', desc: '微信 iLink / ClawBot 远程接入' },
  approvals: { title: '审批队列', desc: '微信远程写操作二次确认（不含本地 Bash）' },
  settings: { title: '设置', desc: 'Claude Code 与工作区配置' },
};

export default function App() {
  const [page, setPage] = useState<Page>('chat');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [orchestratorConfig, setOrchestratorConfig] = useState<OrchestratorConfig | null>(null);
  const [approvals, setApprovals] = useState<ToolApprovalRequest[]>([]);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [claudeStatus, setClaudeStatus] = useState<{ ok: boolean; version?: string; error?: string } | null>(null);
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [streamEventsByConversation, setStreamEventsByConversation] = useState<
    Record<string, StreamEvent[]>
  >({});
  const [focusConversationId, setFocusConversationId] = useState<string | null>(null);

  const appendStreamEvent = useCallback((event: StreamEvent) => {
    setStreamEvents((prev) => [...prev.slice(-100), event]);
    if (!event.conversationId) return;
    setStreamEventsByConversation((prev) => {
      const existing = prev[event.conversationId] ?? [];
      return {
        ...prev,
        [event.conversationId]: [...existing.slice(-200), event],
      };
    });
  }, []);

  const refreshClaudeStatus = useCallback(async () => {
    const claude = await window.weagent.checkClaude();
    setClaudeStatus(claude);
  }, []);

  const refreshLite = useCallback(async () => {
    const [convs, agts, sett, orch, appr, tasks] = await Promise.all([
      window.weagent.listConversations(),
      window.weagent.listAgents(),
      window.weagent.getSettings(),
      window.weagent.getOrchestratorConfig(),
      window.weagent.listApprovals(),
      window.weagent.listScheduledTasks(),
    ]);
    setConversations(convs);
    setAgents(agts);
    setSettings(sett);
    setOrchestratorConfig(orch);
    setApprovals(appr);
    setScheduledTasks(tasks);
  }, []);

  const refreshTasks = useCallback(async () => {
    const tasks = await window.weagent.listScheduledTasks();
    setScheduledTasks(tasks);
  }, []);

  const refresh = useCallback(async () => {
    await refreshLite();
    await refreshClaudeStatus();
  }, [refreshLite, refreshClaudeStatus]);

  const handleDeleteConversation = useCallback(
    async (conversationId: string) => {
      await window.weagent.deleteConversation(conversationId);
      setStreamEventsByConversation((prev) => {
        if (!(conversationId in prev)) return prev;
        const next = { ...prev };
        delete next[conversationId];
        return next;
      });
      setStreamEvents((prev) => prev.filter((e) => e.conversationId !== conversationId));
      await refreshLite();
    },
    [refreshLite],
  );

  useEffect(() => {
    void (async () => {
      await window.weagent.syncClaudeScheduledTasks().catch(() => null);
      await refresh();
    })();

    const unsub = window.weagent.onStreamEvent((event) => {
      appendStreamEvent(event);
      if (event.type === 'done' && event.conversationId) {
        void refreshThreadFromServer(event.conversationId);
      }
      if (event.type === 'approval_required') {
        void window.weagent.listApprovals().then(setApprovals);
      }
      if (event.type === 'conversation_updated') {
        void window.weagent.listConversations().then(setConversations);
        const kind = event.metadata?.kind;
        if (
          (kind === 'wechat_new' || kind === 'wechat_switch') &&
          event.conversationId
        ) {
          setFocusConversationId(event.conversationId);
          setPage('chat');
        }
      }
      if (
        event.metadata?.kind === 'task_completed' ||
        event.metadata?.kind === 'task_failed' ||
        event.metadata?.kind === 'scheduled_task_updated'
      ) {
        void window.weagent.listScheduledTasks().then(setScheduledTasks);
      }
    });
    const unsubTasks = window.weagent.onTasksChanged(() => {
      void window.weagent.listScheduledTasks().then(setScheduledTasks);
    });
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible' && page === 'approvals') {
        void window.weagent.listApprovals().then(setApprovals);
      }
    }, 15000);
    return () => {
      unsub();
      unsubTasks();
      clearInterval(interval);
    };
  }, [refresh, appendStreamEvent, page]);

  useEffect(() => {
    if (page === 'tasks') {
      void refreshTasks();
      void refreshLite();
    }
  }, [page, refreshTasks, refreshLite]);

  let lastSection = '';

  return (
    <div className="app-layout">
      <nav className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">W</div>
          <div className="sidebar-logo-text">
            <span>WeAgent</span>
            <span>Claude Code 控制台</span>
          </div>
        </div>

        {NAV.map((item) => {
          const showSection = item.section && item.section !== lastSection;
          if (item.section) lastSection = item.section;
          return (
            <div key={item.id}>
              {showSection && <div className="nav-section-label">{item.section}</div>}
              <div
                className={`nav-item ${page === item.id ? 'active' : ''}`}
                onClick={() => setPage(item.id)}
              >
                <item.Icon />
                {item.label}
                {item.id === 'approvals' && approvals.length > 0 && (
                  <span className="nav-badge">{approvals.length}</span>
                )}
              </div>
            </div>
          );
        })}

        <div className="sidebar-footer">
          <div className="status-pill">
            <span className={`status-dot ${claudeStatus?.ok ? 'ok' : 'error'}`} />
            <div className="status-pill-text">
              <strong>{claudeStatus?.ok ? 'Claude 已就绪' : 'Claude 未连接'}</strong>
              {claudeStatus?.ok
                ? claudeStatus.version?.slice(0, 24)
                : '请安装并登录 CLI'}
            </div>
          </div>
        </div>
      </nav>

      <main className="main-content">
        {page !== 'chat' && (
          <header className="page-header">
            <h1>{PAGE_META[page].title}</h1>
            {PAGE_META[page].desc && <p>{PAGE_META[page].desc}</p>}
          </header>
        )}
        <div className={`page-body ${page === 'chat' ? 'page-body--chat' : ''}`} style={page !== 'chat' ? { padding: 28 } : undefined}>
          <div className="chat-page-host" hidden={page !== 'chat'}>
            <ChatPage
              visible={page === 'chat'}
              conversations={conversations}
              agents={agents}
              onRefresh={refreshLite}
              onDeleteConversation={handleDeleteConversation}
              streamEvents={streamEvents}
              streamEventsByConversation={streamEventsByConversation}
              focusConversationId={focusConversationId}
              onFocusHandled={() => setFocusConversationId(null)}
            />
          </div>
          {page === 'agents' && (
            <div className="page-content">
              <AgentsPage agents={agents} settings={settings} onRefresh={refreshLite} />
            </div>
          )}
          {page === 'orchestrator' && orchestratorConfig && (
            <div className="page-content">
              <OrchestratorPage
                config={orchestratorConfig}
                agents={agents}
                onSave={async (cfg) => {
                  await window.weagent.setOrcchestratorConfig(cfg);
                  await refreshLite();
                }}
              />
            </div>
          )}
          {page === 'tasks' && (
            <div className="page-content page-content--wide">
              <TasksPage
                tasks={scheduledTasks}
                agents={agents}
                settings={settings}
                conversations={conversations}
                onRefresh={refreshTasks}
                onOpenConversation={(id) => {
                  setFocusConversationId(id);
                  setPage('chat');
                }}
              />
            </div>
          )}
          {page === 'channels' && (
            <div className="page-content page-content--wide">
              <ChannelsPage
                conversations={conversations}
                onRefresh={refreshLite}
                onOpenConversation={(id) => {
                  setFocusConversationId(id);
                  setPage('chat');
                }}
              />
            </div>
          )}
          {page === 'approvals' && (
            <div className="page-content">
              <ApprovalsPage
                approvals={approvals}
                onResolve={async (id, decision) => {
                  await window.weagent.resolveApproval(id, decision);
                  await refreshLite();
                }}
              />
            </div>
          )}
          {page === 'settings' && settings && (
            <div className="page-content">
              <SettingsPage
                settings={settings}
                claudeStatus={claudeStatus}
                onSave={async (patch) => {
                  await window.weagent.updateSettings(patch);
                  await refreshLite();
                  await refreshClaudeStatus();
                }}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
