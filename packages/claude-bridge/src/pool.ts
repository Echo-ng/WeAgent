import { spawn, exec, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StreamEvent } from '@weagent/shared';
import { decodeProcessOutput, isSessionAlreadyInUse, mergeStreamText, normalizeCliError } from '@weagent/shared';
import type {
  ApprovalDecision,
  ClaudeBridgeOptions,
  ClaudeSessionHandle,
  ToolApprovalHandler,
} from './types.js';
import { ConversationMutex } from './conversation-mutex.js';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

interface ActiveRun {
  proc: ChildProcess;
  aborted: boolean;
}

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) {
    try {
      proc.kill();
    } catch {
      // ignore
    }
    return;
  }
  if (process.platform === 'win32') {
    exec(`taskkill /PID ${proc.pid} /T /F`, { windowsHide: true }, () => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    });
  } else {
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 2000);
  }
}

export class ClaudeSessionPool {
  private sessions = new Map<string, ClaudeSessionHandle>();
  private approvalHandler?: ToolApprovalHandler;
  private conversationMutex = new ConversationMutex();
  private activeRuns = new Map<string, ActiveRun>();

  setApprovalHandler(handler: ToolApprovalHandler): void {
    this.approvalHandler = handler;
  }

  getOrCreate(sessionId: string, options: ClaudeBridgeOptions): ClaudeSessionHandle {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.options = { ...existing.options, ...options };
      return existing;
    }
    const handle: ClaudeSessionHandle = {
      sessionId,
      options,
      history: [],
    };
    this.sessions.set(sessionId, handle);
    return handle;
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  isQueryRunning(sessionId: string): boolean {
    return this.activeRuns.has(sessionId);
  }

  cancelQuery(sessionId: string): boolean {
    const active = this.activeRuns.get(sessionId);
    if (!active) return false;
    active.aborted = true;
    killProcessTree(active.proc);
    return true;
  }

  async *runQuery(
    sessionId: string,
    prompt: string,
    options: ClaudeBridgeOptions,
    channel: 'local' | 'remote' = 'local',
  ): AsyncGenerator<StreamEvent> {
    const release = await this.conversationMutex.acquire(sessionId);
    try {
      yield* this.runQueryUnlocked(sessionId, prompt, options, channel);
    } finally {
      release();
    }
  }

