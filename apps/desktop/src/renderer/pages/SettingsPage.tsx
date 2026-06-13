import { useState } from 'react';
import type { AppSettings } from '@weagent/shared';

interface Props {
  settings: AppSettings;
  claudeStatus: { ok: boolean; version?: string; error?: string } | null;
  onSave: (patch: Partial<AppSettings>) => Promise<void>;
}

export function SettingsPage({ settings, claudeStatus, onSave }: Props) {
  const [local, setLocal] = useState(settings);
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
        <h3 style={{ marginBottom: 16 }}>Claude Code</h3>
        <p style={{ marginBottom: 12 }}>
          状态：
          <span className={`status-badge ${claudeStatus?.ok ? 'ok' : 'error'}`}>
            {claudeStatus?.ok ? claudeStatus.version : claudeStatus?.error ?? '未检测到'}
          </span>
        </p>
        <div className="form-row">
          <label>Claude CLI 路径（可选）</label>
          <input
            value={local.claudePath ?? ''}
            onChange={(e) => setLocal({ ...local, claudePath: e.target.value || undefined })}
            placeholder="默认使用 PATH 中的 claude"
          />
        </div>
        <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            id="claude-bare-mode"
            type="checkbox"
            checked={local.claudeBareMode ?? false}
            onChange={(e) => setLocal({ ...local, claudeBareMode: e.target.checked })}
          />
          <label htmlFor="claude-bare-mode" style={{ marginBottom: 0, cursor: 'pointer' }}>
            精简模式（不加载 ~/.claude/skills 等全局 Skill）
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -4 }}>
          默认关闭，以使用 a-stock-data、飞书 skill 等本机已安装 Skill。开启后启动更快，但无法调用全局 Skill。
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 16 }}>工作区与安全</h3>
        <div className="form-row">
          <label>默认工作区</label>
          <input
            value={local.defaultCwd}
            onChange={(e) => setLocal({ ...local, defaultCwd: e.target.value })}
            placeholder="D:/projects/myapp"
          />
        </div>
        <div className="form-row">
          <label>
            <input
              type="checkbox"
              checked={local.remoteReadOnly}
              onChange={(e) => setLocal({ ...local, remoteReadOnly: e.target.checked })}
              style={{ width: 'auto', marginRight: 8 }}
            />
            微信远程默认只读（Write/Edit/Bash 需审批）
          </label>
        </div>
        <div className="form-row">
          <label>审批超时（毫秒）</label>
          <input
            type="number"
            value={local.approvalTimeoutMs}
            onChange={(e) => setLocal({ ...local, approvalTimeoutMs: Number(e.target.value) })}
          />
        </div>
        <div className="form-row">
          <label>单次预算上限（USD）</label>
          <input
            type="number"
            step="0.1"
            value={local.maxBudgetUsd}
            onChange={(e) => setLocal({ ...local, maxBudgetUsd: Number(e.target.value) })}
          />
        </div>
        <div className="form-row">
          <label>最大轮次</label>
          <input
            type="number"
            value={local.maxTurns}
            onChange={(e) => setLocal({ ...local, maxTurns: Number(e.target.value) })}
          />
        </div>
        <div className="form-row">
          <label>
            <input
              type="checkbox"
              checked={local.wechatAutoListen !== false}
              onChange={(e) => setLocal({ ...local, wechatAutoListen: e.target.checked })}
              style={{ width: 'auto', marginRight: 8 }}
            />
            微信登录后自动开始消息监听（后台常驻）
          </label>
        </div>
        <div className="form-row">
          <label>微信 iLink Base URL</label>
          <input
            value={local.wechatBaseUrl}
            onChange={(e) => setLocal({ ...local, wechatBaseUrl: e.target.value })}
          />
        </div>
        <button onClick={() => void save()} disabled={saving}>
          {saving ? '保存中...' : '保存设置'}
        </button>
      </div>
    </div>
  );
}
