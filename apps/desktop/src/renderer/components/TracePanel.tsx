import { useEffect, useState } from 'react';
import { CloseButton } from './CloseButton';

export interface TraceEntry {
  id: string;
  type: string;
  content: string;
  timestamp: number;
  phase?: string;
  kind?: 'entry' | 'turn_divider';
}

interface Props {
  entries: TraceEntry[];
}

const TYPE_LABEL: Record<string, string> = {
  text: '文本',
  trace: '日志',
  tool_result: '工具',
  error: '错误',
  agent_switch: 'Agent',
  thinking: '思考',
  status: '状态',
  tip: '提示',
  approval_required: '审批',
  done: '完成',
  conversation_updated: '更新',
};

function entryLabel(entry: TraceEntry): string {
  if (entry.kind === 'turn_divider') return '轮次';
  if (entry.type === 'tool_result') {
    if (entry.phase === 'call') return '调用';
    if (entry.phase === 'result') return '结果';
  }
  return TYPE_LABEL[entry.type] ?? entry.type;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function previewText(content: string, max = 72): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}

export function TracePanel({ entries }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const expandedEntry = entries.find((e) => e.id === expandedId) ?? null;

  useEffect(() => {
    if (!expandedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpandedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expandedId]);

  return (
    <>
      <aside className={`trace-panel${collapsed ? ' collapsed' : ''}`}>
        <button
          type="button"
          className="trace-panel-header"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? '展开 Agent Trace' : '折叠 Agent Trace'}
        >
          <span className="trace-panel-chevron">{collapsed ? '◀' : '▶'}</span>
          {!collapsed && <span className="trace-panel-title">Agent Trace</span>}
          {entries.filter((e) => e.kind !== 'turn_divider').length > 0 && (
            <span className="trace-panel-count">
              {entries.filter((e) => e.kind !== 'turn_divider').length}
            </span>
          )}
          {collapsed && <span className="trace-panel-vertical">Trace</span>}
        </button>

        {!collapsed && (
          <div className="trace-panel-body">
            {entries.length === 0 && (
              <div className="trace-empty">工具调用与执行日志</div>
            )}
            {entries.map((entry) =>
              entry.kind === 'turn_divider' ? (
                <div key={entry.id} className="trace-turn-divider" title={entry.content}>
                  <span className="trace-turn-divider-line" />
                  <span className="trace-turn-divider-label">{entry.content}</span>
                  <span className="trace-turn-divider-line" />
                </div>
              ) : (
                <button
                  key={entry.id}
                  type="button"
                  className={`trace-row type-${entry.type}`}
                  onClick={() => setExpandedId(entry.id)}
                  title="点击查看完整内容"
                >
                  <div className="trace-row-head">
                    <span className="trace-row-type">{entryLabel(entry)}</span>
                    <span className="trace-row-time">{formatTime(entry.timestamp)}</span>
                  </div>
                  <div className="trace-row-preview">{previewText(entry.content)}</div>
                </button>
              ),
            )}
          </div>
        )}
      </aside>

      {expandedEntry && (
        <div
          className="trace-modal-backdrop"
          onClick={() => setExpandedId(null)}
          role="presentation"
        >
          <div
            className="trace-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trace-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="trace-modal-header">
              <div>
                <div id="trace-modal-title" className="trace-modal-type">
                  {entryLabel(expandedEntry)}
                </div>
                <div className="trace-modal-time">
                  {formatTime(expandedEntry.timestamp)}
                </div>
              </div>
              <CloseButton
                size="md"
                variant="bordered"
                onClick={() => setExpandedId(null)}
                aria-label="关闭"
              />
            </div>
            <pre className="trace-modal-body">{expandedEntry.content || '（空）'}</pre>
          </div>
        </div>
      )}
    </>
  );
}
