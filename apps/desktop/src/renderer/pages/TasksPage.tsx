import { useCallback, useEffect, useState } from 'react';
import type { AgentConfig, AppSettings, Conversation, ScheduledTask, ScheduledTaskInput, ScheduledTaskRun } from '@weagent/shared';
import {
  TASK_PRESETS,
  formatScheduleLabel,
  formatTaskRunTime,
  scheduleKindLabel,
} from '@weagent/shared';

interface Props {
  tasks: ScheduledTask[];
  agents: AgentConfig[];
  settings: AppSettings | null;
  conversations: Conversation[];
  onRefresh: () => Promise<void>;
  onOpenConversation?: (conversationId: string) => void;
}

function conversationLabel(conv: Conversation): string {
  const channel = conv.channel === 'wechat' ? '微信' : '本地';
  return `${conv.title}（${channel}）`;
}

function formatSyncBanner(result: { imported: number; updated: number; removed: number; files: string[] }): string {
  const parts: string[] = [];
  if (result.imported > 0) parts.push(`新导入 ${result.imported} 个`);
  if (result.updated > 0) parts.push(`更新 ${result.updated} 个`);
  if (result.removed > 0) parts.push(`Claude 已删除 ${result.removed} 个（WeAgent 已同步删除）`);
  if (result.files.length > 0) {
    parts.push(`扫描 ${result.files.length} 个 Claude 任务文件`);
  } else {
    parts.push('未找到 .claude/scheduled_tasks.json（请确认 defaultCwd 或 Claude 使用了 durable 定时任务）');
  }
  return parts.join(' · ');
}

const EMPTY_FORM: ScheduledTaskInput = {
  name: '',
  enabled: true,
  scheduleKind: 'daily',
  dailyTime: '09:00',
  prompt: '',
  agentId: 'general',
};

function statusLabel(status: ScheduledTaskRun['status']): string {
  switch (status) {
    case 'running':
      return '执行中';
    case 'success':
      return '成功';
    case 'error':
      return '失败';
  }
}

