import { v4 as uuidv4 } from 'uuid';
import type {
  AgentConfig,
  ApprovalDecision,
  OrchestratorConfig,
  StreamEvent,
  ToolApprovalRequest,
} from '@weagent/shared';
import { buildClaudeHistoryPrompt, mergeStreamText, WEAGENT_MCP_TOOL_IDS } from '@weagent/shared';
import { REMOTE_ALLOWED_TOOLS, WRITE_TOOLS } from '@weagent/shared';
import type { ClaudeBridgeOptions, ClaudeSessionPool, ToolApprovalHandler } from '@weagent/claude-bridge';
import type { AgentRegistry } from './agent-registry.js';
import type { EventBus } from './event-bus.js';
import type { SessionManager } from './session-manager.js';

export class ApprovalQueue {
  private requests = new Map<string, ToolApprovalRequest>();
  private resolvers = new Map<string, (decision: ApprovalDecision) => void>();

  constructor(private timeoutMs: number) {}

  create(request: Omit<ToolApprovalRequest, 'id' | 'createdAt' | 'expiresAt'>): ToolApprovalRequest {
    const now = Date.now();
    const req: ToolApprovalRequest = {
      ...request,
      id: uuidv4(),
      createdAt: now,
      expiresAt: now + this.timeoutMs,
    };
    this.requests.set(req.id, req);
    setTimeout(() => {
      if (this.resolvers.has(req.id)) {
        this.resolve(req.id, 'deny');
      }
    }, this.timeoutMs);
    return req;
  }

  list(): ToolApprovalRequest[] {
    const now = Date.now();
    return Array.from(this.requests.values()).filter((r) => r.expiresAt > now);
  }

  waitForDecision(requestId: string): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      this.resolvers.set(requestId, resolve);
    });
  }

  resolve(requestId: string, decision: ApprovalDecision): boolean {
    const resolver = this.resolvers.get(requestId);
    if (!resolver) return false;
    resolver(decision);
    this.resolvers.delete(requestId);
    this.requests.delete(requestId);
    return true;
  }
}

export class SecurityPolicy {
  constructor(
    private remoteReadOnly: boolean,
    private approvalQueue: ApprovalQueue,
  ) {}

  resolveTools(agent: AgentConfig, channel: 'local' | 'remote'): string[] {
    let tools = [...agent.allowedTools];
    if (channel === 'remote' && this.remoteReadOnly) {
      tools = tools.filter((t) =>
        REMOTE_ALLOWED_TOOLS.some((r) => t.startsWith(r) || t === r),
      );
      if (tools.length === 0) {
        tools = [...REMOTE_ALLOWED_TOOLS];
      }
    }
    return tools;
  }

  isWriteTool(toolName: string): boolean {
    return WRITE_TOOLS.some((t) => toolName.startsWith(t) || toolName === t);
  }

  async requestApproval(
    conversationId: string,
    channel: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    onCreated?: (req: ToolApprovalRequest) => void,
  ): Promise<ApprovalDecision> {
    const req = this.approvalQueue.create({
      conversationId,
      channel,
      toolName,
      toolInput,
    });
    onCreated?.(req);
    return this.approvalQueue.waitForDecision(req.id);
  }
}

export class MultiAgentOrchestrator {
  private config: OrchestratorConfig = {
    mode: 'router',
    defaultAgentId: 'general',
  };
  private claudePath?: string;
  private claudeBareMode = false;
  private mcpConfigPath?: string;

  private static readonly SCHEDULED_TASK_SYSTEM_PROMPT =
    'WeAgent 定时任务：用户要求创建、修改、删除、查看或立即运行定时任务时，可用 weagent MCP 工具 scheduled_task_*，也可使用 Claude Code 内置 CronCreate（写入 .claude/scheduled_tasks.json）。两种方式 WeAgent 都会自动同步并在「定时任务」页展示、由 WeAgent 后台调度执行。创建后简要告知名称、调度时间与下次执行时间即可。';

  constructor(
    private sessionManager: SessionManager,
    private agentRegistry: AgentRegistry,
    private claudePool: ClaudeSessionPool,
    private eventBus: EventBus,
    private security: SecurityPolicy,
  ) {
    this.setupApprovalHandler();
  }

  setConfig(config: OrchestratorConfig): void {
    this.config = config;
  }

