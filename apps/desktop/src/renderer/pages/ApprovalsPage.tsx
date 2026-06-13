import type { ToolApprovalRequest } from '@weagent/shared';

interface Props {
  approvals: ToolApprovalRequest[];
  onResolve: (requestId: string, decision: 'approve' | 'deny') => Promise<void>;
}

export function ApprovalsPage({ approvals, onResolve }: Props) {
  if (approvals.length === 0) {
    return (
      <div className="empty-state">
        <p>暂无待审批的工具请求</p>
        <p style={{ fontSize: 13, marginTop: 8 }}>
          微信远程触发的 Write/Edit/Bash 操作会出现在这里
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      {approvals.map((req) => (
        <div key={req.id} className="approval-item">
          <div>
            <div style={{ fontWeight: 600 }}>{req.toolName}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              对话: {req.conversationId.slice(0, 8)} | 渠道: {req.channel}
            </div>
            <pre style={{ fontSize: 11, marginTop: 4, color: 'var(--text-muted)' }}>
              {JSON.stringify(req.toolInput, null, 2).slice(0, 200)}
            </pre>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => void onResolve(req.id, 'approve')}>批准</button>
            <button className="danger" onClick={() => void onResolve(req.id, 'deny')}>
              拒绝
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
