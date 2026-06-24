import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { ClaudeSessionPool } from '@weagent/claude-bridge';
import type {
  AgentConfig,
  AppSettings,
  ApprovalDecision,
  Conversation,
  GetMessagesOptions,
  OrchestratorConfig,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  StreamEvent,
  ToolApprovalRequest,
} from '@weagent/shared';
import { DEFAULT_SETTINGS as DEFAULTS } from '@weagent/shared';
import { AgentRegistry } from './agent-registry.js';
import { ApprovalQueue, MultiAgentOrchestrator, SecurityPolicy } from './orchestrator.js';
import { ChannelRouter } from './channel-router.js';
import { DatabaseService } from './database.js';
import { EventBus } from './event-bus.js';
import { SessionManager } from './session-manager.js';
import { TaskScheduler } from './task-scheduler.js';
import { writeWeAgentMcpConfig } from './mcp-config.js';
import { TaskApiServer } from './task-api-server.js';
import { findScheduledTask, requestScheduledTaskRun, saveScheduledTaskRecord } from './scheduled-task-api.js';
import {
  ClaudeTaskFileWatcher,
  syncClaudeScheduledTasks,
  taskToClaudeCron,
  upsertWeAgentTaskInClaudeFile,
  type ClaudeTaskSyncResult,
} from './claude-task-sync.js';
import { AttachmentStore } from './attachment-store.js';
import type { SaveImageAttachmentInput, SavedImageAttachment } from '@weagent/shared';

export interface AppServiceOptions {
  dataDir: string;
  /** @weagent/mcp-weagent 编译产物路径，用于对话中创建定时任务 */
  mcpServerScriptPath?: string;
  /** 额外扫描 .claude/scheduled_tasks.json 的目录 */
  taskSearchDirs?: string[];
}

export class AppService {
  readonly eventBus = new EventBus();
  readonly db: DatabaseService;
  readonly sessionManager: SessionManager;
  readonly agentRegistry: AgentRegistry;
  readonly claudePool = new ClaudeSessionPool();
  readonly approvalQueue: ApprovalQueue;
  readonly security: SecurityPolicy;
  readonly orchestrator: MultiAgentOrchestrator;
  readonly channelRouter: ChannelRouter;
  readonly taskScheduler: TaskScheduler;
  readonly attachmentStore: AttachmentStore;
  private readonly taskApiServer = new TaskApiServer();
  private readonly claudeTaskWatcher = new ClaudeTaskFileWatcher();
  private syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dataDir: string;
  private mcpServerScriptPath?: string;
  private extraTaskSearchDirs: string[];

  private settings: AppSettings;
  private settingsPath: string;
  private orchestratorPath: string;

  constructor(options: AppServiceOptions) {
    if (!existsSync(options.dataDir)) {
      mkdirSync(options.dataDir, { recursive: true });
    }

    this.settingsPath = join(options.dataDir, 'settings.json');
    this.orchestratorPath = join(options.dataDir, 'orchestrator.json');
    this.dataDir = options.dataDir;
    this.mcpServerScriptPath = options.mcpServerScriptPath;
    this.extraTaskSearchDirs = options.taskSearchDirs ?? [];
    this.settings = this.loadSettings();

    this.db = new DatabaseService(join(options.dataDir, 'weagent.db'));
    this.attachmentStore = new AttachmentStore(options.dataDir);
    this.sessionManager = new SessionManager(this.db);
    this.agentRegistry = new AgentRegistry(join(options.dataDir, 'agents'));
    this.approvalQueue = new ApprovalQueue(this.settings.approvalTimeoutMs);
    this.security = new SecurityPolicy(this.settings.remoteReadOnly, this.approvalQueue);
    this.orchestrator = new MultiAgentOrchestrator(
      this.sessionManager,
      this.agentRegistry,
      this.claudePool,
      this.eventBus,
      this.security,
    );
    this.orchestrator.setConfig(this.loadOrchestratorConfig());
    this.orchestrator.setClaudePath(this.settings.claudePath);
    this.orchestrator.setClaudeBareMode(this.settings.claudeBareMode ?? false);
    this.channelRouter = new ChannelRouter(
      this.sessionManager,
      this.orchestrator,
      this.agentRegistry,
      this.settings.defaultCwd,
      (event) => this.eventBus.emit(event),
    );

    this.taskScheduler = new TaskScheduler({
      db: this.db,
      sessionManager: this.sessionManager,
      channelRouter: this.channelRouter,
      eventBus: this.eventBus,
      getDefaultCwd: () => this.settings.defaultCwd || process.cwd(),
    });
    this.taskScheduler.start();
  }

