import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ScheduledTask } from '@weagent/shared';
import type { DatabaseService } from './database.js';
import { saveScheduledTaskRecord } from './scheduled-task-api.js';

export interface ClaudeNativeScheduledTask {
  id: string;
  cron: string;
  prompt: string;
  createdAt?: number;
  recurring?: boolean;
}

export interface ClaudeTaskSyncResult {
  imported: number;
  updated: number;
  files: string[];
}

function deriveTaskName(prompt: string, id: string): string {
  if (/周度投资报告/.test(prompt)) return '周度投资报告';
  if (/盘前/.test(prompt)) return '盘前策略';
  if (/收盘复盘/.test(prompt)) return '收盘复盘';
  const heading = prompt.match(/^#{1,3}\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim().slice(0, 48);
  const line = prompt.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (line) return line.slice(0, 48);
  return `Claude 定时 ${id}`;
}

export function collectClaudeScheduledTaskFiles(dirs: string[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const dir of dirs) {
    if (!dir?.trim()) continue;
    const path = join(dir, '.claude', 'scheduled_tasks.json');
    if (existsSync(path) && !seen.has(path)) {
      seen.add(path);
      files.push(path);
    }
  }
  return files;
}

export function parseClaudeScheduledTasksFile(filePath: string): ClaudeNativeScheduledTask[] {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as { tasks?: ClaudeNativeScheduledTask[] };
  return Array.isArray(raw.tasks) ? raw.tasks : [];
}

export function syncClaudeScheduledTasks(
  db: DatabaseService,
  searchDirs: string[],
): ClaudeTaskSyncResult {
  const files = collectClaudeScheduledTaskFiles(searchDirs);
  let imported = 0;
  let updated = 0;

  for (const filePath of files) {
    const cwd = dirname(dirname(filePath));
    let tasks: ClaudeNativeScheduledTask[];
    try {
      tasks = parseClaudeScheduledTasksFile(filePath);
    } catch {
      continue;
    }

    for (const native of tasks) {
      if (!native.id || !native.cron || !native.prompt?.trim()) continue;

      const existing = db.getScheduledTaskByClaudeNativeId(native.id);
      const name = deriveTaskName(native.prompt, native.id);
      const cron = native.cron.trim();
      const prompt = native.prompt.trim();

      if (
        existing &&
        existing.cronExpression === cron &&
        existing.prompt === prompt &&
        existing.name === name
      ) {
        continue;
      }

      saveScheduledTaskRecord(
        db,
        {
          id: existing?.id,
          name,
          enabled: true,
          scheduleKind: 'cron',
          cronExpression: cron,
          prompt,
          agentId: existing?.agentId ?? 'general',
          cwd: existing?.cwd ?? cwd,
          claudeNativeId: native.id,
          createdAt: native.createdAt,
        },
        existing,
      );

      if (existing) updated += 1;
      else imported += 1;
    }
  }

  return { imported, updated, files };
}

export class ClaudeTaskFileWatcher {
  private watchers: FSWatcher[] = [];

  start(
    searchDirs: string[],
    onChange: () => void,
  ): void {
    this.stop();
    for (const file of collectClaudeScheduledTaskFiles(searchDirs)) {
      try {
        const watcher = watch(file, () => onChange());
        this.watchers.push(watcher);
      } catch {
        // ignore watch failures
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}

export function describeClaudeNativeTask(task: ScheduledTask): string | null {
  if (!task.claudeNativeId) return null;
  return `已同步自 Claude Code (.claude/scheduled_tasks.json)`;
}
