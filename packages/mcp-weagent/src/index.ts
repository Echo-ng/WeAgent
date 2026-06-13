#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formatScheduleLabel, formatTaskRunTime } from '@weagent/shared';
import type { ScheduledTask } from '@weagent/shared';
import {
  createTask,
  deleteTask,
  listTasks,
  runTaskNow,
  setTaskEnabled,
  updateTask,
} from './task-api-client.js';

function taskSummary(task: ScheduledTask) {
  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    schedule: formatScheduleLabel(task),
    nextRunAt: formatTaskRunTime(task.nextRunAt),
    lastRunAt: formatTaskRunTime(task.lastRunAt),
    agentId: task.agentId,
    promptPreview: task.prompt.length > 120 ? `${task.prompt.slice(0, 120)}…` : task.prompt,
  };
}

const server = new McpServer({
  name: 'weagent',
  version: '0.1.0',
});

server.tool(
  'scheduled_task_create',
  '在 WeAgent 中创建定时任务。当用户要求「每天某时间执行…」「定时收集…」「cron 任务」时使用。',
  {
    name: z.string().describe('任务名称，简短易懂，如「盘前策略」'),
    prompt: z.string().describe('到点后发给 Claude 执行的完整指令'),
    schedule_kind: z
      .enum(['daily', 'cron', 'interval'])
      .describe('daily=每天固定时刻；cron=cron 表达式；interval=固定间隔'),
    daily_time: z.string().optional().describe('daily 时必填，本地时区 HH:MM，如 09:00'),
    cron_expression: z.string().optional().describe('cron 时必填，5 段表达式，如 0 9 * * 1-5'),
    interval_minutes: z.number().int().min(1).optional().describe('interval 时必填，间隔分钟数'),
    agent_id: z.string().optional().describe('Agent ID，默认 general'),
    cwd: z.string().optional().describe('工作区路径，留空用默认'),
    enabled: z.boolean().optional().describe('是否启用，默认 true'),
  },
  async (args) => {
    const task = await createTask({
      name: args.name,
      prompt: args.prompt,
      scheduleKind: args.schedule_kind,
      dailyTime: args.daily_time,
      cronExpression: args.cron_expression,
      intervalMs: args.interval_minutes ? args.interval_minutes * 60_000 : undefined,
      agentId: args.agent_id ?? 'general',
      cwd: args.cwd,
      enabled: args.enabled ?? true,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { ok: true, message: `已创建定时任务「${task.name}」`, task: taskSummary(task) },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool('scheduled_task_list', '列出 WeAgent 中所有定时任务', {}, async () => {
  const tasks = (await listTasks()).map(taskSummary);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ ok: true, count: tasks.length, tasks }, null, 2),
      },
    ],
  };
});

server.tool(
  'scheduled_task_update',
  '更新已有定时任务（按 id 或名称定位）',
  {
    task_id_or_name: z.string().describe('任务 ID 或名称'),
    name: z.string().optional(),
    prompt: z.string().optional(),
    schedule_kind: z.enum(['daily', 'cron', 'interval']).optional(),
    daily_time: z.string().optional(),
    cron_expression: z.string().optional(),
    interval_minutes: z.number().int().min(1).optional(),
    agent_id: z.string().optional(),
    cwd: z.string().optional(),
    enabled: z.boolean().optional(),
  },
  async (args) => {
    const task = await updateTask(args.task_id_or_name, {
      name: args.name,
      prompt: args.prompt,
      scheduleKind: args.schedule_kind,
      dailyTime: args.daily_time,
      cronExpression: args.cron_expression,
      intervalMs: args.interval_minutes != null ? args.interval_minutes * 60_000 : undefined,
      agentId: args.agent_id,
      cwd: args.cwd,
      enabled: args.enabled,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, message: '已更新', task: taskSummary(task) }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  'scheduled_task_delete',
  '删除定时任务（按 id 或名称）',
  { task_id_or_name: z.string().describe('任务 ID 或名称') },
  async (args) => {
    await deleteTask(args.task_id_or_name);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, message: '已删除' }) }],
    };
  },
);

server.tool(
  'scheduled_task_set_enabled',
  '启用或暂停定时任务',
  { task_id_or_name: z.string(), enabled: z.boolean() },
  async (args) => {
    const task = await setTaskEnabled(args.task_id_or_name, args.enabled);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              ok: true,
              message: args.enabled ? '已启用' : '已暂停',
              task: taskSummary(task),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'scheduled_task_run_now',
  '立即执行一次定时任务（不等到计划时间）',
  { task_id_or_name: z.string() },
  async (args) => {
    const task = await runTaskNow(args.task_id_or_name);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              ok: true,
              message: `已触发立即执行「${task.name}」`,
              task: taskSummary(task),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
