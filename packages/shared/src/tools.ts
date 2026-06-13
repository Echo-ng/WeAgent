export type ToolRisk = 'read' | 'write' | 'execute' | 'network';

export type ToolCategory = 'file' | 'search' | 'shell' | 'web' | 'agent' | 'other';

export interface ClaudeToolOption {
  id: string;
  label: string;
  description: string;
  risk: ToolRisk;
  category: ToolCategory;
}

export const TOOL_CATEGORY_LABELS: Record<ToolCategory, string> = {
  file: '文件',
  search: '搜索',
  shell: 'Shell',
  web: '网络',
  agent: 'Agent',
  other: '其他',
};

export const TOOL_RISK_LABELS: Record<ToolRisk, string> = {
  read: '只读',
  write: '写入',
  execute: '执行',
  network: '网络',
};

/** Claude Code 内置工具目录（用于 Agent 配置 UI） */
export const CLAUDE_TOOL_CATALOG: ClaudeToolOption[] = [
  {
    id: 'Read',
    label: 'Read',
    description: '读取文件内容',
    risk: 'read',
    category: 'file',
  },
  {
    id: 'Write',
    label: 'Write',
    description: '创建或覆盖文件',
    risk: 'write',
    category: 'file',
  },
  {
    id: 'Edit',
    label: 'Edit',
    description: '按片段编辑文件',
    risk: 'write',
    category: 'file',
  },
  {
    id: 'NotebookEdit',
    label: 'NotebookEdit',
    description: '编辑 Jupyter Notebook',
    risk: 'write',
    category: 'file',
  },
  {
    id: 'Grep',
    label: 'Grep',
    description: '在代码库中搜索文本',
    risk: 'read',
    category: 'search',
  },
  {
    id: 'Glob',
    label: 'Glob',
    description: '按模式匹配文件路径',
    risk: 'read',
    category: 'search',
  },
  {
    id: 'Bash',
    label: 'Bash',
    description: '运行 Shell 命令（无限制）',
    risk: 'execute',
    category: 'shell',
  },
  {
    id: 'Bash(git:*)',
    label: 'Bash (git)',
    description: '仅允许 Git 相关命令',
    risk: 'execute',
    category: 'shell',
  },
  {
    id: 'Bash(npm:*)',
    label: 'Bash (npm)',
    description: '仅允许 npm 相关命令',
    risk: 'execute',
    category: 'shell',
  },
  {
    id: 'Bash(pnpm:*)',
    label: 'Bash (pnpm)',
    description: '仅允许 pnpm 相关命令',
    risk: 'execute',
    category: 'shell',
  },
  {
    id: 'WebFetch',
    label: 'WebFetch',
    description: '抓取网页内容',
    risk: 'network',
    category: 'web',
  },
  {
    id: 'WebSearch',
    label: 'WebSearch',
    description: '搜索互联网',
    risk: 'network',
    category: 'web',
  },
  {
    id: 'Task',
    label: 'Task',
    description: '启动子 Agent 任务',
    risk: 'execute',
    category: 'agent',
  },
  {
    id: 'TodoWrite',
    label: 'TodoWrite',
    description: '维护任务待办列表',
    risk: 'write',
    category: 'other',
  },
];

export const ALL_CATALOG_TOOL_IDS = CLAUDE_TOOL_CATALOG.map((t) => t.id);

const CATALOG_ID_SET = new Set(ALL_CATALOG_TOOL_IDS);

/** 兼容旧配置里的 Bash(git *) 等写法 */
const LEGACY_TOOL_ALIASES: Record<string, string> = {
  'Bash(git *)': 'Bash(git:*)',
  'Bash(npm *)': 'Bash(npm:*)',
  'Bash(pnpm *)': 'Bash(pnpm:*)',
};

export function normalizeToolId(id: string): string {
  return LEGACY_TOOL_ALIASES[id] ?? id;
}

export function normalizeToolIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const id = normalizeToolId(raw.trim());
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function splitKnownAndCustomTools(selected: string[]): {
  known: string[];
  custom: string[];
} {
  const normalized = normalizeToolIds(selected);
  const known: string[] = [];
  const custom: string[] = [];
  for (const id of normalized) {
    if (CATALOG_ID_SET.has(id)) known.push(id);
    else custom.push(id);
  }
  return { known, custom };
}

export const TOOL_PRESETS = {
  readonly: {
    label: '仅只读',
    tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  },
  dev: {
    label: '开发默认',
    tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch'],
  },
  review: {
    label: '代码审查',
    tools: ['Read', 'Grep', 'Glob', 'Bash(git:*)'],
  },
  all: {
    label: '全部',
    tools: [...ALL_CATALOG_TOOL_IDS.filter((id) => id === 'Bash' || !id.startsWith('Bash('))],
  },
} as const;

export function toolsByCategory(): Record<ToolCategory, ClaudeToolOption[]> {
  const grouped = {} as Record<ToolCategory, ClaudeToolOption[]>;
  for (const tool of CLAUDE_TOOL_CATALOG) {
    grouped[tool.category] ??= [];
    grouped[tool.category].push(tool);
  }
  return grouped;
}

export function toggleToolSelection(selected: string[], toolId: string): string[] {
  const id = normalizeToolId(toolId);
  const set = new Set(normalizeToolIds(selected));

  if (set.has(id)) {
    set.delete(id);
    return Array.from(set);
  }

  if (id === 'Bash') {
    for (const other of set) {
      if (other.startsWith('Bash(')) set.delete(other);
    }
  } else if (id.startsWith('Bash(')) {
    set.delete('Bash');
  }

  set.add(id);
  return Array.from(set);
}
