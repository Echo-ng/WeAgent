import { randomUUID } from 'node:crypto';
import type { ScheduledTask, ScheduledTaskInput } from '@weagent/shared';
import type { DatabaseService } from './database.js';
import { computeNextRunAt, validateScheduleInput } from './schedule-utils.js';

export function saveScheduledTaskRecord(
  db: DatabaseService,
  input: ScheduledTaskInput,
  existing?: ScheduledTask | null,
): ScheduledTask {
  validateScheduleInput(input);
  const prior = existing ?? (input.id ? db.getScheduledTask(input.id) : null);
  const enabled = input.enabled ?? prior?.enabled ?? true;
  const nextRunAt = enabled
    ? computeNextRunAt({
        scheduleKind: input.scheduleKind,
        cronExpression: input.cronExpression,
        dailyTime: input.dailyTime,
        intervalMs: input.intervalMs,
      })
    : prior?.nextRunAt;

  return db.saveScheduledTask({
    id: input.id ?? prior?.id ?? randomUUID(),
    name: input.name.trim(),
    enabled,
    scheduleKind: input.scheduleKind,
    cronExpression: input.cronExpression?.trim() || undefined,
    dailyTime: input.dailyTime?.trim() || undefined,
    intervalMs: input.intervalMs,
    prompt: input.prompt.trim(),
    conversationId: input.conversationId ?? prior?.conversationId,
    agentId: input.agentId?.trim() || undefined,
    cwd: input.cwd?.trim() || undefined,
    claudeNativeId: input.claudeNativeId ?? prior?.claudeNativeId,
    lastRunAt: prior?.lastRunAt,
    nextRunAt,
    createdAt: input.createdAt ?? prior?.createdAt,
  });
}

export function requestScheduledTaskRun(db: DatabaseService, taskId: string): ScheduledTask | null {
  const task = db.getScheduledTask(taskId);
  if (!task) return null;
  return db.saveScheduledTask({
    ...task,
    enabled: true,
    nextRunAt: Date.now(),
  });
}

export function findScheduledTask(
  db: DatabaseService,
  taskIdOrName: string,
): ScheduledTask | null {
  const byId = db.getScheduledTask(taskIdOrName);
  if (byId) return byId;
  const needle = taskIdOrName.trim().toLowerCase();
  return (
    db.listScheduledTasks().find((t) => t.name.toLowerCase() === needle) ??
    db.listScheduledTasks().find((t) => t.name.toLowerCase().includes(needle)) ??
    null
  );
}
