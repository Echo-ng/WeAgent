import { useState } from 'react';
import type { AgentConfig, OrchestratorConfig } from '@weagent/shared';

interface Props {
  config: OrchestratorConfig;
  agents: AgentConfig[];
  onSave: (config: OrchestratorConfig) => Promise<void>;
}

export function OrchestratorPage({ config, agents, onSave }: Props) {
  const [local, setLocal] = useState<OrchestratorConfig>(config);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(local);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="card">
        <h3 style={{ marginBottom: 16 }}>协作模式</h3>
        <div className="form-row">
          <label>模式</label>
          <select
            value={local.mode}
            onChange={(e) =>
              setLocal({ ...local, mode: e.target.value as OrchestratorConfig['mode'] })
            }
          >
            <option value="router">Router - 意图路由</option>
            <option value="pipeline">Pipeline - 顺序流水线</option>
            <option value="parallel">Parallel - 并行汇总</option>
          </select>
        </div>
        <div className="form-row">
          <label>默认 Agent</label>
          <select
            value={local.defaultAgentId}
            onChange={(e) => setLocal({ ...local, defaultAgentId: e.target.value })}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        {local.mode === 'pipeline' && (
          <div className="form-row">
            <label>Pipeline 步骤（Agent ID，逗号分隔）</label>
            <input
              value={(local.pipeline ?? []).map((s) => s.agentId).join(', ')}
              onChange={(e) =>
                setLocal({
                  ...local,
                  pipeline: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .map((agentId) => ({ agentId })),
                })
              }
              placeholder="code-dev, code-reviewer, general"
            />
          </div>
        )}

        {local.mode === 'parallel' && (
          <>
            <div className="form-row">
              <label>并行 Agent（逗号分隔）</label>
              <input
                value={(local.parallelAgentIds ?? []).join(', ')}
                onChange={(e) =>
                  setLocal({
                    ...local,
                    parallelAgentIds: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                  })
                }
              />
            </div>
            <div className="form-row">
              <label>汇总 Agent</label>
              <select
                value={local.mergerAgentId ?? local.defaultAgentId}
                onChange={(e) => setLocal({ ...local, mergerAgentId: e.target.value })}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        <button onClick={() => void save()} disabled={saving}>
          {saving ? '保存中...' : '保存配置'}
        </button>
      </div>

      <div className="card">
        <h3>模式说明</h3>
        <ul style={{ paddingLeft: 20, color: 'var(--text-muted)', lineHeight: 1.8 }}>
          <li><strong>Router</strong>：根据关键词自动选择 Agent（审查/开发/通用）</li>
          <li><strong>Pipeline</strong>：按顺序串联多个 Agent，上一步输出作为下一步输入</li>
          <li><strong>Parallel</strong>：多个 Agent 并行处理同一任务，汇总 Agent 合并结果</li>
        </ul>
      </div>
    </div>
  );
}