  setClaudePath(claudePath?: string): void {
    this.claudePath = claudePath;
  }

  setClaudeBareMode(bareMode: boolean): void {
    this.claudeBareMode = bareMode;
  }

  setMcpConfigPath(path: string | undefined): void {
    this.mcpConfigPath = path;
  }

  getConfig(): OrchestratorConfig {
    return { ...this.config };
  }

  resetClaudeSession(conversationId: string): void {
    this.claudePool.remove(conversationId);
    this.sessionManager.updateConversation(conversationId, { claudeSessionReady: false });
  }

  cancelConversation(conversationId: string): boolean {
    return this.claudePool.cancelQuery(conversationId);
  }

  isConversationRunning(conversationId: string): boolean {
    return this.claudePool.isQueryRunning(conversationId);
  }

  private setupApprovalHandler(): void {
    const handler: ToolApprovalHandler = async (request) => {
      if (request.channel === 'local') {
        return 'approve';
      }
      // 远程通道工具已在 REMOTE_ALLOWED_TOOLS 白名单内，直接放行
      if (request.toolName === 'Bash' || request.toolName === 'Write') {
        return 'approve';
      }
      if (!this.security.isWriteTool(request.toolName)) {
        return 'approve';
      }
      const decision = await this.security.requestApproval(
        request.sessionId,
        request.channel,
        request.toolName,
        request.toolInput,
        (req) => {
          this.eventBus.emit({
            type: 'approval_required',
            conversationId: request.sessionId,
            content: `需要审批工具: ${request.toolName}`,
            metadata: { approvalId: req.id, toolName: request.toolName, toolInput: request.toolInput },
            timestamp: Date.now(),
          });
        },
      );
      return decision;
    };
    this.claudePool.setApprovalHandler(handler);
  }

  async *handleMessage(
    conversationId: string,
    prompt: string,
    channel: 'local' | 'remote' = 'local',
    opts?: { attachments?: Array<{ path: string; fileName: string; mimeType: string; previewDataUrl?: string }> },
  ): AsyncGenerator<StreamEvent> {
    const conv = this.sessionManager.getConversation(conversationId);
    if (!conv) {
      yield {
        type: 'error',
        conversationId,
        content: 'Conversation not found',
        timestamp: Date.now(),
      };
      return;
    }

    const attachments = opts?.attachments ?? [];
    const imagePaths = attachments.map((a) => a.path);
    let effectivePrompt = prompt.trim();
    if (attachments.length > 0) {
      const pathHint = attachments.map((a) => `- ${a.path}`).join('\n');
      effectivePrompt = [
        effectivePrompt || '请分析以下图片。',
        '',
        '[用户上传的图片文件]',
        pathHint,
      ].join('\n');
    }
    const displayContent =
      prompt.trim() ||
      (attachments.length > 0 ? `[${attachments.length} 张图片]` : '');
    this.sessionManager.addUserMessage(conversationId, displayContent, {
      attachments: attachments.map((a) => ({
        kind: 'image',
        path: a.path,
        fileName: a.fileName,
        mimeType: a.mimeType,
        previewDataUrl: a.previewDataUrl,
      })),
    });

    switch (this.config.mode) {
      case 'pipeline':
        yield* this.runPipeline(conversationId, effectivePrompt, conv.cwd, channel, imagePaths);
        break;
      case 'parallel':
        yield* this.runParallel(conversationId, effectivePrompt, conv.cwd, channel, imagePaths);
        break;
      case 'router':
      default:
        yield* this.runRouter(
          conversationId,
          effectivePrompt,
          conv.cwd,
          conv.activeAgentId,
          channel,
          imagePaths,
        );
        break;
    }
  }

  private async *runRouter(
    conversationId: string,
    prompt: string,
    cwd: string,
    activeAgentId: string | undefined,
    channel: 'local' | 'remote',
    imagePaths: string[] = [],
  ): AsyncGenerator<StreamEvent> {
    const agentId = activeAgentId ?? this.routeIntent(prompt) ?? this.config.defaultAgentId;
    const agent = this.agentRegistry.get(agentId) ?? this.agentRegistry.get(this.config.defaultAgentId)!;

    yield {
      type: 'agent_switch',
      conversationId,
      content: agent.name,
      metadata: { agentId: agent.id },
      timestamp: Date.now(),
    };

    yield* this.runAgent(conversationId, prompt, agent, cwd, channel, imagePaths);
  }