  /** 启动主进程任务 API 与 MCP 配置（需在 Electron ready 后调用） */
  async startTaskBridge(): Promise<void> {
    const apiUrl = await this.taskApiServer.start({
      listScheduledTasks: () => this.listScheduledTasks(),
      saveScheduledTask: (input) => this.saveScheduledTask(input),
      deleteScheduledTask: (id) => this.deleteScheduledTask(id),
      setScheduledTaskEnabled: (id, enabled) => this.setScheduledTaskEnabled(id, enabled),
      requestRunNow: (id) => requestScheduledTaskRun(this.db, id),
      findTask: (idOrName) => findScheduledTask(this.db, idOrName),
    });

    if (this.mcpServerScriptPath) {
      const mcpConfigPath = writeWeAgentMcpConfig({
        dataDir: this.dataDir,
        serverScriptPath: this.mcpServerScriptPath,
        taskApiUrl: apiUrl,
        taskApiToken: this.taskApiServer.token,
      });
      this.orchestrator.setMcpConfigPath(mcpConfigPath);
    }

    this.syncClaudeNativeTasks();
    this.restartTaskWatcher();
  }

  private restartTaskWatcher(): void {
    this.claudeTaskWatcher.start(this.getTaskSearchDirs(), () => {
      this.scheduleClaudeNativeSync();
    });
  }

