import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentConfig } from '@weagent/shared';

const DEFAULT_AGENTS: AgentConfig[] = [
  {
    id: 'general',
    name: '通用助手',
    description: '通用对话与轻量任务',
    cwd: '',
    allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
    model: 'claude-sonnet-4-20250514',
  },
  {
    id: 'code-dev',
    name: '代码开发',
    description: '代码编写、重构与调试',
    systemPromptAppend: '你是资深软件工程师，专注于高质量代码实现。',
    cwd: '',
    allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash', 'WebFetch'],
    model: 'claude-sonnet-4-20250514',
  },
  {
    id: 'code-reviewer',
    name: '代码审查',
    description: '专注代码质量与安全审查',
    systemPromptAppend: '你是资深代码审查员，关注安全、性能与可维护性。',
    cwd: '',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git:*)'],
    model: 'claude-sonnet-4-20250514',
  },
];

export class AgentRegistry {
  private agents = new Map<string, AgentConfig>();
  private agentsDir: string;

  constructor(agentsDir: string) {
    this.agentsDir = agentsDir;
    if (!existsSync(agentsDir)) {
      mkdirSync(agentsDir, { recursive: true });
    }
    this.loadAll();
  }

  loadAll(): void {
    this.agents.clear();
    const files = readdirSync(this.agentsDir).filter(
      (f) => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'),
    );
    if (files.length === 0) {
      this.seedDefaults();
      return;
    }
    for (const file of files) {
      try {
        const content = readFileSync(join(this.agentsDir, file), 'utf-8');
        const agent = (
          file.endsWith('.json') ? JSON.parse(content) : parseYaml(content)
        ) as AgentConfig;
        if (agent.id) {
          this.agents.set(agent.id, agent);
        }
      } catch {
        // skip invalid files
      }
    }
  }

  private seedDefaults(): void {
    for (const agent of DEFAULT_AGENTS) {
      this.save(agent);
    }
  }

  list(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  get(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  save(agent: AgentConfig): void {
    this.agents.set(agent.id, agent);
    const path = join(this.agentsDir, `${agent.id}.yaml`);
    writeFileSync(path, stringifyYaml(agent), 'utf-8');
  }

  delete(id: string): boolean {
    if (!this.agents.has(id)) return false;
    this.agents.delete(id);
    const path = join(this.agentsDir, `${id}.yaml`);
    if (existsSync(path)) {
      writeFileSync(path, '', 'utf-8');
    }
    return true;
  }

  clone(id: string, newId: string): AgentConfig | null {
    const source = this.agents.get(id);
    if (!source) return null;
    const cloned: AgentConfig = {
      ...source,
      id: newId,
      name: `${source.name} (副本)`,
    };
    this.save(cloned);
    return cloned;
  }
}
