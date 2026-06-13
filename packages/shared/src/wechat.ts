/** 微信单条文本消息建议上限（字符） */
export const WECHAT_TEXT_MAX_CHARS = 1800;

/** 合并 Claude 流式文本片段（增量 delta + 工具间隔后的新段落） */
export function mergeStreamText(prev: string, next: string): string {
  if (!next) return prev;
  if (!prev) return next;
  if (next.startsWith(prev)) return next;
  if (prev.startsWith(next)) return prev;
  if (prev.endsWith(next)) return prev;
  if (next.endsWith(prev)) return next;
  // 工具调用（如 TodoWrite）后的新段落与先前文本无包含关系，应拼接而非覆盖
  return `${prev}\n\n${next}`;
}

/** 将长文本按微信限制分片，优先在段落/换行/空格处截断 */
export function splitWeChatText(text: string, maxChars = WECHAT_TEXT_MAX_CHARS): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= maxChars) {
      chunks.push(rest);
      break;
    }
    const slice = rest.slice(0, maxChars);
    let cut = maxChars;
    for (const sep of ['\n\n', '\n', ' ']) {
      const idx = slice.lastIndexOf(sep);
      if (idx > maxChars * 0.4) {
        cut = idx + sep.length;
        break;
      }
    }
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return chunks.filter((c) => c.length > 0);
}

/** 构建 Claude 历史上下文，限制总长度避免 Windows 命令行上限 */
export function buildClaudeHistoryPrompt(
  messages: Array<{ role: string; content: string; contentType?: string }>,
  currentPrompt: string,
  maxChars = 6000,
): string {
  const prior = messages
    .slice(0, -1)
    .filter((m) => (m.contentType ?? 'text') === 'text' && m.content.trim());

  if (prior.length === 0) return currentPrompt;

  const header = '以下是本对话较早的消息（供上下文参考）：\n\n';
  const footer = `\n\n---\n\nUser: ${currentPrompt}`;
  let budget = maxChars - footer.length - header.length;
  if (budget <= 0) return currentPrompt;

  const lines: string[] = [];
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i]!;
    const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${truncateForHistory(m.content, 800)}`;
    if (line.length > budget) break;
    lines.unshift(line);
    budget -= line.length + 2;
  }

  if (lines.length === 0) return currentPrompt;
  return `${header}${lines.join('\n\n')}${footer}`;
}

function truncateForHistory(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}

/** 将 Windows GBK 乱码 stderr 转为可读中文（若适用） */
export function decodeProcessOutput(data: Uint8Array | string): string {
  if (typeof data === 'string') return data;
  const utf8 = new TextDecoder('utf-8').decode(data);
  if (!utf8.includes('\uFFFD') && !/[\u0080-\u009f]/.test(utf8)) return utf8;
  try {
    return new TextDecoder('gbk').decode(data);
  } catch {
    return utf8;
  }
}

/** 识别 CLI 层错误并返回友好中文 */
export function normalizeCliError(raw: string): string {
  const text = raw.trim();
  if (!text) return text;
  if (/命令行太/i.test(text) || /too long/i.test(text) || /input too long/i.test(text)) {
    return '消息或上下文过长，请发送 /new 开始新对话，或缩短问题后重试。';
  }
  if (/输入太/i.test(text)) {
    return '输入内容过长，请缩短消息后重试，或发送 /new 开始新对话。';
  }
  if (/already in use/i.test(text)) {
    return 'Claude 会话 ID 冲突（可能上次进程未退出）。正在自动续接；若仍失败请发送 /new 开始新对话。';
  }
  return text;
}

export function isSessionAlreadyInUse(text: string): boolean {
  return /already in use/i.test(text);
}
