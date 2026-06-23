export type StreamEventType =
  | 'text'
  | 'trace'
  | 'tool_result'
  | 'agent_switch'
  | 'error'
  | 'done'
  | 'approval_required'
  | 'thinking'
  | 'status'
  | 'tip'
  | 'conversation_updated';

export interface StreamEvent {
  type: StreamEventType;
  conversationId: string;
  content?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageContentType = 'text' | 'trace' | 'tool_result' | 'error';

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  contentType: MessageContentType;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface GetMessagesOptions {
  /** 每页条数，默认 30 */
  limit?: number;
  /** 加载此时间戳之前的更早消息 */
  before?: number;
}

export interface GetMessagesResult {
  messages: Message[];
  hasMore: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  channel: 'local' | 'wechat' | 'telegram' | 'feishu';
  channelPeerId?: string;
  activeAgentId?: string;
  cwd: string;
  /** Claude Code 磁盘会话已成功建立，后续可用 --resume */
  claudeSessionReady?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelBinding {
  channel: string;
  peerId: string;
  conversationId: string;
  /** 最近一次微信消息的 context_token，用于定时任务主动推送 */
  lastContextToken?: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  systemPromptAppend?: string;
  cwd: string;
  allowedTools: string[];
  model?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
}

export type OrchestratorMode = 'router' | 'pipeline' | 'parallel';

export interface PipelineStep {
  agentId: string;
  promptTemplate?: string;
}

export interface OrchestratorConfig {
  mode: OrchestratorMode;
  routerAgentId?: string;
  defaultAgentId: string;
  pipeline?: PipelineStep[];
  parallelAgentIds?: string[];
  mergerAgentId?: string;
}

export interface ToolApprovalRequest {
  id: string;
  conversationId: string;
  channel: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

export type ApprovalDecision = 'approve' | 'deny';

export interface WeChatCredentials {
  token: string;
  baseUrl: string;
  botId?: string;
  getUpdatesBuf?: string;
}

export interface WeChatQrCodeResult {
  /** 轮询状态用的二维码 ID */
  qrcode: string;
  /** 二维码图片：base64 或 URL */
  qrcodeImageContent?: string;
  qrcodeImageUrl?: string;
}

export interface WeChatQrPollResult {
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';
  token?: string;
  botId?: string;
}

export interface WeChatIncomingMessage {
  fromUserId: string;
  text: string;
  contextToken: string;
  messageId: string;
  raw?: unknown;
}

export interface AppSettings {
  defaultCwd: string;
  claudePath?: string;
  remoteReadOnly: boolean;
  approvalTimeoutMs: number;
  maxBudgetUsd: number;
  maxTurns: number;
  wechatBaseUrl: string;
  /** 登录后自动开始微信消息监听（主进程持久运行） */
  wechatAutoListen: boolean;
  /** 额外扫描 Claude Code scheduled_tasks.json 的项目根目录 */
  taskSearchDirs?: string[];
  /**
   * Claude CLI 精简模式（--bare）：跳过 hooks、插件同步等，但无法加载 ~/.claude/skills 等全局 Skill。
   * 默认 false，以使用本机已安装的 Skill（如 a-stock-data、飞书 skill）。
   */
  claudeBareMode: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultCwd: '',
  remoteReadOnly: true,
  approvalTimeoutMs: 120_000,
  maxBudgetUsd: 5,
  maxTurns: 50,
  wechatBaseUrl: 'https://ilinkai.weixin.qq.com',
  wechatAutoListen: true,
  claudeBareMode: false,
};

export const REMOTE_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Skill',
  /** a-stock-data 等 skill 需写临时脚本并执行 Python */
  'Bash',
  'Write',
];

export const WRITE_TOOLS = ['Write', 'Edit', 'Bash', 'NotebookEdit'];

/** WeAgent MCP 定时任务工具（Claude Code allowed-tools 需包含） */
export const WEAGENT_MCP_SERVER = 'weagent';

export const WEAGENT_SCHEDULED_TASK_TOOL_NAMES = [
  'scheduled_task_create',
  'scheduled_task_list',
  'scheduled_task_update',
  'scheduled_task_delete',
  'scheduled_task_set_enabled',
  'scheduled_task_run_now',
] as const;

export function weagentMcpToolId(tool: (typeof WEAGENT_SCHEDULED_TASK_TOOL_NAMES)[number]): string {
  return `mcp__${WEAGENT_MCP_SERVER}__${tool}`;
}

export const WEAGENT_MCP_TOOL_IDS = WEAGENT_SCHEDULED_TASK_TOOL_NAMES.map(weagentMcpToolId);

export type ScheduleKind = 'daily' | 'cron' | 'interval';

export type ScheduledTaskRunStatus = 'running' | 'success' | 'error';

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  /** 5 段 cron 表达式，如 `0 9 * * *` */
  cronExpression?: string;
  /** 每日执行时间 HH:MM（本地时区） */
  dailyTime?: string;
  /** 间隔毫秒（scheduleKind=interval） */
  intervalMs?: number;
  prompt: string;
  conversationId?: string;
  agentId?: string;
  cwd?: string;
  /** Claude Code 内置 CronCreate 写入的 native task id */
  claudeNativeId?: string;
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  status: ScheduledTaskRunStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  conversationId?: string;
}

export interface ScheduledTaskInput {
  id?: string;
  name: string;
  enabled?: boolean;
  scheduleKind: ScheduleKind;
  cronExpression?: string;
  dailyTime?: string;
  intervalMs?: number;
  prompt: string;
  conversationId?: string;
  agentId?: string;
  cwd?: string;
  claudeNativeId?: string;
  createdAt?: number;
}

/** 内置任务模板 */
export const TASK_PRESETS: Array<{ id: string; label: string; task: Omit<ScheduledTaskInput, 'id'> }> = [
  {
    id: 'premarket-brief',
    label: '盘前策略（每日 9:00）',
    task: {
      name: '盘前策略',
      enabled: true,
      scheduleKind: 'daily',
      dailyTime: '09:00',
      agentId: 'general',
      prompt: `请使用 a-stock-data 等相关 Skill，收集今日 A 股盘前热点新闻、北向资金、同花顺热点、解禁与行业轮动等数据，整理成一份简洁的盘前策略简报，包含：
1. 大盘环境判断
2. 今日关注板块与题材
3. 风险提示
4. 可跟踪个股（如有）

输出 Markdown 格式，条理清晰，便于快速阅读。`,
    },
  },
  {
    id: 'market-close-review',
    label: '收盘复盘（每日 15:30）',
    task: {
      name: '收盘复盘',
      enabled: false,
      scheduleKind: 'daily',
      dailyTime: '15:30',
      agentId: 'general',
      prompt: `请使用 a-stock-data Skill，汇总今日 A 股市场表现：主要指数涨跌、热点板块、北向/主力资金流向、龙虎榜要点，给出简短收盘复盘与次日关注点。Markdown 格式输出。`,
    },
  },
];
