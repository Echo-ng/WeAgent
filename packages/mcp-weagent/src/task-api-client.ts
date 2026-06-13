import type { ScheduledTask, ScheduledTaskInput } from '@weagent/shared';

function getApiConfig(): { baseUrl: string; token: string } {
  const baseUrl = process.env.WEAGENT_TASK_API?.replace(/\/$/, '');
  const token = process.env.WEAGENT_TASK_API_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('WEAGENT_TASK_API / WEAGENT_TASK_API_TOKEN 未设置，无法操作定时任务');
  }
  return { baseUrl, token };
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { baseUrl, token } = getApiConfig();
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Weagent-Token': token,
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) {
    throw new Error(body.error ?? `请求失败 (${res.status})`);
  }
  return body;
}

export async function listTasks(): Promise<ScheduledTask[]> {
  const body = await apiRequest<{ tasks: ScheduledTask[] }>('/tasks');
  return body.tasks;
}

export async function createTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
  const body = await apiRequest<{ task: ScheduledTask }>('/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return body.task;
}

export async function findTask(taskIdOrName: string): Promise<ScheduledTask | null> {
  const { baseUrl, token } = getApiConfig();
  const res = await fetch(`${baseUrl}/tasks/find`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Weagent-Token': token,
    },
    body: JSON.stringify({ task_id_or_name: taskIdOrName }),
  });
  if (res.status === 404) return null;
  const body = (await res.json()) as { ok?: boolean; error?: string; task?: ScheduledTask };
  if (!res.ok || body.ok === false) {
    throw new Error(body.error ?? `请求失败 (${res.status})`);
  }
  return body.task ?? null;
}

export async function updateTask(
  taskIdOrName: string,
  patch: Partial<ScheduledTaskInput> & { enabled?: boolean },
): Promise<ScheduledTask> {
  const existing = await findTask(taskIdOrName);
  if (!existing) throw new Error('任务不存在');
  const body = await apiRequest<{ task: ScheduledTask }>(`/tasks/${encodeURIComponent(existing.id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return body.task;
}

export async function deleteTask(taskIdOrName: string): Promise<void> {
  const existing = await findTask(taskIdOrName);
  if (!existing) throw new Error('任务不存在');
  await apiRequest(`/tasks/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
}

export async function setTaskEnabled(taskIdOrName: string, enabled: boolean): Promise<ScheduledTask> {
  const existing = await findTask(taskIdOrName);
  if (!existing) throw new Error('任务不存在');
  const body = await apiRequest<{ task: ScheduledTask }>(
    `/tasks/${encodeURIComponent(existing.id)}/enabled`,
    {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    },
  );
  return body.task;
}

export async function runTaskNow(taskIdOrName: string): Promise<ScheduledTask> {
  const existing = await findTask(taskIdOrName);
  if (!existing) throw new Error('任务不存在');
  const body = await apiRequest<{ task: ScheduledTask }>(
    `/tasks/${encodeURIComponent(existing.id)}/run-now`,
    { method: 'POST', body: '{}' },
  );
  return body.task;
}
