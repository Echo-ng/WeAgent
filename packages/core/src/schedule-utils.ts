import { CronExpressionParser } from 'cron-parser';
import type { ScheduleKind, ScheduledTask } from '@weagent/shared';

type ScheduleInput = Pick<
  ScheduledTask,
  'scheduleKind' | 'cronExpression' | 'dailyTime' | 'intervalMs'
>;

export function computeNextRunAt(task: ScheduleInput, fromMs = Date.now()): number {
  if (task.scheduleKind === 'interval' && task.intervalMs && task.intervalMs > 0) {
    return fromMs + task.intervalMs;
  }

  if (task.scheduleKind === 'daily' && task.dailyTime) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(task.dailyTime.trim());
    if (!match) throw new Error(`无效的每日时间: ${task.dailyTime}`);
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) throw new Error(`无效的每日时间: ${task.dailyTime}`);

    const next = new Date(fromMs);
    next.setSeconds(0, 0);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= fromMs) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }

  if (task.scheduleKind === 'cron' && task.cronExpression?.trim()) {
    const interval = CronExpressionParser.parse(task.cronExpression.trim(), {
      currentDate: new Date(fromMs),
    });
    return interval.next().toDate().getTime();
  }

  throw new Error('未配置有效的调度规则');
}

export function validateScheduleInput(input: {
  scheduleKind: ScheduleKind;
  cronExpression?: string;
  dailyTime?: string;
  intervalMs?: number;
}): void {
  if (input.scheduleKind === 'daily') {
    if (!input.dailyTime?.trim()) throw new Error('请设置每日执行时间');
    computeNextRunAt({
      scheduleKind: 'daily',
      dailyTime: input.dailyTime,
    });
    return;
  }
  if (input.scheduleKind === 'cron') {
    if (!input.cronExpression?.trim()) throw new Error('请设置 Cron 表达式');
    computeNextRunAt({
      scheduleKind: 'cron',
      cronExpression: input.cronExpression,
    });
    return;
  }
  if (input.scheduleKind === 'interval') {
    if (!input.intervalMs || input.intervalMs < 60_000) {
      throw new Error('间隔至少 1 分钟');
    }
  }
}
