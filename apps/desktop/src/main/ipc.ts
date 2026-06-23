import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain } from 'electron';
import type { AppService } from '@weagent/core';
import type { WeChatILinkAdapter } from '@weagent/channels-wechat';
import type {
  AgentConfig,
  AppSettings,
  GetMessagesOptions,
  OrchestratorConfig,
  SaveImageAttachmentInput,
  ScheduledTaskInput,
  SendMessageOptions,
  StreamEvent,
} from '@weagent/shared';

function withTurnId(event: StreamEvent, turnId: string): StreamEvent {
  return {
    ...event,
    metadata: { ...event.metadata, turnId },
  };
}

export async function ensureWeChatListening(
  appService: AppService,
  wechatAdapter: WeChatILinkAdapter,
): Promise<boolean> {
  const settings = appService.getSettings();
  if (!wechatAdapter.isLoggedIn() || settings.wechatAutoListen === false) {
    return wechatAdapter.isListening();
  }
  if (!wechatAdapter.isListening()) {
    await wechatAdapter.start();
  }
  return wechatAdapter.isListening();
}

export function registerIpcHandlers(
  ipcMain: IpcMain,
  appService: AppService,
  wechatAdapter: WeChatILinkAdapter,
  getWindow: () => BrowserWindow | null,
): void {
  const emitEvents = async (
    conversationId: string,
    text: string,
    opts?: SendMessageOptions,
  ) => {
    const win = getWindow();
    const turnId = randomUUID();
    let turnStarted = false;
    for await (const event of appService.orchestrator.handleMessage(
      conversationId,
      text,
      'local',
      opts,
    )) {
      let payload = withTurnId(event, turnId);
      if (!turnStarted && event.type === 'status') {
        payload = {
          ...payload,
          metadata: { ...payload.metadata, kind: 'turn_start' },
        };
        turnStarted = true;
      }
      win?.webContents.send('stream:event', payload);
    }
    win?.webContents.send('tasks:changed');
  };

  ipcMain.handle('app:getSettings', () => appService.getSettings());

  ipcMain.handle('app:updateSettings', (_e, patch: Partial<AppSettings>) =>
    appService.updateSettings(patch),
  );

  ipcMain.handle('claude:check', () => appService.checkClaude());

  ipcMain.handle('conversations:list', () => appService.listConversations());

  ipcMain.handle('conversations:create', (_e, title: string, cwd?: string) =>
    appService.createConversation(title, cwd),
  );

  ipcMain.handle('conversations:delete', (_e, conversationId: string) =>
    appService.deleteConversation(conversationId),
  );

  ipcMain.handle('tasks:list', () => appService.listScheduledTasks());

  ipcMain.handle('tasks:save', (_e, input: ScheduledTaskInput) =>
    appService.saveScheduledTask(input),
  );

  ipcMain.handle('tasks:delete', (_e, taskId: string) => appService.deleteScheduledTask(taskId));

  ipcMain.handle('tasks:toggle', (_e, taskId: string, enabled: boolean) =>
    appService.setScheduledTaskEnabled(taskId, enabled),
  );

  ipcMain.handle('tasks:runNow', async (_e, taskId: string) => appService.runScheduledTaskNow(taskId));

  ipcMain.handle('tasks:runs', (_e, taskId: string, limit?: number) =>
    appService.listScheduledTaskRuns(taskId, limit),
  );

  ipcMain.handle('tasks:syncClaude', () => {
    const result = appService.syncClaudeNativeTasks();
    getWindow()?.webContents.send('tasks:changed');
    return result;
  });

  ipcMain.handle('conversations:messages', (_e, conversationId: string, options?: GetMessagesOptions) =>
    appService.getMessages(conversationId, options),
  );

  ipcMain.handle(
    'conversations:send',
    async (_e, conversationId: string, text: string, opts?: SendMessageOptions) => {
      await emitEvents(conversationId, text, opts);
      return appService.getMessages(conversationId);
    },
  );

  ipcMain.handle('conversations:cancel', (_e, conversationId: string) => {
    const ok = appService.cancelConversation(conversationId);
    if (ok) {
      getWindow()?.webContents.send('stream:event', {
        type: 'status',
        conversationId,
        content: '正在停止…',
        metadata: { kind: 'turn_cancelling' },
        timestamp: Date.now(),
      });
    }
    return { ok };
  });

  ipcMain.handle(
    'attachments:saveImage',
    (_e, conversationId: string, input: SaveImageAttachmentInput) =>
      appService.saveImageAttachment(conversationId, input),
  );

  ipcMain.handle('attachments:readImage', (_e, filePath: string) =>
    appService.readAttachmentImage(filePath),
  );

  ipcMain.handle('agents:list', () => appService.listAgents());

  ipcMain.handle('agents:save', (_e, agent: AgentConfig) => appService.saveAgent(agent));

  ipcMain.handle('agents:delete', (_e, id: string) => appService.deleteAgent(id));

  ipcMain.handle('orchestrator:get', () => appService.getOrchestratorConfig());

  ipcMain.handle('orchestrator:set', (_e, config: OrchestratorConfig) =>
    appService.setOrchestratorConfig(config),
  );

  ipcMain.handle('approvals:list', () => appService.listApprovals());

  ipcMain.handle('approvals:resolve', (_e, requestId: string, decision: 'approve' | 'deny') =>
    appService.resolveApproval(requestId, decision),
  );

  ipcMain.handle('wechat:status', () => ({
    loggedIn: wechatAdapter.isLoggedIn(),
    listening: wechatAdapter.isListening(),
  }));

  ipcMain.handle('wechat:getQrCode', () => wechatAdapter.getQrCode());

  ipcMain.handle('wechat:pollQrStatus', async (_e, qrcode: string) => {
    const result = await wechatAdapter.pollQrCodeStatus(qrcode);
    if (result.status === 'confirmed') {
      await ensureWeChatListening(appService, wechatAdapter);
    }
    return result;
  });

  ipcMain.handle('wechat:start', async () => {
    await wechatAdapter.start();
    return { ok: true, listening: wechatAdapter.isListening() };
  });

  ipcMain.handle('wechat:stop', async () => {
    await wechatAdapter.stop();
    return { ok: true, listening: wechatAdapter.isListening() };
  });

  appService.eventBus.subscribe((event) => {
    getWindow()?.webContents.send('stream:event', event);
  });
}
