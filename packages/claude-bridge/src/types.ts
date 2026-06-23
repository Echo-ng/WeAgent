export interface ClaudeBridgeOptions {
  sessionId?: string;
  /** 续接已有 Claude Code 会话（否则用 --session-id 创建） */
  resumeSession?: boolean;
  /** --resume 失败时改用 --session-id 并注入此上下文 */
  fallbackPrompt?: string;
  cwd: string;
  allowedTools?: string[];
  agentId?: string;
  systemPromptAppend?: string;
  model?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  claudePath?: string;
  mcpConfig?: string;
  /** Claude Code CLI 内置 agent，默认 general-purpose，避免误触发 statusline-setup 等 */
  cliAgent?: string;
  /** 精简模式：不加载全局 Skill（默认 false） */
  bareMode?: boolean;
  /** 设置来源，非 bare 时加载 user/project/local 以启用 ~/.claude/skills */
  settingSources?: string;
  /** CLI 权限模式。WeAgent 以 headless --print 调用，须用 bypassPermissions 才能执行 Bash/Write */
  permissionMode?:
    | 'bypassPermissions'
    | 'acceptEdits'
    | 'auto'
    | 'default'
    | 'dontAsk'
    | 'plan';
  /** 本地图片绝对路径，经 stream-json 多模态输入传给 Claude */
  images?: string[];
}

export interface ClaudeSessionHandle {
  sessionId: string;
  options: ClaudeBridgeOptions;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Claude Code 磁盘会话已建立，后续使用 --resume */
  claudeSessionEstablished?: boolean;
}

export interface ToolApprovalRequestPayload {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  channel: 'local' | 'remote';
}

export type ApprovalDecision = 'approve' | 'deny';

export type ToolApprovalHandler = (
  request: ToolApprovalRequestPayload,
) => Promise<ApprovalDecision>;
