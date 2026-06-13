import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { modelSupportsVision } from '@weagent/shared';

export interface ClaudeRuntimeInfo {
  settingsPath: string;
  effectiveModel?: string;
  baseUrl?: string;
  visionSupported: boolean;
  isThirdPartyRoute: boolean;
  source: 'env' | 'default';
}

export function readClaudeRuntimeInfo(customPath?: string): ClaudeRuntimeInfo {
  const settingsPath = customPath ?? join(homedir(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    return {
      settingsPath,
      visionSupported: true,
      isThirdPartyRoute: false,
      source: 'default',
    };
  }

  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      env?: Record<string, string>;
    };
    const env = raw.env ?? {};
    const effectiveModel =
      env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
      env.ANTHROPIC_MODEL ??
      env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    const baseUrl = env.ANTHROPIC_BASE_URL;
    const isThirdPartyRoute = Boolean(
      baseUrl && !/anthropic\.com/i.test(baseUrl),
    );

    return {
      settingsPath,
      effectiveModel,
      baseUrl,
      visionSupported: modelSupportsVision(effectiveModel),
      isThirdPartyRoute,
      source: effectiveModel ? 'env' : 'default',
    };
  } catch {
    return {
      settingsPath,
      visionSupported: true,
      isThirdPartyRoute: false,
      source: 'default',
    };
  }
}
