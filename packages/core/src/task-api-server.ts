import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { ScheduledTask, ScheduledTaskInput } from '@weagent/shared';

export interface TaskApiHandlers {
  listScheduledTasks: () => ScheduledTask[];
  saveScheduledTask: (input: ScheduledTaskInput) => ScheduledTask;
  deleteScheduledTask: (id: string) => boolean;
  setScheduledTaskEnabled: (id: string, enabled: boolean) => ScheduledTask | null;
  requestRunNow: (id: string) => ScheduledTask | null;
  findTask: (idOrName: string) => ScheduledTask | null;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

export class TaskApiServer {
  private server: http.Server | null = null;
  readonly token = randomBytes(16).toString('hex');
  private baseUrl = '';

  async start(handlers: TaskApiHandlers, host = '127.0.0.1'): Promise<string> {
    if (this.server) return this.baseUrl;

    this.server = http.createServer((req, res) => {
      void this.handle(req, res, handlers);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, host, () => resolve());
    });

    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    this.baseUrl = `http://${host}:${port}`;
    return this.baseUrl;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.baseUrl = '';
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handlers: TaskApiHandlers,
  ): Promise<void> {
    try {
      if (req.headers['x-weagent-token'] !== this.token) {
        json(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      const url = new URL(req.url ?? '/', this.baseUrl);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/health') {
        json(res, 200, { ok: true });
        return;
      }

      if (method === 'GET' && url.pathname === '/tasks') {
        json(res, 200, { ok: true, tasks: handlers.listScheduledTasks() });
        return;
      }

      if (method === 'POST' && url.pathname === '/tasks') {
        const body = JSON.parse(await readBody(req)) as ScheduledTaskInput;
        const task = handlers.saveScheduledTask(body);
        json(res, 200, { ok: true, task });
        return;
      }

      if (method === 'POST' && url.pathname === '/tasks/find') {
        const body = JSON.parse(await readBody(req)) as { task_id_or_name: string };
        const task = handlers.findTask(body.task_id_or_name);
        if (!task) {
          json(res, 404, { ok: false, error: '任务不存在' });
          return;
        }
        json(res, 200, { ok: true, task });
        return;
      }

      if (method === 'PATCH' && url.pathname.startsWith('/tasks/')) {
        const id = decodeURIComponent(url.pathname.slice('/tasks/'.length));
        const body = JSON.parse(await readBody(req)) as ScheduledTaskInput & { enabled?: boolean };
        const existing = handlers.findTask(id);
        if (!existing) {
          json(res, 404, { ok: false, error: '任务不存在' });
          return;
        }
        const task = handlers.saveScheduledTask({
          id: existing.id,
          name: body.name ?? existing.name,
          prompt: body.prompt ?? existing.prompt,
          scheduleKind: body.scheduleKind ?? existing.scheduleKind,
          dailyTime: body.dailyTime ?? existing.dailyTime,
          cronExpression: body.cronExpression ?? existing.cronExpression,
          intervalMs: body.intervalMs ?? existing.intervalMs,
          agentId: body.agentId ?? existing.agentId,
          cwd: body.cwd ?? existing.cwd,
          enabled: body.enabled ?? existing.enabled,
          conversationId: existing.conversationId,
        });
        json(res, 200, { ok: true, task });
        return;
      }

      if (method === 'POST' && url.pathname.startsWith('/tasks/') && url.pathname.endsWith('/enabled')) {
        const id = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/enabled'.length));
        const body = JSON.parse(await readBody(req)) as { enabled: boolean };
        const existing = handlers.findTask(id);
        if (!existing) {
          json(res, 404, { ok: false, error: '任务不存在' });
          return;
        }
        const task = handlers.setScheduledTaskEnabled(existing.id, body.enabled);
        json(res, 200, { ok: true, task });
        return;
      }

      if (method === 'POST' && url.pathname.startsWith('/tasks/') && url.pathname.endsWith('/run-now')) {
        const id = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/run-now'.length));
        const existing = handlers.findTask(id);
        if (!existing) {
          json(res, 404, { ok: false, error: '任务不存在' });
          return;
        }
        const task = handlers.requestRunNow(existing.id);
        json(res, 200, { ok: true, task });
        return;
      }

      if (method === 'DELETE' && url.pathname.startsWith('/tasks/')) {
        const id = decodeURIComponent(url.pathname.slice('/tasks/'.length));
        const existing = handlers.findTask(id);
        if (!existing) {
          json(res, 404, { ok: false, error: '任务不存在' });
          return;
        }
        handlers.deleteScheduledTask(existing.id);
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      json(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