  private async *runQueryUnlocked(
    sessionId: string,
    prompt: string,
    options: ClaudeBridgeOptions,
    channel: 'local' | 'remote' = 'local',
  ): AsyncGenerator<StreamEvent> {
    const handle = this.getOrCreate(sessionId, options);
    handle.history.push({ role: 'user', content: prompt });

    let resumeSession =
      options.resumeSession ?? handle.claudeSessionEstablished ?? false;
    let effectivePrompt = prompt;

    yield {
      type: 'status',
      conversationId: sessionId,
      content: 'Germinating...',
      timestamp: Date.now(),
    };

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const allowedTools = this.resolveAllowedTools(options, channel);
        const args = this.buildCliArgs({ ...options, resumeSession }, allowedTools);

        let assistantText = '';
        let sessionNotFound = false;
        let sessionAlreadyInUse = false;
        let cancelled = false;

        for await (const chunk of this.spawnStream(effectivePrompt, args, options)) {
          if (chunk.metadata?.cancelled) {
            cancelled = true;
            yield chunk;
            break;
          }
          if (chunk.metadata?.sessionNotFound) {
            sessionNotFound = true;
            break;
          }
          if (chunk.metadata?.claudeSessionId) {
            handle.claudeSessionEstablished = true;
          }
          if (
            chunk.type === 'error' &&
            chunk.content &&
            isSessionAlreadyInUse(chunk.content)
          ) {
            sessionAlreadyInUse = true;
            break;
          }
          if (chunk.type === 'text' && chunk.content) {
            assistantText = mergeStreamText(assistantText, chunk.content);
          }
          if (chunk.type === 'approval_required' && this.approvalHandler) {
            const decision = await this.approvalHandler({
              sessionId,
              toolName: String(chunk.metadata?.toolName ?? 'unknown'),
              toolInput: (chunk.metadata?.toolInput as Record<string, unknown>) ?? {},
              channel,
            });
            if (decision === 'deny') {
              yield {
                type: 'error',
                conversationId: sessionId,
                content: `Tool ${chunk.metadata?.toolName} denied by user`,
                timestamp: Date.now(),
              };
              return;
            }
          }
          yield chunk;
        }

        if (cancelled) break;

        if (sessionAlreadyInUse && !resumeSession) {
          resumeSession = true;
          handle.claudeSessionEstablished = true;
          yield {
            type: 'status',
            conversationId: sessionId,
            content: '会话已存在，正在续接…',
            timestamp: Date.now(),
          };
          continue;
        }

        if (sessionAlreadyInUse) {
          yield {
            type: 'error',
            conversationId: sessionId,
            content:
              normalizeCliError('Session ID is already in use') +
              ' 请发送 /new 开始新对话。',
            timestamp: Date.now(),
          };
          return;
        }

        if (!sessionNotFound) {
          if (assistantText) {
            handle.history.push({ role: 'assistant', content: assistantText });
            handle.claudeSessionEstablished = true;
          }
          break;
        }

        resumeSession = false;
        handle.claudeSessionEstablished = false;
        effectivePrompt = options.fallbackPrompt ?? prompt;
        yield {
          type: 'status',
          conversationId: sessionId,
          content: '会话未找到，正在重建上下文…',
          timestamp: Date.now(),
        };
      }
    } catch (error) {
      yield {
        type: 'error',
        conversationId: sessionId,
        content: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
    }

    yield {
      type: 'done',
      conversationId: sessionId,
      timestamp: Date.now(),
    };
  }

  async runTask(
    prompt: string,
    options: ClaudeBridgeOptions,
    channel: 'local' | 'remote' = 'local',
  ): Promise<string> {
    const sessionId = randomUUID();
    let result = '';
    for await (const event of this.runQuery(sessionId, prompt, options, channel)) {
      if (event.type === 'text') {
        result += event.content ?? '';
      }
    }
    this.remove(sessionId);
    return result;
  }

  async checkClaudeAvailable(claudePath?: string): Promise<{ ok: boolean; version?: string; error?: string }> {
    return new Promise((resolve) => {
      const cmd = claudePath ?? 'claude';
      const proc = spawn(cmd, ['--version'], { shell: true, windowsHide: true });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true, version: stdout.trim() || stderr.trim() });
        } else {
          resolve({ ok: false, error: stderr.trim() || 'Claude Code CLI not found' });
        }
      });
      proc.on('error', (err) => {
        resolve({ ok: false, error: err.message });
      });
    });
  }

  private resolveAllowedTools(options: ClaudeBridgeOptions, channel: 'local' | 'remote'): string[] {
    if (options.allowedTools?.length) {
      return options.allowedTools;
    }
    if (channel === 'remote') {
      return READ_ONLY_TOOLS;
    }
    return ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch'];
  }

  private buildCliArgs(options: ClaudeBridgeOptions, allowedTools: string[]): string[] {
    const permissionMode = options.permissionMode ?? 'acceptEdits';
    const args = [
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      permissionMode,
      '--allowed-tools',
      ...allowedTools,
    ];

    if (options.bareMode) {
      args.push('--bare');
    } else {
      args.push('--setting-sources', options.settingSources ?? 'user,project,local');
    }

    if (options.cwd) {
      args.push('--add-dir', options.cwd);
    }
    if (options.images?.length) {
      const extraDirs = new Set(
        options.images.map((imagePath) => dirname(imagePath)).filter(Boolean),
      );
      for (const dir of extraDirs) {
        if (dir !== options.cwd) {
          args.push('--add-dir', dir);
        }
      }
    }
    if (options.model) {
      args.push('--model', options.model);
    }
    if (options.maxBudgetUsd != null) {
      args.push('--max-budget-usd', String(options.maxBudgetUsd));
    }
    if (options.maxTurns != null) {
      args.push('--max-turns', String(options.maxTurns));
    }
    if (options.systemPromptAppend) {
      args.push('--append-system-prompt', options.systemPromptAppend);
    }
    if (options.mcpConfig) {
      args.push('--mcp-config', options.mcpConfig);
    }
    args.push('--agent', options.cliAgent ?? 'general-purpose');
    if (options.sessionId) {
      if (options.resumeSession) {
        args.push('--resume', options.sessionId);
      } else {
        args.push('--session-id', options.sessionId);
      }
    }
    return args;
  }

  private async *spawnStream(
    prompt: string,
    args: string[],
    options: ClaudeBridgeOptions,
  ): AsyncGenerator<StreamEvent> {
    const cmd = options.claudePath ?? 'claude';
    const sessionId = options.sessionId ?? randomUUID();
    const images = options.images ?? [];
    // 始终经 stdin 传 prompt，避免 Windows shell 把 --allowed-tools 末位工具名
    //（如 WebSearch、Skill）误当成用户消息（lastPrompt: "Skill"）
    const spawnArgs = ['--print', ...args];
    if (images.length > 0) {
      spawnArgs.push('--input-format', 'stream-json');
    }

    const proc = spawn(cmd, spawnArgs, {
      cwd: options.cwd || process.cwd(),
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const active: ActiveRun = { proc, aborted: false };
    this.activeRuns.set(sessionId, active);
    const clearActive = () => {
      this.activeRuns.delete(sessionId);
    };

    if (proc.stdin) {
      const stdinPayload =
        images.length > 0
          ? buildStreamJsonUserInput(prompt, images)
          : prompt;
      proc.stdin.write(stdinPayload, 'utf8');
      proc.stdin.end();
    }

    let buffer = '';
    let stderrAll = '';
    let exitCode: number | null = null;
    let gotContent = false;

    const lineQueue: string[] = [];
    let resolveLine: ((value: string | null) => void) | null = null;

    if (!proc.stdout || !proc.stderr) {
      yield {
        type: 'error',
        conversationId: sessionId,
        content: 'Claude Code 进程启动失败',
        timestamp: Date.now(),
      };
      return;
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (resolveLine) {
          const r = resolveLine;
          resolveLine = null;
          r(line);
        } else {
          lineQueue.push(line);
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = decodeProcessOutput(chunk);
      stderrAll += text;
      const trimmed = text.trim();
      if (trimmed && !trimmed.includes('no stdin data received')) {
        const tipMatch = trimmed.match(/(?:^|\n)\s*(?:└\s*)?Tip:\s*(.+)/i);
        if (tipMatch) {
          lineQueue.push(
            JSON.stringify({ type: 'tip', content: tipMatch[1].trim() }),
          );
        } else if (!trimmed.startsWith('{')) {
          lineQueue.push(
            JSON.stringify({ type: 'stderr', content: normalizeCliError(trimmed) }),
          );
        }
      }
    });

    const getNextLine = (): Promise<string | null> =>
      new Promise((resolve) => {
        if (lineQueue.length > 0) {
          resolve(lineQueue.shift()!);
          return;
        }
        resolveLine = resolve;
      });

    let done = false;
    proc.on('close', (code) => {
      exitCode = code ?? 0;
      done = true;
      clearActive();
      if (resolveLine) {
        resolveLine(null);
        resolveLine = null;
      }
    });
    proc.on('error', () => {
      clearActive();
    });

    while (!done || lineQueue.length > 0 || buffer) {
      const line = await getNextLine();
      if (!line) {
        if (done) break;
        continue;
      }

      if (line.startsWith('{')) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const events = this.parseStreamJsonLine(parsed, sessionId);
          for (const event of events) {
            if (event.type === 'text' || event.type === 'error') gotContent = true;
            yield event;
          }
        } catch {
          yield {
            type: 'trace',
            conversationId: sessionId,
            content: line,
            timestamp: Date.now(),
          };
        }
      } else {
        try {
          const parsed = JSON.parse(line) as { type?: string; content?: string };
          if (parsed.type === 'tip' && parsed.content) {
            yield {
              type: 'tip',
              conversationId: sessionId,
              content: parsed.content,
              timestamp: Date.now(),
            };
          } else if (parsed.type === 'stderr') {
            yield {
              type: 'trace',
              conversationId: sessionId,
              content: parsed.content,
              timestamp: Date.now(),
            };
          }
        } catch {
          yield {
            type: 'text',
            conversationId: sessionId,
            content: line + '\n',
            timestamp: Date.now(),
          };
        }
      }
    }

    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer) as Record<string, unknown>;
        for (const event of this.parseStreamJsonLine(parsed, sessionId)) {
          if (event.type === 'text' || event.type === 'error') gotContent = true;
          yield event;
        }
      } catch {
        yield {
          type: 'text',
          conversationId: sessionId,
          content: buffer,
          timestamp: Date.now(),
        };
      }
    }

    if (active.aborted) {
      yield {
        type: 'error',
        conversationId: sessionId,
        content: '已停止生成',
        metadata: { cancelled: true },
        timestamp: Date.now(),
      };
      return;
    }

    if (exitCode !== null && exitCode !== 0 && !gotContent) {
      yield {
        type: 'error',
        conversationId: sessionId,
        content: normalizeCliError(stderrAll.trim()) || `Claude Code 退出码 ${exitCode}`,
        timestamp: Date.now(),
      };
    }
  }

  private parseStreamJsonLine(
    parsed: Record<string, unknown>,
    sessionId: string,
  ): StreamEvent[] {
    const ts = Date.now();
    const type = String(parsed.type ?? '');

    if (type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
      return [
        {
          type: 'trace',
          conversationId: sessionId,
          content: '',
          metadata: { claudeSessionId: parsed.session_id },
          timestamp: ts,
        },
      ];
    }

    if (type === 'stream_event' && parsed.event) {
      const event = parsed.event as Record<string, unknown>;
      const eventType = String(event.type ?? '');

      if (eventType === 'content_block_start') {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block && String(block.type ?? '') === 'tool_use') {
          return [
            this.toolCallEvent(
              sessionId,
              ts,
              String(block.name ?? 'tool'),
              block.input as Record<string, unknown> | undefined,
              String(block.id ?? ''),
            ),
          ];
        }
      }

      return [];
    }

    if (type === 'assistant' && parsed.message) {
      const msg = parsed.message as {
        content?: Array<Record<string, unknown>>;
      };
      const events: StreamEvent[] = [];
      for (const block of msg.content ?? []) {
        const blockType = String(block.type ?? '');
        if (blockType === 'thinking' && block.thinking) {
          events.push({
            type: 'thinking',
            conversationId: sessionId,
            content: String(block.thinking),
            timestamp: ts,
          });
        }
        if (blockType === 'text' && block.text) {
          events.push({
            type: 'text',
            conversationId: sessionId,
            content: String(block.text),
            timestamp: ts,
          });
        }
        if (blockType === 'tool_use') {
          events.push(
            this.toolCallEvent(
              sessionId,
              ts,
              String(block.name ?? 'tool'),
              block.input as Record<string, unknown> | undefined,
              String(block.id ?? ''),
            ),
          );
        }
      }
      if (events.length > 0) return events;
    }

    if (type === 'user' && parsed.message) {
      const msg = parsed.message as {
        content?: Array<Record<string, unknown>>;
      };
      const events: StreamEvent[] = [];
      for (const block of msg.content ?? []) {
        if (String(block.type ?? '') === 'tool_result') {
          events.push(
            this.toolResultEvent(
              sessionId,
              ts,
              String(block.content ?? ''),
              String(block.tool_use_id ?? ''),
              block.is_error === true,
            ),
          );
        }
      }
      if (events.length > 0) return events;
    }

    if (type === 'tool_use' || type === 'tool_result') {
      const toolName = String(
        (parsed.tool_name as string) ??
          ((parsed.message as Record<string, unknown>)?.name as string) ??
          'tool',
      );
      const toolInput =
        (parsed.input as Record<string, unknown> | undefined) ??
        (((parsed.message as Record<string, unknown>)?.input as Record<string, unknown> | undefined) ??
          undefined);
      const isWrite = ['Write', 'Edit', 'Bash', 'NotebookEdit'].some((t) =>
        toolName.startsWith(t),
      );
      if (isWrite && type === 'tool_use') {
        return [
          {
            type: 'approval_required',
            conversationId: sessionId,
            content: summarizeToolInput(toolName, toolInput),
            metadata: {
              toolName,
              toolInput: toolInput ?? parsed,
            },
            timestamp: ts,
          },
        ];
      }
      return [
        {
          type: 'tool_result',
          conversationId: sessionId,
          content: summarizeToolInput(toolName, toolInput),
          metadata: { toolName, toolInput },
          timestamp: ts,
        },
      ];
    }

    if (type === 'result') {
      const errors = parsed.errors as string[] | undefined;
      if (errors?.some((e) => /No conversation found/i.test(e))) {
        return [
          {
            type: 'error',
            conversationId: sessionId,
            content: errors.join('; '),
            metadata: { sessionNotFound: true },
            timestamp: ts,
          },
        ];
      }
      const isError = parsed.is_error === true || parsed.subtype === 'error';
      const result = String(parsed.result ?? parsed.error ?? '');
      if (isError && result) {
        return [
          {
            type: 'error',
            conversationId: sessionId,
            content: result,
            timestamp: ts,
          },
        ];
      }
      if (result) {
        return [
          {
            type: 'text',
            conversationId: sessionId,
            content: result,
            metadata: {
              final: true,
              claudeSessionId: parsed.session_id ?? parsed.sessionId,
            },
            timestamp: ts,
          },
        ];
      }
    }

    if (type === 'error') {
      return [
        {
          type: 'error',
          conversationId: sessionId,
          content: String(parsed.error ?? parsed.message ?? 'Unknown error'),
          timestamp: ts,
        },
      ];
    }

    return [
      {
        type: 'trace',
        conversationId: sessionId,
        content: JSON.stringify(parsed),
        timestamp: ts,
      },
    ];
  }

  private toolCallEvent(
    sessionId: string,
    ts: number,
    toolName: string,
    toolInput?: Record<string, unknown>,
    toolUseId?: string,
  ): StreamEvent {
    const isWrite = ['Write', 'Edit', 'Bash', 'NotebookEdit'].some((t) =>
      toolName.startsWith(t),
    );
    if (isWrite) {
      return {
        type: 'approval_required',
        conversationId: sessionId,
        content: summarizeToolInput(toolName, toolInput),
        metadata: { toolName, toolInput, toolUseId, phase: 'call' },
        timestamp: ts,
      };
    }
    return {
      type: 'tool_result',
      conversationId: sessionId,
      content: `→ ${summarizeToolInput(toolName, toolInput)}`,
      metadata: { toolName, toolInput, toolUseId, phase: 'call' },
      timestamp: ts,
    };
  }

  private toolResultEvent(
    sessionId: string,
    ts: number,
    content: string,
    toolUseId: string,
    isError: boolean,
  ): StreamEvent {
    const preview = content.length > 400 ? `${content.slice(0, 400)}…` : content;
    return {
      type: 'tool_result',
      conversationId: sessionId,
      content: `${isError ? '✗ ' : '← '}${preview}`,
      metadata: { toolUseId, phase: 'result', isError },
      timestamp: ts,
    };
  }
}

function mimeFromImagePath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/png';
  }
}

function buildStreamJsonUserInput(prompt: string, imagePaths: string[]): string {
  const content: Array<Record<string, unknown>> = [];
  for (const imagePath of imagePaths) {
    const data = readFileSync(imagePath).toString('base64');
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeFromImagePath(imagePath),
        data,
      },
    });
  }
  content.push({
    type: 'text',
    text: prompt.trim() || '请分析以上图片。',
  });
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
  })}\n`;
}

function summarizeToolInput(
  toolName: string,
  input?: Record<string, unknown>,
): string {
  if (!input) return toolName;
  if (input.file_path) return String(input.file_path);
  if (input.command) return String(input.command).slice(0, 120);
  if (input.pattern) return String(input.pattern);
  if (input.url) return String(input.url);
  return toolName;
}

export class ToolApprovalGate {
  private pending = new Map<
    string,
    {
      resolve: (decision: ApprovalDecision) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private timeoutMs: number) {}

  waitForApproval(requestId: string): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve('deny');
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
    });
  }

  resolve(requestId: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pending.resolve(decision);
    this.pending.delete(requestId);
    return true;
  }

  cancelAll(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve('deny');
    }
    this.pending.clear();
  }
}