  private scheduleClaudeNativeSync(): void {
    if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);
    this.syncDebounceTimer = setTimeout(() => {
      this.syncDebounceTimer = null;
      this.syncClaudeNativeTasks();
    }, 2000);
  }

  getTaskSearchDirs(): string[] {
    const dirs = [
      this.settings.defaultCwd,
      this.dataDir,
      ...this.extraTaskSearchDirs,
      ...(this.settings.taskSearchDirs ?? []),
    ];
    for (const conv of this.sessionManager.listConversations(200)) {
      if (conv.cwd?.trim()) dirs.push(conv.cwd);
    }
    for (const task of this.db.listScheduledTasks()) {
      if (task.cwd?.trim()) dirs.push(task.cwd);
    }
    return [...new Set(dirs.filter((d) => d?.trim()))];
  }

  syncClaudeNativeTasks(): ClaudeTaskSyncResult {
    const result = syncClaudeScheduledTasks(this.db, this.getTaskSearchDirs());
    if (result.imported > 0 || result.updated > 0 || result.removed > 0) {
      this.eventBus.emit({
        type: 'conversation_updated',
        conversationId: 'scheduled-tasks',
        content: 'claude_native_sync',
        metadata: {
          kind: 'scheduled_task_updated',
          imported: result.imported,
          updated: result.updated,
          removed: result.removed,
        },
        timestamp: Date.now(),
      });
    }
    return result;
  }

  getSettings(): AppSettings {
    return { ...this.settings };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch };
    writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf-8');
    this.channelRouter.setDefaultCwd(this.settings.defaultCwd);
    this.orchestrator.setClaudePath(this.settings.claudePath);
    this.orchestrator.setClaudeBareMode(this.settings.claudeBareMode ?? false);
    if (patch.defaultCwd !== undefined || patch.taskSearchDirs !== undefined) {
      this.syncClaudeNativeTasks();
      this.restartTaskWatcher();
    }
    return this.getSettings();
  }

  private loadOrchestratorConfig(): OrchestratorConfig {
    const defaults: OrchestratorConfig = {
      mode: 'router',
      defaultAgentId: 'general',
      pipeline: [{ agentId: 'code-dev' }, { agentId: 'code-reviewer' }, { agentId: 'general' }],
      parallelAgentIds: ['code-dev', 'code-reviewer'],
      mergerAgentId: 'general',
    };
    if (existsSync(this.orchestratorPath)) {
      try {
        return { ...defaults, ...JSON.parse(readFileSync(this.orchestratorPath, 'utf-8')) };
      } catch {
        return defaults;
      }
    }
    return defaults;
  }

  private loadSettings(): AppSettings {
    if (existsSync(this.settingsPath)) {
      try {
        return { ...DEFAULTS, ...JSON.parse(readFileSync(this.settingsPath, 'utf-8')) };
      } catch {
        return { ...DEFAULTS };
      }
    }
    return { ...DEFAULTS };
  }

  createConversation(title: string, cwd?: string): Conversation {
    return this.sessionManager.createConversation({
      title,
      cwd: cwd ?? this.settings.defaultCwd,
      channel: 'local',
    });
  }

  listConversations(): Conversation[] {
    return this.sessionManager.listConversations();
  }

  deleteConversation(id: string): boolean {
    const ok = this.sessionManager.deleteConversation(id);
    if (ok) {
      this.orchestrator.resetClaudeSession(id);
    }
    return ok;
  }

  listScheduledTasks(): ScheduledTask[] {
    return this.taskScheduler.listTasks();
  }

  saveScheduledTask(input: ScheduledTaskInput): ScheduledTask {
    const existing = input.id ? this.db.getScheduledTask(input.id) : null;
    if (existing?.claudeNativeId) {
      return existing;
    }
    const cwd = input.cwd?.trim() || this.settings.defaultCwd?.trim();
    let task = this.taskScheduler.saveTask({ ...input, cwd: cwd || input.cwd });
    task = this.exportTaskToClaudeFile(task) ?? task;
    this.restartTaskWatcher();
    return task;
  }

  deleteScheduledTask(id: string): boolean {
    const ok = this.taskScheduler.deleteTask(id);
    if (ok) this.restartTaskWatcher();
    return ok;
  }

  setScheduledTaskEnabled(id: string, enabled: boolean): ScheduledTask | null {
    const existing = this.db.getScheduledTask(id);
    if (existing?.claudeNativeId) {
      return existing;
    }
    const task = this.taskScheduler.setEnabled(id, enabled);
    if (!task) return null;
    if (enabled) {
      return this.exportTaskToClaudeFile(task) ?? task;
    }
    this.restartTaskWatcher();
    return task;
  }

  private exportTaskToClaudeFile(task: ScheduledTask): ScheduledTask | null {
    const cwd = task.cwd?.trim() || this.settings.defaultCwd?.trim();
    if (!cwd || !task.enabled || !taskToClaudeCron(task)) return null;

    const nativeId = upsertWeAgentTaskInClaudeFile(task, cwd);
    if (!nativeId || nativeId === task.claudeNativeId) return null;

    return saveScheduledTaskRecord(
      this.db,
      {
        id: task.id,
        name: task.name,
        enabled: task.enabled,
        scheduleKind: task.scheduleKind,
        cronExpression: task.cronExpression,
        dailyTime: task.dailyTime,
        intervalMs: task.intervalMs,
        prompt: task.prompt,
        conversationId: task.conversationId,
        agentId: task.agentId,
        cwd: task.cwd ?? cwd,
        claudeNativeId: nativeId,
        createdAt: task.createdAt,
      },
      task,
    );
  }

  runScheduledTaskNow(id: string): Promise<ScheduledTaskRun | null> {
    return this.taskScheduler.runNow(id);
  }

  listScheduledTaskRuns(taskId: string, limit?: number): ScheduledTaskRun[] {
    return this.taskScheduler.listRuns(taskId, limit);
  }

  getMessages(conversationId: string, options?: GetMessagesOptions) {
    return this.sessionManager.getMessages(conversationId, options);
  }

  saveImageAttachment(
    conversationId: string,
    input: SaveImageAttachmentInput,
  ): SavedImageAttachment {
    const conv = this.sessionManager.getConversation(conversationId);
    const workspaceDir = conv?.cwd || this.settings.defaultCwd;
    return this.attachmentStore.saveImage(conversationId, input, workspaceDir);
  }

  readAttachmentImage(filePath: string): string {
    return this.attachmentStore.readImageAsDataUrl(filePath);
  }

  async sendMessage(
    conversationId: string,
    text: string,
    opts?: { attachments?: SavedImageAttachment[] },
  ): Promise<StreamEvent[]> {
    return this.channelRouter.handleLocalMessage(conversationId, text, opts);
  }

  cancelConversation(conversationId: string): boolean {
    return this.orchestrator.cancelConversation(conversationId);
  }

  isConversationRunning(conversationId: string): boolean {
    return this.orchestrator.isConversationRunning(conversationId);
  }

  listAgents(): AgentConfig[] {
    return this.agentRegistry.list();
  }

  saveAgent(agent: AgentConfig): AgentConfig {
    if (!agent.cwd) agent.cwd = this.settings.defaultCwd;
    this.agentRegistry.save(agent);
    return agent;
  }

  deleteAgent(id: string): boolean {
    return this.agentRegistry.delete(id);
  }

  getOrchestratorConfig(): OrchestratorConfig {
    return this.orchestrator.getConfig();
  }

  setOrchestratorConfig(config: OrchestratorConfig): OrchestratorConfig {
    this.orchestrator.setConfig(config);
    writeFileSync(this.orchestratorPath, JSON.stringify(config, null, 2), 'utf-8');
    return this.orchestrator.getConfig();
  }

  listApprovals(): ToolApprovalRequest[] {
    return this.approvalQueue.list();
  }

  resolveApproval(requestId: string, decision: ApprovalDecision): boolean {
    return this.approvalQueue.resolve(requestId, decision);
  }

  async checkClaude(): Promise<{ ok: boolean; version?: string; error?: string }> {
    return this.claudePool.checkClaudeAvailable(this.settings.claudePath);
  }

  shutdown(): void {
    if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);
    this.claudeTaskWatcher.stop();
    this.taskScheduler.stop();
    this.taskApiServer.stop();
    this.db.close();
  }
}
