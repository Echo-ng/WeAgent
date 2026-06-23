import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { join, normalize } from 'node:path';
import type { ScheduledTask } from '@weagent/shared';
import type { DatabaseService } from './database.js';
import { saveScheduledTaskRecord } from './scheduled-task-api.js';

export interface ClaudeNativeScheduledTask {
  id: string;
  cron: string;
  prompt: string;
  createdAt?: number;
  recurring?: boolean;
  agentId?: string;
}

export interface ClaudeTaskSyncResult {
  imported: number;
  updated: number;
  removed: number;
  files: string[];
}

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  'coverage',
]);

function scheduledTasksPath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'scheduled_tasks.json');
}

function deriveTaskName(prompt: string, id: string): string {
  if (/周度投资报告/.test(prompt)) return '周度投资报告';
  if (/盘前/.test(prompt)) return '盘前策略';
  if (/收盘复盘/.test(prompt)) return '收盘复盘';
  const heading = prompt.match(/^#{1,3}\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim().slice(0, 48);
  const line = prompt
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (line) return line.slice(0, 48);
  return `Claude 定时 ${id}`;
}

export function expandSearchDirs(dirs: string[]): string[] {
  const roots = new Set<string>();
  for (const dir of dirs) {
    const trimmed = dir?.trim();
    if (!trimmed) continue;
    try {
      roots.add(normalize(trimmed));
    } catch {
      roots.add(trimmed);
    }
  }
  return [...roots];
}

function discoverScheduledTaskFiles(
  dir: string,
  files: Set<string>,
  depth: number,
): void {
  if (depth < 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;

    const sub = join(dir, entry.name);
    const candidate = scheduledTasksPath(sub);
    if (existsSync(candidate)) {
      files.add(candidate);
    }
    if (depth > 0) {
      discoverScheduledTaskFiles(sub, files, depth - 1);
    }
  }
}

export function collectClaudeScheduledTaskFiles(dirs: string[]): string[] {
  const files = new Set<string>();

  for (const root of expandSearchDirs(dirs)) {
    const direct = scheduledTasksPath(root);
    if (existsSync(direct)) {
      files.add(direct);
    }
    discoverScheduledTaskFiles(root, files, 2);
  }

  return [...files];
}

export function parseClaudeScheduledTasksFile(filePath: string): ClaudeNativeScheduledTask[] {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as { tasks?: ClaudeNativeScheduledTask[] };
  return Array.isArray(raw.tasks) ? raw.tasks : [];
}

export function readClaudeScheduledTasksForCwd(cwd: string): ClaudeNativeScheduledTask[] {
  const path = scheduledTasksPath(cwd);
  if (!existsSync(path)) return [];
  try {
    return parseClaudeScheduledTasksFile(path);
  } catch {
    return [];
  }
}

export function writeClaudeScheduledTasksForCwd(
  cwd: string,
  tasks: ClaudeNativeScheduledTask[],
): void {
  const claudeDir = join(cwd, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const payload = {
    tasks: tasks.map(({ id, cron, prompt, createdAt, recurring, agentId }) => ({
      id,
      cron,
      prompt,
      createdAt: createdAt ?? Date.now(),
      ...(recurring ? { recurring: true } : {}),
      ...(agentId ? { agentId } : {}),
    })),
  };
  writeFileSync(scheduledTasksPath(cwd), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

export function dailyTimeToCron(dailyTime: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(dailyTime.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${minute} ${hour} * * *`;
}

export function taskToClaudeCron(task: Pick<ScheduledTask, 'scheduleKind' | 'cronExpression' | 'dailyTime'>): string | null {
  if (task.scheduleKind === 'cron' && task.cronExpression?.trim()) {
    return task.cronExpression.trim();
  }
  if (task.scheduleKind === 'daily' && task.dailyTime) {
    return dailyTimeToCron(task.dailyTime);
  }
  return null;
}

export function upsertWeAgentTaskInClaudeFile(task: ScheduledTask, cwd: string): string | null {
  const cron = taskToClaudeCron(task);
  if (!cron || !task.prompt.trim()) return null;

  const nativeId = task.claudeNativeId ?? randomBytes(4).toString('hex');
  const tasks = readClaudeScheduledTasksForCwd(cwd);
  const entry: ClaudeNativeScheduledTask = {
    id: nativeId,
    cron,
    prompt: task.prompt.trim(),
    createdAt: task.createdAt ?? Date.now(),
    recurring: true,
    ...(task.agentId ? { agentId: task.agentId } : {}),
  };

  const idx = tasks.findIndex((t) => t.id === nativeId);
  if (idx >= 0) tasks[idx] = entry;
  else tasks.push(entry);

  writeClaudeScheduledTasksForCwd(cwd, tasks);
  return nativeId;
}

export function removeWeAgentTaskFromClaudeFile(cwd: string, nativeId: string): boolean {
  const tasks = readClaudeScheduledTasksForCwd(cwd);
  const next = tasks.filter((t) => t.id !== nativeId);
  if (next.length === tasks.length) return false;
  writeClaudeScheduledTasksForCwd(cwd, next);
  return true;
}

export function syncClaudeScheduledTasks(
  db: DatabaseService,
  searchDirs: string[],
): ClaudeTaskSyncResult {
  const files = collectClaudeScheduledTaskFiles(searchDirs);
  let imported = 0;
  let updated = 0;
  let removed = 0;

  const seenNativeByCwd = new Map<string, Set<string>>();

  for (const filePath of files) {
    const cwd = join(filePath, '..', '..');
    const cwdKey = normalize(cwd);
    if (!seenNativeByCwd.has(cwdKey)) {
      seenNativeByCwd.set(cwdKey, new Set());
    }
    const seen = seenNativeByCwd.get(cwdKey)!;

    let tasks: ClaudeNativeScheduledTask[];
    try {
      tasks = parseClaudeScheduledTasksFile(filePath);
    } catch {
      continue;
    }

    for (const native of tasks) {
      if (!native.id || !native.cron || !native.prompt?.trim()) continue;
      seen.add(native.id);

      const existing = db.getScheduledTaskByClaudeNativeId(native.id);
      const name = deriveTaskName(native.prompt, native.id);
      const cron = native.cron.trim();
      const prompt = native.prompt.trim();

      if (
        existing &&
        existing.cronExpression === cron &&
        existing.prompt === prompt &&
        existing.name === name &&
        existing.cwd === cwdKey
      ) {
        continue;
      }

      saveScheduledTaskRecord(
        db,
        {
          id: existing?.id,
          name,
          enabled: existing?.enabled ?? true,
          scheduleKind: 'cron',
          cronExpression: cron,
          prompt,
          agentId: existing?.agentId ?? native.agentId ?? 'general',
          cwd: existing?.cwd ?? cwdKey,
          claudeNativeId: native.id,
          createdAt: native.createdAt,
        },
        existing,
      );

      if (existing) updated += 1;
      else imported += 1;
    }
  }

  for (const task of db.listScheduledTasks()) {
    if (!task.claudeNativeId || !task.cwd?.trim()) continue;
    const cwdKey = normalize(task.cwd.trim());
    const seen = seenNativeByCwd.get(cwdKey);
    if (!seen) continue;
    if (seen.has(task.claudeNativeId)) continue;

    saveScheduledTaskRecord(
      db,
      {
        id: task.id,
        name: task.name,
        enabled: false,
        scheduleKind: task.scheduleKind,
        cronExpression: task.cronExpression,
        dailyTime: task.dailyTime,
        intervalMs: task.intervalMs,
        prompt: task.prompt,
        conversationId: task.conversationId,
        agentId: task.agentId,
        cwd: task.cwd,
        claudeNativeId: task.claudeNativeId,
        createdAt: task.createdAt,
      },
      task,
    );
    removed += 1;
  }

  return { imported, updated, removed, files };
}

export class ClaudeTaskFileWatcher {
  private watchers: FSWatcher[] = [];

  start(searchDirs: string[], onChange: () => void): void {
    this.stop();

    const watchedDirs = new Set<string>();
    for (const file of collectClaudeScheduledTaskFiles(searchDirs)) {
      try {
        this.watchers.push(watch(file, () => onChange()));
      } catch {
        // ignore watch failures
      }
      watchedDirs.add(normalize(join(file, '..', '..')));
    }

    for (const root of expandSearchDirs(searchDirs)) {
      const claudeDir = join(root, '.claude');
      if (!existsSync(claudeDir)) continue;
      try {
        this.watchers.push(
          watch(claudeDir, (_event, filename) => {
            if (!filename || filename === 'scheduled_tasks.json') onChange();
          }),
        );
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
