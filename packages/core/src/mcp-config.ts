import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

export interface WeAgentMcpConfigOptions {
  dataDir: string;
  serverScriptPath: string;
  taskApiUrl: string;
  taskApiToken: string;
}

export function resolveMcpRunnerCommand(): { command: string; extraEnv: Record<string, string> } {
  if (process.versions.electron) {
    return {
      command: process.execPath,
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return { command: process.execPath, extraEnv: {} };
}

export function writeWeAgentMcpConfig(options: WeAgentMcpConfigOptions): string {
  const configPath = join(options.dataDir, 'weagent-mcp.json');
  const runner = resolveMcpRunnerCommand();
  const config = {
    mcpServers: {
      weagent: {
        type: 'stdio',
        command: runner.command,
        args: [options.serverScriptPath],
        env: {
          WEAGENT_DATA_DIR: options.dataDir,
          WEAGENT_TASK_API: options.taskApiUrl,
          WEAGENT_TASK_API_TOKEN: options.taskApiToken,
          ...runner.extraEnv,
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return configPath;
}
