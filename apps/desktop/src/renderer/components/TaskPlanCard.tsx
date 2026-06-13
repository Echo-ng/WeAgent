import type { StreamEvent } from '@weagent/shared';

export type TodoPlanStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoPlanItem {
  content: string;
  status: TodoPlanStatus;
}

function normalizeTodoStatus(raw: unknown): TodoPlanStatus {
  const s = String(raw ?? 'pending');
  if (s === 'in_progress' || s === 'completed' || s === 'cancelled') return s;
  return 'pending';
}

export function extractTodoPlan(events: StreamEvent[]): TodoPlanItem[] {
  let latest: TodoPlanItem[] = [];

  for (const e of events) {
    if (!isTodoWriteEvent(e)) continue;
    const input = e.metadata?.toolInput as
      | { todos?: Array<{ content?: string; status?: string }> }
      | undefined;
    if (!Array.isArray(input?.todos) || input.todos.length === 0) continue;

    latest = input.todos
      .filter((t) => t?.content?.trim())
      .map((t) => ({
        content: String(t.content).trim(),
        status: normalizeTodoStatus(t.status),
      }));
  }

  return latest;
}

function isTodoWriteEvent(e: StreamEvent): boolean {
  const name = String(e.metadata?.toolName ?? '').toLowerCase();
  if (name === 'todowrite' || name === 'todo_write') return true;
  const input = e.metadata?.toolInput;
  return Boolean(
    input &&
      typeof input === 'object' &&
      Array.isArray((input as { todos?: unknown }).todos),
  );
}

/** 从本轮流式事件中提取工具/命令失败（如接口限流、Exit code 1） */
export function extractTurnIssues(events: StreamEvent[]): string[] {
  const issues: string[] = [];

  for (const e of events) {
    if (e.type === 'tool_result' && e.metadata?.isError && e.content) {
      const name = String(e.metadata?.toolName ?? '工具');
      const detail = e.content.replace(/^✗\s*/, '').trim().slice(0, 160);
      issues.push(`${name}：${detail}`);
      continue;
    }
    if (e.type === 'error' && e.content && !e.metadata?.sessionNotFound) {
      issues.push(e.content.trim().slice(0, 160));
    }
  }

  return [...new Set(issues)].slice(0, 6);
}

const STATUS_ICON: Record<TodoPlanStatus, string> = {
  pending: '○',
  in_progress: '◉',
  completed: '✓',
  cancelled: '—',
};

interface Props {
  items: TodoPlanItem[];
  issues?: string[];
  compact?: boolean;
}

export function TaskPlanCard({ items, issues = [], compact }: Props) {
  if (items.length === 0) return null;

  const done = items.filter((i) => i.status === 'completed').length;
  const active = items.find((i) => i.status === 'in_progress');
  const hasIssues = issues.length > 0;

  return (
    <div className={`task-plan-card${compact ? ' task-plan-card-compact' : ''}`} role="status">
      <div className="task-plan-header">
        <span className="task-plan-title">任务规划</span>
        <span className="task-plan-progress">
          {done}/{items.length}
        </span>
        {active && (
          <span className="task-plan-active">
            进行中：{active.content.slice(0, 32)}
            {active.content.length > 32 ? '…' : ''}
          </span>
        )}
      </div>
      {hasIssues && (
        <div className="task-plan-issues">
          <p className="task-plan-issues-title">
            部分步骤实际失败，7/7 仅表示 Agent 已勾选计划，不代表数据全部拉取成功
          </p>
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="task-plan-list">
        {items.map((item, i) => (
          <li
            key={`${i}-${item.content.slice(0, 24)}`}
            className={`task-plan-item task-plan-${item.status}`}
          >
            <span className="task-plan-icon" aria-hidden>
              {STATUS_ICON[item.status]}
            </span>
            <span className="task-plan-text">{item.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