  private routeIntent(prompt: string): string | null {
    const lower = prompt.toLowerCase();
    if (/审查|review|audit|检查代码/.test(lower)) return 'code-reviewer';
    if (/写代码|实现|开发|fix|bug|refactor|代码/.test(lower)) return 'code-dev';
    return null;
  }

  private async *runPipeline(
    conversationId: string,
    prompt: string,
    cwd: string,
    channel: 'local' | 'remote',
    imagePaths: string[] = [],
  ): AsyncGenerator<StreamEvent> {
    const steps = this.config.pipeline ?? [];
    let context = prompt;

    for (const [stepIndex, step] of steps.entries()) {
      const agent = this.agentRegistry.get(step.agentId);
      if (!agent) continue;

      yield {
        type: 'agent_switch',
        conversationId,
        content: agent.name,
        metadata: { agentId: agent.id, mode: 'pipeline' },
        timestamp: Date.now(),
      };

      const stepPrompt = step.promptTemplate
        ? step.promptTemplate.replace('{{input}}', context).replace('{{context}}', context)
        : context;

      let stepResult = '';
      const stepImages = stepIndex === 0 ? imagePaths : [];
      for await (const event of this.runAgent(
        conversationId,
        stepPrompt,
        agent,
        cwd,
        channel,
        stepImages,
      )) {
        yield event;
        if (event.type === 'text') {
          stepResult += event.content ?? '';
        }
      }
      context = stepResult || context;
    }
  }

  private async *runParallel(
    conversationId: string,
    prompt: string,
    cwd: string,
    channel: 'local' | 'remote',
    imagePaths: string[] = [],
  ): AsyncGenerator<StreamEvent> {
    const agentIds = this.config.parallelAgentIds ?? [];
    const results: string[] = [];

    for (const [agentIndex, agentId] of agentIds.entries()) {
      const agent = this.agentRegistry.get(agentId);
      if (!agent) continue;

      yield {
        type: 'agent_switch',
        conversationId,
        content: agent.name,
        metadata: { agentId: agent.id, mode: 'parallel' },
        timestamp: Date.now(),
      };

      let result = '';
      const agentImages = agentIndex === 0 ? imagePaths : [];
      for await (const event of this.runAgent(
        conversationId,
        prompt,
        agent,
        cwd,
        channel,
        agentImages,
      )) {
        yield event;
        if (event.type === 'text') {
          result += event.content ?? '';
        }
      }
      results.push(`## ${agent.name}\n${result}`);
    }

    const mergerId = this.config.mergerAgentId ?? this.config.defaultAgentId;
    const merger = this.agentRegistry.get(mergerId);
    if (merger && results.length > 0) {
      const mergePrompt = `请汇总以下各 Agent 的输出，给出统一结论：\n\n${results.join('\n\n')}`;
      yield* this.runAgent(conversationId, mergePrompt, merger, cwd, channel);
    }
  }

