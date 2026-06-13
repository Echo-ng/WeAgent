import type { ScheduleKind, ScheduledTask } from './types.js';

type ScheduleInput = Pick<
  ScheduledTask,
  'scheduleKind' | 'cronExpression' | 'dailyTime' | 'intervalMs'
>;

export function formatScheduleLabel(task: ScheduleInput): string {
  if (task.scheduleKind === 'daily' && task.dailyTime) {
    return `每天 ${task.dailyTime}`;
  }
  if (task.scheduleKind === 'cron' && task.cronExpression) {
    return `Cron ${task.cronExpression}`;
  }
  if (task.scheduleKind === 'interval' && task.intervalMs) {
    const mins = Math.round(task.intervalMs / 60_000);
    if (mins < 60) return `每 ${mins} 分钟`;
    const hours = Math.round(mins / 60);
    return `每 ${hours} 小时`;
  }
  return '未配置';
}

export function scheduleKindLabel(kind: ScheduleKind): string {
  switch (kind) {
    case 'daily':
      return '每日定时';
    case 'cron':
      return 'Cron 表达式';
    case 'interval':
      return '固定间隔';
  }
}

export function formatTaskRunTime(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