export function TasksPage({ tasks, agents, settings, conversations, onRefresh, onOpenConversation }: Props) {
  const [editing, setEditing] = useState<ScheduledTaskInput | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncBanner, setSyncBanner] = useState('');

  const selected = tasks.find((t) => t.id === selectedId) ?? null;

  const syncAndRefresh = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const result = await window.weagent.syncClaudeScheduledTasks();
      setSyncBanner(formatSyncBanner(result));
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [onRefresh]);

  useEffect(() => {
    void syncAndRefresh();
  }, [syncAndRefresh]);

  useEffect(() => {
    if (tasks.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !tasks.some((t) => t.id === selectedId)) {
      setSelectedId(tasks[0].id);
    }
  }, [tasks, selectedId]);

  const loadRuns = useCallback(async (taskId: string) => {
    const list = await window.weagent.listScheduledTaskRuns(taskId, 15);
    setRuns(list);
  }, []);

  useEffect(() => {
    if (selectedId) {
      void loadRuns(selectedId);
    } else {
      setRuns([]);
    }
  }, [selectedId, tasks, loadRuns]);

  useEffect(() => {
    if (runs.some((r) => r.status === 'running')) {
      const timer = window.setInterval(() => {
        if (selectedId) void loadRuns(selectedId);
      }, 4000);
      return () => window.clearInterval(timer);
    }
  }, [runs, selectedId, loadRuns]);

  useEffect(() => {
    let cancelled = false;
    const refreshRunningTasks = async () => {
      const ids = new Set<string>();
      for (const task of tasks) {
        const latest = await window.weagent.listScheduledTaskRuns(task.id, 1);
        if (latest[0]?.status === 'running') ids.add(task.id);
      }
      if (!cancelled) setRunningTaskIds(ids);
    };
    void refreshRunningTasks();
    const timer = window.setInterval(refreshRunningTasks, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tasks, runningId]);

  const openNew = () => {
    setError('');
    setEditing({
      ...EMPTY_FORM,
      cwd: settings?.defaultCwd ?? '',
      conversationId: conversations[0]?.id,
    });
  };

  const openEdit = (task: ScheduledTask) => {
    setError('');
    setEditing({
      id: task.id,
      name: task.name,
      enabled: task.enabled,
      scheduleKind: task.scheduleKind,
      cronExpression: task.cronExpression,
      dailyTime: task.dailyTime ?? '09:00',
      intervalMs: task.intervalMs ?? 3_600_000,
      prompt: task.prompt,
      conversationId: task.conversationId,
      agentId: task.agentId ?? 'general',
      cwd: task.cwd ?? settings?.defaultCwd ?? '',
    });
  };

  const applyPreset = (presetId: string) => {
    const preset = TASK_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setError('');
    setEditing({
      ...preset.task,
      cwd: settings?.defaultCwd ?? '',
    });
  };

  const save = async () => {
    if (!editing) return;
    setError('');
    try {
      const saved = await window.weagent.saveScheduledTask(editing);
      setEditing(null);
      setSelectedId(saved.id);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('确定删除此定时任务？')) return;
    await window.weagent.deleteScheduledTask(id);
    if (selectedId === id) setSelectedId(null);
    await onRefresh();
  };

  const toggleEnabled = async (task: ScheduledTask) => {
    await window.weagent.setScheduledTaskEnabled(task.id, !task.enabled);
    await onRefresh();
  };

  const isTaskRunning = (taskId: string) =>
    runningId === taskId || runningTaskIds.has(taskId);

  const runNow = async (task: ScheduledTask) => {
    if (isTaskRunning(task.id)) return;
    setRunningId(task.id);
    setError('');
    try {
      const run = await window.weagent.runScheduledTaskNow(task.id);
      if (run?.status === 'running') {
        setError(`「${task.name}」已在执行中，请稍候查看执行记录`);
      }
      await onRefresh();
      if (selectedId === task.id) {
        await loadRuns(task.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningId(null);
    }
  };

  if (editing) {
    return (
      <div className="card task-editor">
        <h3 style={{ marginBottom: 16 }}>{editing.id ? '编辑定时任务' : '新建定时任务'}</h3>

        <div className="task-preset-row">
          <span className="task-preset-label">快速模板：</span>
          {TASK_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="secondary"
              onClick={() => applyPreset(preset.id)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="form-row">
          <label>任务名称</label>
          <input
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            placeholder="例如：盘前策略"
          />
        </div>

        <div className="form-row">
          <label>调度方式</label>
          <select
            value={editing.scheduleKind}
            onChange={(e) =>
              setEditing({
                ...editing,
                scheduleKind: e.target.value as ScheduledTaskInput['scheduleKind'],
              })
            }
          >
            <option value="daily">每日定时</option>
            <option value="cron">Cron 表达式</option>
            <option value="interval">固定间隔</option>
          </select>
        </div>

        {editing.scheduleKind === 'daily' && (
          <div className="form-row">
            <label>执行时间（本地时区）</label>
            <input
              type="time"
              value={editing.dailyTime ?? '09:00'}
              onChange={(e) => setEditing({ ...editing, dailyTime: e.target.value })}
            />
          </div>
        )}

        {editing.scheduleKind === 'cron' && (
          <div className="form-row">
            <label>Cron 表达式</label>
            <input
              value={editing.cronExpression ?? '0 9 * * *'}
              onChange={(e) => setEditing({ ...editing, cronExpression: e.target.value })}
              placeholder="0 9 * * *（每天 9:00）"
            />
            <p className="form-hint">5 段格式：分 时 日 月 周。例：工作日 9 点 → `0 9 * * 1-5`</p>
          </div>
        )}

        {editing.scheduleKind === 'interval' && (
          <div className="form-row">
            <label>间隔（分钟）</label>
            <input
              type="number"
              min={1}
              value={Math.round((editing.intervalMs ?? 3_600_000) / 60_000)}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  intervalMs: Math.max(1, Number(e.target.value)) * 60_000,
                })
              }
            />
          </div>
        )}

        <div className="form-row">
          <label>绑定会话</label>
          <select
            value={editing.conversationId ?? ''}
            onChange={(e) =>
              setEditing({
                ...editing,
                conversationId: e.target.value || undefined,
              })
            }
          >
            <option value="">执行时使用最新会话</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {conversationLabel(c)}
              </option>
            ))}
          </select>
          <p className="form-hint">
            任务在绑定会话的上下文中执行。若会话已删除，将自动回退到最新会话；微信任务会推送到该用户当前激活的微信对话。
          </p>
        </div>

        <div className="form-row">
          <label>Agent</label>
          <select
            value={editing.agentId ?? 'general'}
            onChange={(e) => setEditing({ ...editing, agentId: e.target.value })}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
          </select>
        </div>

        <div className="form-row">
          <label>工作区（可选）</label>
          <input
            value={editing.cwd ?? ''}
            onChange={(e) => setEditing({ ...editing, cwd: e.target.value })}
            placeholder={settings?.defaultCwd || '留空则使用默认工作区'}
          />
        </div>

        <div className="form-row">
          <label>执行指令（Prompt）</label>
          <textarea
            rows={8}
            value={editing.prompt}
            onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
            placeholder="描述 Claude 需要完成的任务，例如收集盘前数据并生成策略…"
          />
        </div>

        <div className="form-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id="task-enabled"
            type="checkbox"
            checked={editing.enabled ?? true}
            onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
          />
          <label htmlFor="task-enabled" style={{ margin: 0 }}>
            保存后立即启用
          </label>
        </div>

        {error && <p className="form-error">{error}</p>}

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={() => void save()}>保存</button>
          <button className="secondary" onClick={() => setEditing(null)}>
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="tasks-layout">
      <div className="tasks-toolbar">
        <div className="tasks-toolbar-row">
          <button onClick={openNew}>+ 新建定时任务</button>
          <button
            type="button"
            className="secondary"
            disabled={refreshing}
            onClick={() => void syncAndRefresh()}
          >
            {refreshing ? '同步中…' : '刷新 / 同步 Claude 任务'}
          </button>
        </div>
        <p className="tasks-toolbar-hint">
          与 Claude Code 同步的是写入 <code>.claude/scheduled_tasks.json</code> 的 durable 定时任务（创建时需明确要求「持久化/每天重复」）。
          请在「设置」中配置工作区 defaultCwd 为 Claude 项目根目录；WeAgent 也会扫描各会话 cwd。
          本页保存的 Cron/每日任务会回写该文件，并由 WeAgent 统一调度。
        </p>
        {syncBanner && !loading && (
          <p className="tasks-sync-banner">{syncBanner}</p>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>

      {loading ? (
        <div className="tasks-loading card">
          <span className="activity-pulse activity-pulse-sm" aria-hidden />
          正在加载定时任务…
        </div>
      ) : (
      <div className="tasks-grid">
        <div className="tasks-list card">
          {tasks.length === 0 ? (
            <div className="empty-state tasks-empty">
              <p>暂无定时任务</p>
              <p className="form-hint">
                点击「新建」、使用模板，或在对话中让 Claude 创建（CronCreate / scheduled_task_create）。
              </p>
            </div>
          ) : (
            tasks.map((task) => (
              <div
                key={task.id}
                className={`task-item${selectedId === task.id ? ' active' : ''}`}
                onClick={() => setSelectedId(task.id)}
              >
                <div className="task-item-head">
                  <div className="task-item-title">{task.name}</div>
                  <label className="task-toggle" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={task.enabled}
                      disabled={Boolean(task.claudeNativeId)}
                      title={task.claudeNativeId ? 'Claude 同步任务请在 Claude Code 中启停后同步' : undefined}
                      onChange={() => void toggleEnabled(task)}
                    />
                    <span>{task.enabled ? '已启用' : '已暂停'}</span>
                  </label>
                </div>
                <div className="task-item-meta">
                  {formatScheduleLabel(task)} · {scheduleKindLabel(task.scheduleKind)}
                  {task.claudeNativeId && (
                    <span className="task-source-tag"> · Claude 同步</span>
                  )}
                </div>
                <div className="task-item-meta">
                  下次：{formatTaskRunTime(task.nextRunAt)} · 上次：{formatTaskRunTime(task.lastRunAt)}
                </div>
                <div className="task-item-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="secondary"
                    disabled={isTaskRunning(task.id)}
                    onClick={() => void runNow(task)}
                  >
                    {isTaskRunning(task.id) ? '执行中…' : '立即运行'}
                  </button>
                  <button
                    className="secondary"
                    disabled={Boolean(task.claudeNativeId)}
                    title={task.claudeNativeId ? 'Claude 同步任务请在 Claude Code 中编辑后同步' : undefined}
                    onClick={() => openEdit(task)}
                  >
                    编辑
                  </button>
                  <button
                    className="danger"
                    disabled={Boolean(task.claudeNativeId)}
                    title={task.claudeNativeId ? 'Claude 同步任务请在 Claude Code 中删除后同步' : undefined}
                    onClick={() => void remove(task.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="task-detail card">
          {selected ? (
            <>
              <h3>{selected.name}</h3>
              <dl className="task-detail-dl">
                <dt>调度</dt>
                <dd>{formatScheduleLabel(selected)}</dd>
                <dt>Agent</dt>
                <dd>{selected.agentId ?? 'default'}</dd>
                <dt>绑定会话</dt>
                <dd>
                  {selected.conversationId ? (
                    conversations.find((c) => c.id === selected.conversationId) ? (
                      conversationLabel(
                        conversations.find((c) => c.id === selected.conversationId)!,
                      )
                    ) : (
                      `已删除（${selected.conversationId.slice(0, 8)}…，执行时将使用最新会话）`
                    )
                  ) : (
                    '最新会话（执行时自动选择）'
                  )}
                </dd>
                <dt>下次执行</dt>
                <dd>{formatTaskRunTime(selected.nextRunAt)}</dd>
                <dt>上次执行</dt>
                <dd>{formatTaskRunTime(selected.lastRunAt)}</dd>
              </dl>
              <div className="task-prompt-preview">
                <div className="task-prompt-label">Prompt</div>
                <pre>{selected.prompt}</pre>
              </div>
              {selected.conversationId && onOpenConversation && (
                <button
                  className="secondary"
                  style={{ marginTop: 12 }}
                  onClick={() => onOpenConversation(selected.conversationId!)}
                >
                  查看对话记录
                </button>
              )}

              <h4 style={{ marginTop: 24, marginBottom: 12 }}>执行历史</h4>
              {runs.length === 0 ? (
                <p className="form-hint">尚无执行记录</p>
              ) : (
                <ul className="task-run-list">
                  {runs.map((run) => (
                    <li key={run.id} className={`task-run-item task-run-${run.status}`}>
                      <span>{formatTaskRunTime(run.startedAt)}</span>
                      <span>{statusLabel(run.status)}</span>
                      {run.error && <span className="task-run-error">{run.error.slice(0, 80)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="empty-state" style={{ padding: '48px 16px' }}>
              选择左侧任务查看详情与执行历史
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
