import { useState } from 'react';
import type { AgentConfig, AppSettings } from '@weagent/shared';
import { normalizeToolIds } from '@weagent/shared';
import { ToolBadges, ToolPicker } from '../components/ToolPicker';

interface Props {
  agents: AgentConfig[];
  settings: AppSettings | null;
  onRefresh: () => Promise<void>;
}

export function AgentsPage({ agents, settings, onRefresh }: Props) {
  const [editing, setEditing] = useState<AgentConfig | null>(null);

  const newAgent = () => {
    setEditing({
      id: `agent-${Date.now()}`,
      name: '新 Agent',
      description: '',
      cwd: settings?.defaultCwd ?? '',
      allowedTools: ['Read', 'Grep', 'Glob'],
    });
  };

  const save = async () => {
    if (!editing) return;
    await window.weagent.saveAgent({
      ...editing,
      allowedTools: normalizeToolIds(editing.allowedTools),
    });
    setEditing(null);
    await onRefresh();
  };

  const remove = async (id: string) => {
    await window.weagent.deleteAgent(id);
    await onRefresh();
  };

  if (editing) {
    return (
      <div className="card agent-editor">
        <h3 style={{ marginBottom: 16 }}>编辑 Agent</h3>
        <div className="form-row">
          <label>ID</label>
          <input value={editing.id} onChange={(e) => setEditing({ ...editing, id: e.target.value })} />
        </div>
        <div className="form-row">
          <label>名称</label>
          <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
        </div>
        <div className="form-row">
          <label>描述</label>
          <input
            value={editing.description}
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label>工作区</label>
          <input value={editing.cwd} onChange={(e) => setEditing({ ...editing, cwd: e.target.value })} />
        </div>
        <div className="form-row">
          <label>System Prompt 追加</label>
          <textarea
            value={editing.systemPromptAppend ?? ''}
            onChange={(e) => setEditing({ ...editing, systemPromptAppend: e.target.value })}
            rows={3}
          />
        </div>
        <div className="form-row">
          <label>允许工具</label>
          <ToolPicker
            value={editing.allowedTools}
            onChange={(allowedTools) => setEditing({ ...editing, allowedTools })}
          />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => void save()}>保存</button>
          <button className="secondary" onClick={() => setEditing(null)}>
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <button onClick={newAgent}>+ 新建 Agent</button>
      </div>
      <div className="agent-grid">
        {agents.map((agent) => (
          <div key={agent.id} className="card agent-card">
            <h3>{agent.name}</h3>
            <p>{agent.description || '无描述'}</p>
            <p className="agent-card-meta">ID: {agent.id}</p>
            <ToolBadges tools={agent.allowedTools} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                className="secondary"
                onClick={() =>
                  setEditing({
                    ...agent,
                    allowedTools: normalizeToolIds(agent.allowedTools),
                  })
                }
              >
                编辑
              </button>
              <button className="danger" onClick={() => void remove(agent.id)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
