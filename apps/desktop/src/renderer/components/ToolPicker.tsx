import { useMemo, useState } from 'react';
import { CloseButton } from './CloseButton';
import {
  CLAUDE_TOOL_CATALOG,
  TOOL_CATEGORY_LABELS,
  TOOL_PRESETS,
  TOOL_RISK_LABELS,
  normalizeToolIds,
  splitKnownAndCustomTools,
  toggleToolSelection,
  toolsByCategory,
  type ToolCategory,
} from '@weagent/shared';

interface Props {
  value: string[];
  onChange: (tools: string[]) => void;
}

export function ToolPicker({ value, onChange }: Props) {
  const [customInput, setCustomInput] = useState('');
  const normalized = useMemo(() => normalizeToolIds(value), [value]);
  const { known, custom } = useMemo(() => splitKnownAndCustomTools(normalized), [normalized]);
  const grouped = useMemo(() => toolsByCategory(), []);
  const categories = Object.keys(grouped) as ToolCategory[];

  const toggle = (toolId: string) => {
    onChange(toggleToolSelection(normalized, toolId));
  };

  const applyPreset = (tools: readonly string[]) => {
    onChange(normalizeToolIds([...tools]));
  };

  const addCustom = () => {
    const trimmed = customInput.trim();
    if (!trimmed) return;
    onChange(normalizeToolIds([...normalized, trimmed]));
    setCustomInput('');
  };

  const removeCustom = (toolId: string) => {
    onChange(normalized.filter((t) => t !== toolId));
  };

  return (
    <div className="tool-picker">
      <div className="tool-picker-toolbar">
        <span className="tool-picker-count">已选 {normalized.length} 项</span>
        <div className="tool-picker-presets">
          {Object.values(TOOL_PRESETS).map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="tool-preset-btn"
              onClick={() => applyPreset(preset.tools)}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            className="tool-preset-btn"
            onClick={() => onChange([])}
          >
            清空
          </button>
        </div>
      </div>

      <div className="tool-picker-grid">
        {categories.map((category) => (
          <div key={category} className="tool-picker-group">
            <div className="tool-picker-group-title">{TOOL_CATEGORY_LABELS[category]}</div>
            <div className="tool-picker-options">
              {grouped[category].map((tool) => {
                const checked = known.includes(tool.id);
                return (
                  <label
                    key={tool.id}
                    className={`tool-option${checked ? ' checked' : ''} risk-${tool.risk}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(tool.id)}
                    />
                    <span className="tool-option-body">
                      <span className="tool-option-head">
                        <span className="tool-option-label">{tool.label}</span>
                        <span className={`tool-risk-badge risk-${tool.risk}`}>
                          {TOOL_RISK_LABELS[tool.risk]}
                        </span>
                      </span>
                      <span className="tool-option-desc">{tool.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {custom.length > 0 && (
        <div className="tool-custom-list">
          <div className="tool-picker-group-title">自定义</div>
          <div className="tool-custom-chips">
            {custom.map((toolId) => (
              <span key={toolId} className="tool-custom-chip">
                {toolId}
                <CloseButton
                  size="sm"
                  variant="ghost"
                  onClick={() => removeCustom(toolId)}
                  aria-label="移除"
                />
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="tool-custom-add">
        <input
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          placeholder="自定义工具名，如 Bash(docker:*)"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCustom();
            }
          }}
        />
        <button type="button" className="secondary" onClick={addCustom} disabled={!customInput.trim()}>
          添加
        </button>
      </div>

      <p className="tool-picker-hint">
        Bash 全权限与 Bash(git:*) 等受限模式互斥；远程渠道仍受只读策略约束。
      </p>
    </div>
  );
}

export function ToolBadges({ tools }: { tools: string[] }) {
  const normalized = normalizeToolIds(tools);
  if (normalized.length === 0) {
    return <span className="tool-badges-empty">未配置工具</span>;
  }

  const meta = new Map(CLAUDE_TOOL_CATALOG.map((t) => [t.id, t]));

  return (
    <div className="tool-badges">
      {normalized.map((id) => {
        const tool = meta.get(id);
        const risk = tool?.risk ?? 'execute';
        return (
          <span key={id} className={`tool-badge risk-${risk}`} title={tool?.description ?? id}>
            {tool?.label ?? id}
          </span>
        );
      })}
    </div>
  );
}
