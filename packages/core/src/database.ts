import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { ChannelBinding, Conversation, GetMessagesOptions, GetMessagesResult, Message, ScheduledTask, ScheduledTaskRun, ScheduledTaskRunStatus } from '@weagent/shared';

const DEFAULT_MESSAGE_PAGE = 30;

export class DatabaseService {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'local',
        channel_peer_id TEXT,
        active_agent_id TEXT,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text',
        metadata TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      CREATE TABLE IF NOT EXISTS channel_bindings (
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        PRIMARY KEY (channel, peer_id),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
    `);

    try {
      this.db.exec(`ALTER TABLE channel_bindings ADD COLUMN last_context_token TEXT`);
    } catch {
      // column already exists
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule_kind TEXT NOT NULL,
        cron_expression TEXT,
        daily_time TEXT,
        interval_ms INTEGER,
        prompt TEXT NOT NULL,
        conversation_id TEXT,
        agent_id TEXT,
        cwd TEXT,
        last_run_at INTEGER,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        error TEXT,
        conversation_id TEXT,
        FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next ON scheduled_tasks(next_run_at);
      CREATE INDEX IF NOT EXISTS idx_task_runs_task ON scheduled_task_runs(task_id, started_at DESC);
    `);
    this.ensureColumn('conversations', 'claude_session_ready', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('scheduled_tasks', 'claude_native_id', 'TEXT');
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_claude_native ON scheduled_tasks(claude_native_id) WHERE claude_native_id IS NOT NULL`,
    );
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  createConversation(input: {
    title: string;
    channel: Conversation['channel'];
    channelPeerId?: string;
    cwd: string;
    activeAgentId?: string;
  }): Conversation {
    const now = Date.now();
    const conv: Conversation = {
      id: uuidv4(),
      title: input.title,
      channel: input.channel,
      channelPeerId: input.channelPeerId,
      activeAgentId: input.activeAgentId,
      cwd: input.cwd,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, channel, channel_peer_id, active_agent_id, cwd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conv.id,
        conv.title,
        conv.channel,
        conv.channelPeerId ?? null,
        conv.activeAgentId ?? null,
        conv.cwd,
        conv.createdAt,
        conv.updatedAt,
      );
    return conv;
  }

  updateConversation(id: string, patch: Partial<Conversation>): Conversation | null {
    const existing = this.getConversation(id);
    if (!existing) return null;
    const updated: Conversation = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE conversations SET title = ?, channel = ?, channel_peer_id = ?, active_agent_id = ?, cwd = ?, claude_session_ready = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        updated.title,
        updated.channel,
        updated.channelPeerId ?? null,
        updated.activeAgentId ?? null,
        updated.cwd,
        updated.claudeSessionReady ? 1 : 0,
        updated.updatedAt,
        id,
      );
    return updated;
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToConversation(row) : null;
  }

  listConversations(limit = 50): Conversation[] {
    const rows = this.db
      .prepare(`SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToConversation(r));
  }

  addMessage(input: Omit<Message, 'id' | 'createdAt'>): Message {
    const msg: Message = {
      ...input,
      id: uuidv4(),
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, content_type, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.conversationId,
        msg.role,
        msg.content,
        msg.contentType,
        msg.metadata ? JSON.stringify(msg.metadata) : null,
        msg.createdAt,
      );
    this.db
      .prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`)
      .run(Date.now(), msg.conversationId);
    return msg;
  }

  hasAssistantMessage(conversationId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'assistant' LIMIT 1`,
      )
      .get(conversationId);
    return row != null;
  }

  getMessages(conversationId: string, options?: GetMessagesOptions): GetMessagesResult {
    const limit = options?.limit ?? DEFAULT_MESSAGE_PAGE;
    let sql = `SELECT * FROM messages WHERE conversation_id = ?`;
    const params: (string | number)[] = [conversationId];
    if (options?.before != null) {
      sql += ` AND created_at < ?`;
      params.push(options.before);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit + 1);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      messages: page.map((r) => this.rowToMessage(r)).reverse(),
      hasMore,
    };
  }

  setBinding(binding: ChannelBinding): void {
    const existing = this.getBinding(binding.channel, binding.peerId);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO channel_bindings (channel, peer_id, conversation_id, last_context_token)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        binding.channel,
        binding.peerId,
        binding.conversationId,
        binding.lastContextToken ?? existing?.lastContextToken ?? null,
      );
  }

  updateBindingContextToken(channel: string, peerId: string, contextToken: string): void {
    const existing = this.getBinding(channel, peerId);
    if (!existing) return;
    this.db
      .prepare(
        `UPDATE channel_bindings SET last_context_token = ? WHERE channel = ? AND peer_id = ?`,
      )
      .run(contextToken, channel, peerId);
  }

  getBinding(channel: string, peerId: string): ChannelBinding | null {
    const row = this.db
      .prepare(`SELECT * FROM channel_bindings WHERE channel = ? AND peer_id = ?`)
      .get(channel, peerId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      channel: String(row.channel),
      peerId: String(row.peer_id),
      conversationId: String(row.conversation_id),
      lastContextToken: row.last_context_token ? String(row.last_context_token) : undefined,
    };
  }

  deleteConversation(id: string): boolean {
    const existing = this.getConversation(id);
    if (!existing) return false;

    const deleteMessages = this.db.prepare(`DELETE FROM messages WHERE conversation_id = ?`);
    const deleteBindings = this.db.prepare(`DELETE FROM channel_bindings WHERE conversation_id = ?`);
    const deleteConversation = this.db.prepare(`DELETE FROM conversations WHERE id = ?`);

    const tx = this.db.transaction(() => {
      deleteMessages.run(id);
      deleteBindings.run(id);
      deleteConversation.run(id);
    });
    tx();
    return true;
  }

  listScheduledTasks(): ScheduledTask[] {
    const rows = this.db
      .prepare(`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToScheduledTask(r));
  }

  getScheduledTask(id: string): ScheduledTask | null {
    const row = this.db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToScheduledTask(row) : null;
  }

  getScheduledTaskByClaudeNativeId(claudeNativeId: string): ScheduledTask | null {
    const row = this.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE claude_native_id = ?`)
      .get(claudeNativeId) as Record<string, unknown> | undefined;
    return row ? this.rowToScheduledTask(row) : null;
  }

  saveScheduledTask(input: Omit<ScheduledTask, 'createdAt' | 'updatedAt'> & { createdAt?: number }): ScheduledTask {
    const now = Date.now();
    const existing = input.id ? this.getScheduledTask(input.id) : null;
    const task: ScheduledTask = {
      id: input.id ?? uuidv4(),
      name: input.name,
      enabled: input.enabled,
      scheduleKind: input.scheduleKind,
      cronExpression: input.cronExpression,
      dailyTime: input.dailyTime,
      intervalMs: input.intervalMs,
      prompt: input.prompt,
      conversationId: input.conversationId,
      agentId: input.agentId,
      cwd: input.cwd,
      claudeNativeId: input.claudeNativeId,
      lastRunAt: input.lastRunAt,
      nextRunAt: input.nextRunAt,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    };

    if (existing) {
      this.db
        .prepare(
          `UPDATE scheduled_tasks SET
            name = ?, enabled = ?, schedule_kind = ?, cron_expression = ?, daily_time = ?,
            interval_ms = ?, prompt = ?, conversation_id = ?, agent_id = ?, cwd = ?,
            claude_native_id = ?, last_run_at = ?, next_run_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          task.name,
          task.enabled ? 1 : 0,
          task.scheduleKind,
          task.cronExpression ?? null,
          task.dailyTime ?? null,
          task.intervalMs ?? null,
          task.prompt,
          task.conversationId ?? null,
          task.agentId ?? null,
          task.cwd ?? null,
          task.claudeNativeId ?? null,
          task.lastRunAt ?? null,
          task.nextRunAt ?? null,
          task.updatedAt,
          task.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO scheduled_tasks (
            id, name, enabled, schedule_kind, cron_expression, daily_time, interval_ms,
            prompt, conversation_id, agent_id, cwd, claude_native_id, last_run_at, next_run_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.id,
          task.name,
          task.enabled ? 1 : 0,
          task.scheduleKind,
          task.cronExpression ?? null,
          task.dailyTime ?? null,
          task.intervalMs ?? null,
          task.prompt,
          task.conversationId ?? null,
          task.agentId ?? null,
          task.cwd ?? null,
          task.claudeNativeId ?? null,
          task.lastRunAt ?? null,
          task.nextRunAt ?? null,
          task.createdAt,
          task.updatedAt,
        );
    }
    return task;
  }

  deleteScheduledTask(id: string): boolean {
    const existing = this.getScheduledTask(id);
    if (!existing) return false;
    const delRuns = this.db.prepare(`DELETE FROM scheduled_task_runs WHERE task_id = ?`);
    const delTask = this.db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`);
    const tx = this.db.transaction(() => {
      delRuns.run(id);
      delTask.run(id);
    });
    tx();
    return true;
  }

  createScheduledTaskRun(input: {
    id: string;
    taskId: string;
    status: ScheduledTaskRunStatus;
    startedAt: number;
    conversationId?: string;
  }): ScheduledTaskRun {
    const run: ScheduledTaskRun = {
      id: input.id,
      taskId: input.taskId,
      status: input.status,
      startedAt: input.startedAt,
      conversationId: input.conversationId,
    };
    this.db
      .prepare(
        `INSERT INTO scheduled_task_runs (id, task_id, status, started_at, conversation_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.taskId, run.status, run.startedAt, run.conversationId ?? null);
    return run;
  }

  finishScheduledTaskRun(
    runId: string,
    patch: { status: ScheduledTaskRunStatus; finishedAt: number; error?: string },
  ): void {
    this.db
      .prepare(
        `UPDATE scheduled_task_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?`,
      )
      .run(patch.status, patch.finishedAt, patch.error ?? null, runId);
  }

  listScheduledTaskRuns(taskId: string, limit = 20): ScheduledTaskRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(taskId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToScheduledTaskRun(r));
  }

  listDueScheduledTasks(now = Date.now()): ScheduledTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(now) as Record<string, unknown>[];
    return rows.map((r) => this.rowToScheduledTask(r));
  }

  close(): void {
    this.db.close();
  }

  private rowToConversation(row: Record<string, unknown>): Conversation {
    return {
      id: String(row.id),
      title: String(row.title),
      channel: row.channel as Conversation['channel'],
      channelPeerId: row.channel_peer_id ? String(row.channel_peer_id) : undefined,
      activeAgentId: row.active_agent_id ? String(row.active_agent_id) : undefined,
      cwd: String(row.cwd),
      claudeSessionReady: Boolean(row.claude_session_ready),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToMessage(row: Record<string, unknown>): Message {
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      role: row.role as Message['role'],
      content: String(row.content),
      contentType: row.content_type as Message['contentType'],
      metadata: row.metadata ? (JSON.parse(String(row.metadata)) as Record<string, unknown>) : undefined,
      createdAt: Number(row.created_at),
    };
  }

  private rowToScheduledTask(row: Record<string, unknown>): ScheduledTask {
    return {
      id: String(row.id),
      name: String(row.name),
      enabled: Boolean(row.enabled),
      scheduleKind: row.schedule_kind as ScheduledTask['scheduleKind'],
      cronExpression: row.cron_expression ? String(row.cron_expression) : undefined,
      dailyTime: row.daily_time ? String(row.daily_time) : undefined,
      intervalMs: row.interval_ms != null ? Number(row.interval_ms) : undefined,
      prompt: String(row.prompt),
      conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
      agentId: row.agent_id ? String(row.agent_id) : undefined,
      cwd: row.cwd ? String(row.cwd) : undefined,
      claudeNativeId: row.claude_native_id ? String(row.claude_native_id) : undefined,
      lastRunAt: row.last_run_at != null ? Number(row.last_run_at) : undefined,
      nextRunAt: row.next_run_at != null ? Number(row.next_run_at) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToScheduledTaskRun(row: Record<string, unknown>): ScheduledTaskRun {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      status: row.status as ScheduledTaskRun['status'],
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at != null ? Number(row.finished_at) : undefined,
      error: row.error ? String(row.error) : undefined,
      conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
    };
  }
}
