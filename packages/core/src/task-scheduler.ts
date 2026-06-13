import { randomUUID } from 'node:crypto';
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskRun } from '@weagent/shared';
import type { ChannelRouter } from './channel-router.js';
import type { DatabaseService } from './database.js';
import type { EventBus } from './event-bus.js';
import type { SessionManager } from './session-manager.js';
import { saveScheduledTaskRecord } from './scheduled-task-api.js';
import { computeNextRunAt } from './schedule-utils.js';
import { resolveTaskConversation } from './task-conversation.js';

const TICK_MS = 30_000;

export interface TaskSchedulerDeps {
  db: DatabaseService;
  sessionManager: SessionManager;
  channelRouter: ChannelRouter;
  eventBus: EventBus;
  getDefaultCwd: () => string;
}

export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();

  constructor(private deps: TaskSchedulerDeps) {}

  start(): void {
    this.recoverStaleRuns();
    this.refreshAllNextRunAt();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  listTasks(): ScheduledTask[] {
    return this.deps.db.listScheduledTasks();
  }

  listRuns(taskId: string, limit?: number): ScheduledTaskRun[] {
    return this.deps.db.listScheduledTaskRuns(taskId, limit);
  }

  saveTask(input: ScheduledTaskInput): ScheduledTask {
    const existing = input.id ? this.deps.db.getScheduledTask(input.id) : null;
    let conversationId = input.conversationId ?? existing?.conversationId;
    if (!conversationId && !existing) {
      conversationId = this.deps.sessionManager.listConversations(1)[0]?.id;
    }

    const task = saveScheduledTaskRecord(
      this.deps.db,
      { ...input, conversationId },
      existing,
    );

    this.deps.eventBus.emit({
      type: 'conversation_updated',
      conversationId: task.conversationId ?? task.id,
      content: 'scheduled_task_updated',
      metadata: { kind: 'scheduled_task_updated', taskId: task.id },
      timestamp: Date.now(),
    });

    return task;
  }

  deleteTask(id: string): boolean {
    const ok = this.deps.db.deleteScheduledTask(id);
    if (ok) {
      this.deps.eventBus.emit({
        type: 'conversation_updated',
        conversationId: id,
        content: 'scheduled_task_deleted',
        metadata: { kind: 'scheduled_task_deleted', taskId: id },
        timestamp: Date.now(),
      });
    }
    return ok;
  }

  setEnabled(id: string, enabled: boolean): ScheduledTask | null {
    const task = this.deps.db.getScheduledTask(id);
    if (!task) return null;
    return this.saveTask({
      id: task.id,
      name: task.name,
      enabled,
      scheduleKind: task.scheduleKind,
      cronExpression: task.cronExpression,
      dailyTime: task.dailyTime,
      intervalMs: task.intervalMs,
      prompt: task.prompt,
      conversationId: task.conversationId,
      agentId: task.agentId,
      cwd: task.cwd,
    });
  }

  async runNow(taskId: string): Promise<ScheduledTaskRun | null> {
    const task = this.deps.db.getScheduledTask(taskId);
    if (!task) return null;
    if (this.running.has(task.id)) {
      return (
        this.deps.db
          .listScheduledTaskRuns(task.id, 5)
          .find((run) => run.status === 'running') ?? null
      );
    }
    return this.executeTask(task, { manual: true });
  }

  /** 应用重启后清理 DB 中残留的 running 记录，并清空内存锁 */
  private recoverStaleRuns(): void {
    this.running.clear();
    const now = Date.now();
    for (const task of this.deps.db.listScheduledTasks()) {
      for (const run of this.deps.db.listScheduledTaskRuns(task.id, 10)) {
        if (run.status !== 'running') continue;
        this.deps.db.finishScheduledTaskRun(run.id, {
          status: 'error',
          finishedAt: now,
          error: '应用重启或异常退出，任务执行已中断',
        });
      }
    }
  }

  private refreshAllNextRunAt(): void {
    for (const task of this.deps.db.listScheduledTasks()) {
      if (!task.enabled) continue;
      try {
        const nextRunAt = computeNextRunAt(task);
        if (nextRunAt !== task.nextRunAt) {
          this.deps.db.saveScheduledTask({ ...task, nextRunAt });
        }
      } catch {
        // invalid schedule left as-is until user fixes
      }
    }
  }

  private async tick(): Promise<void> {
    const due = this.deps.db.listDueScheduledTasks();
    for (const task of due) {
      if (this.running.has(task.id)) continue;
      void this.executeTask(task);
    }
  }

  private async executeTask(
    task: ScheduledTask,
    opts?: { manual?: boolean },
  ): Promise<ScheduledTaskRun> {
    if (this.running.has(task.id)) {
      throw new Error('任务正在执行中');
    }
    this.running.add(task.id);

    const runId = randomUUID();
    const startedAt = Date.now();

    const resolved = resolveTaskConversation(
      task,
      this.deps.sessionManager,
      this.deps.getDefaultCwd,
    );
    const conversationId = resolved.conversationId;

    if (resolved.shouldRebind) {
      this.deps.db.saveScheduledTask({ ...task, conversationId });
    }

    if (task.agentId) {
      this.deps.sessionManager.updateConversation(conversationId, {
        activeAgentId: task.agentId,
      });
    }

    const run = this.deps.db.createScheduledTaskRun({
      id: runId,
      taskId: task.id,
      status: 'running',
      startedAt,
      conversationId,
    });

    this.deps.eventBus.emit({
      type: 'status',
      conversationId,
      content: opts?.manual ? `手动执行定时任务：${task.name}` : `定时任务开始：${task.name}`,
      metadata: {
        kind: 'task_started',
        taskId: task.id,
        runId,
        manual: opts?.manual ?? false,
        wechat: Boolean(resolved.wechatPeerId),
      },
      timestamp: startedAt,
    });

    try {
      const { lastError, wechatError } = await this.deps.channelRouter.executeScheduledTask(
        conversationId,
        task.prompt,
        {
          taskId: task.id,
          runId,
          taskName: task.name,
          manual: opts?.manual,
        },
      );

      const combinedError = wechatError || lastError;
      const finishedAt = Date.now();
      const status = combinedError ? 'error' : 'success';
      this.deps.db.finishScheduledTaskRun(runId, {
        status,
        finishedAt,
        error: combinedError || undefined,
      });

      const nextRunAt = task.enabled
        ? computeNextRunAt(task, finishedAt)
        : task.nextRunAt;
      this.deps.db.saveScheduledTask({
        ...task,
        conversationId,
        lastRunAt: startedAt,
        nextRunAt,
      });

      this.deps.eventBus.emit({
        type: 'status',
        conversationId,
        content: status === 'success' ? `定时任务完成：${task.name}` : `定时任务失败：${task.name}`,
        metadata: {
          kind: status === 'success' ? 'task_completed' : 'task_failed',
          taskId: task.id,
          runId,
          error: combinedError || undefined,
        },
        timestamp: finishedAt,
      });

      return { ...run, status, finishedAt, error: combinedError || undefined };
    } catch (error) {
      const finishedAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      this.deps.db.finishScheduledTaskRun(runId, {
        status: 'error',
        finishedAt,
        error: message,
      });
      this.deps.db.saveScheduledTask({
        ...task,
        conversationId,
        lastRunAt: startedAt,
        nextRunAt: task.enabled ? computeNextRunAt(task, finishedAt) : task.nextRunAt,
      });
      this.deps.eventBus.emit({
        type: 'error',
        conversationId,
        content: message,
        metadata: { kind: 'task_failed', taskId: task.id, runId },
        timestamp: finishedAt,
      });
      return { ...run, status: 'error', finishedAt, error: message };
    } finally {
      this.running.delete(task.id);
    }
  }
}