  private async *runAgent(
    conversationId: string,
    prompt: string,
    agent: AgentConfig,
    cwd: string,
    channel: 'local' | 'remote',
    imagePaths: string[] = [],
  ): AsyncGenerator<StreamEvent> {
    const conv = this.sessionManager.getConversation(conversationId);
    if (!conv) return;

    const sessionCwd = conv.cwd || cwd || process.cwd();
    const { messages: priorMessages } = this.sessionManager.getMessages(conversationId, {
      limit: 5,
    });
    const resumeSession =
      (conv.claudeSessionReady ?? false) || priorMessages.length > 1;
    const fallbackPrompt = this.sessionManager.hasAssistantMessage(conversationId)
      ? this.buildHistoryPrompt(conversationId, prompt, channel)
      : undefined;

    const remotePromptAppend =
      channel === 'remote'
        ? '你正在通过微信为用户提供远程助手服务。请根据用户最新消息直接作答；若问题与某已加载 Skill 的能力描述匹配，请主动调用 Skill 工具完成，不要罗列 Skill 清单让用户挑选（除非用户明确询问有哪些 Skill）。'
        : '';

    const schedulePromptAppend = this.mcpConfigPath
      ? MultiAgentOrchestrator.SCHEDULED_TASK_SYSTEM_PROMPT
      : '';

    const systemPromptAppend = [agent.systemPromptAppend, remotePromptAppend, schedulePromptAppend]
      .filter(Boolean)
      .join('\n\n');

    const baseTools = this.security.resolveTools(agent, channel);
    const allowedTools = this.mcpConfigPath
      ? [...baseTools, ...WEAGENT_MCP_TOOL_IDS]
      : baseTools;

    const options: ClaudeBridgeOptions = {
      sessionId: conversationId,
      resumeSession,
      fallbackPrompt,
      cwd: sessionCwd,
      allowedTools,
      mcpConfig: this.mcpConfigPath,
      systemPromptAppend: systemPromptAppend || undefined,
      cliAgent: 'general-purpose',
      bareMode: this.claudeBareMode,
      model: agent.model,
      maxBudgetUsd: agent.maxBudgetUsd,
      maxTurns: agent.maxTurns,
      claudePath: this.claudePath,
      images: imagePaths.length > 0 ? imagePaths : undefined,
      // dontAsk = 未预批准则静默拒绝；headless 嵌入须 bypassPermissions
      permissionMode: 'bypassPermissions',
    };

    let accumulatedText = '';
    let lastError = '';
    const stepFailures: string[] = [];
    let sessionReady = resumeSession;
    for await (const event of this.claudePool.runQuery(conversationId, prompt, options, channel)) {
      yield event;
      if (event.metadata?.sessionNotFound) {
        sessionReady = false;
      }
      if (event.type === 'text' && event.content) {
        accumulatedText = mergeStreamText(accumulatedText, event.content);
      }
      if (event.type === 'tool_result' && event.metadata?.isError && event.content) {
        const detail = event.content.replace(/^✗\s*/, '').trim();
        if (/requires approval|需要审批|permission denied|awaiting approval|don't ask mode|dontAsk|权限系统/i.test(detail)) {
          continue;
        }
        const name = String(event.metadata?.toolName ?? '工具');
        stepFailures.push(`${name}：${detail.slice(0, 200)}`);
      }
      if (event.type === 'error' && !event.metadata?.sessionNotFound) {
        lastError = event.content ?? '';
        if (lastError) stepFailures.push(lastError.slice(0, 200));
      }
    }

    let contentToSave = accumulatedText;
    const uniqueFailures = [...new Set(stepFailures)].slice(0, 8);
    if (uniqueFailures.length > 0) {
      const footer = [
        '',
        '---',
        '',
        `⚠️ 本轮有 ${uniqueFailures.length} 个步骤失败（如接口限流、命令非零退出），以下结论可能基于不完整数据：`,
        ...uniqueFailures.map((line) => `- ${line}`),
        '',
        '完整日志见右侧 Trace 面板。',
      ].join('\n');
      contentToSave = contentToSave ? `${contentToSave}${footer}` : footer.trim();
    }
    if (contentToSave) {
      sessionReady = true;
      const recent = this.sessionManager.getMessages(conversationId, { limit: 20 }).messages;
      const lastAssistant = [...recent].reverse().find((m) => m.role === 'assistant');
      const dup =
        lastAssistant?.content === contentToSave &&
        Date.now() - lastAssistant.createdAt < 60_000;
      if (!dup) {
        this.sessionManager.addAssistantMessage(conversationId, contentToSave);
      }
    }

    if (sessionReady !== conv.claudeSessionReady) {
      this.sessionManager.updateConversation(conversationId, { claudeSessionReady: sessionReady });
    }

    if (!contentToSave && lastError) {
      this.sessionManager.addAssistantMessage(conversationId, lastError, 'error');
      yield {
        type: 'text',
        conversationId,
        content: lastError,
        metadata: { final: true, canonical: true },
        timestamp: Date.now(),
      };
      return;
    }

    if (contentToSave) {
      yield {
        type: 'text',
        conversationId,
        content: contentToSave,
        metadata: { final: true, canonical: true },
        timestamp: Date.now(),
      };
    }
  }

  private buildHistoryPrompt(
    conversationId: string,
    currentPrompt: string,
    channel: 'local' | 'remote',
  ): string {
    const { messages } = this.sessionManager.getMessages(conversationId, { limit: 20 });
    const maxChars = channel === 'remote' ? 4000 : 6000;
    return buildClaudeHistoryPrompt(messages, currentPrompt, maxChars);
  }
}
