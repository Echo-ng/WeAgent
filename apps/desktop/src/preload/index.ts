import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentConfig,
  AppSettings,
  Conversation,
  GetMessagesOptions,
  GetMessagesResult,
  Message,
  OrchestratorConfig,
  SaveImageAttachmentInput,
  SavedImageAttachment,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  SendMessageOptions,
  StreamEvent,
  ToolApprovalRequest,
} from '@weagent/shared';

export interface WeAgentAPI {
  getSettings: () => Promise<AppSettings>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  checkClaude: () => Promise<{ ok: boolean; version?: string; error?: string }>;
  listConversations: () => Promise<Conversation[]>;
  createConversation: (title: string, cwd?: string) => Promise<Conversation>;
  deleteConversation: (conversationId: string) => Promise<boolean>;
  listScheduledTasks: () => Promise<ScheduledTask[]>;
  saveScheduledTask: (input: ScheduledTaskInput) => Promise<ScheduledTask>;
  deleteScheduledTask: (taskId: string) => Promise<boolean>;
  setScheduledTaskEnabled: (taskId: string, enabled: boolean) => Promise<ScheduledTask | null>;
  runScheduledTaskNow: (taskId: string) => Promise<ScheduledTaskRun | null>;
  listScheduledTaskRuns: (taskId: string, limit?: number) => Promise<ScheduledTaskRun[]>;
  syncClaudeScheduledTasks: () => Promise<{ imported: number; updated: number; files: string[] }>;
  getMessages: (conversationId: string, options?: GetMessagesOptions) => Promise<GetMessagesResult>;
  sendMessage: (
    conversationId: string,
    text: string,
    opts?: SendMessageOptions,
  ) => Promise<GetMessagesResult>;
  saveImageAttachment: (
    conversationId: string,
    input: SaveImageAttachmentInput,
  ) => Promise<SavedImageAttachment>;
  readAttachmentImage: (filePath: string) => Promise<string>;
  listAgents: () => Promise<AgentConfig[]>;
  saveAgent: (agent: AgentConfig) => Promise<AgentConfig>;
  deleteAgent: (id: string) => Promise<boolean>;
  getOrchestratorConfig: () => Promise<OrchestratorConfig>;
  setOrcchestratorConfig: (config: OrchestratorConfig) => Promise<OrchestratorConfig>;
  listApprovals: () => Promise<ToolApprovalRequest[]>;
  resolveApproval: (requestId: string, decision: 'approve' | 'deny') => Promise<boolean>;
  wechatStatus: () => Promise<{ loggedIn: boolean; listening: boolean }>;
  wechatGetQrCode: () => Promise<{
    qrcode: string;
    qrcodeImageContent?: string;
    qrcodeImageUrl?: string;
  }>;
  wechatPollQrStatus: (qrcode: string) => Promise<{
    status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';
    token?: string;
    botId?: string;
  }>;
  wechatStart: () => Promise<{ ok: boolean; listening: boolean }>;
  wechatStop: () => Promise<{ ok: boolean; listening: boolean }>;
  onStreamEvent: (callback: (event: StreamEvent) => void) => () => void;
  onTasksChanged: (callback: () => void) => () => void;
}

const api: WeAgentAPI = {
  getSettings: () => ipcRenderer.invoke('app:getSettings'),
  updateSettings: (patch) => ipcRenderer.invoke('app:updateSettings', patch),
  checkClaude: () => ipcRenderer.invoke('claude:check'),
  listConversations: () => ipcRenderer.invoke('conversations:list'),
  createConversation: (title, cwd) => ipcRenderer.invoke('conversations:create', title, cwd),
  deleteConversation: (id) => ipcRenderer.invoke('conversations:delete', id),
  listScheduledTasks: () => ipcRenderer.invoke('tasks:list'),
  saveScheduledTask: (input) => ipcRenderer.invoke('tasks:save', input),
  deleteScheduledTask: (id) => ipcRenderer.invoke('tasks:delete', id),
  setScheduledTaskEnabled: (id, enabled) => ipcRenderer.invoke('tasks:toggle', id, enabled),
  runScheduledTaskNow: (id) => ipcRenderer.invoke('tasks:runNow', id),
  listScheduledTaskRuns: (id, limit) => ipcRenderer.invoke('tasks:runs', id, limit),
  syncClaudeScheduledTasks: () => ipcRenderer.invoke('tasks:syncClaude'),
  getMessages: (id, options) => ipcRenderer.invoke('conversations:messages', id, options),
  sendMessage: (id, text, opts) => ipcRenderer.invoke('conversations:send', id, text, opts),
  saveImageAttachment: (id, input) => ipcRenderer.invoke('attachments:saveImage', id, input),
  readAttachmentImage: (filePath) => ipcRenderer.invoke('attachments:readImage', filePath),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  saveAgent: (agent) => ipcRenderer.invoke('agents:save', agent),
  deleteAgent: (id) => ipcRenderer.invoke('agents:delete', id),
  getOrchestratorConfig: () => ipcRenderer.invoke('orchestrator:get'),
  setOrcchestratorConfig: (config) => ipcRenderer.invoke('orchestrator:set', config),
  listApprovals: () => ipcRenderer.invoke('approvals:list'),
  resolveApproval: (id, decision) => ipcRenderer.invoke('approvals:resolve', id, decision),
  wechatStatus: () => ipcRenderer.invoke('wechat:status'),
  wechatGetQrCode: () => ipcRenderer.invoke('wechat:getQrCode'),
  wechatPollQrStatus: (qrcode) => ipcRenderer.invoke('wechat:pollQrStatus', qrcode),
  wechatStart: () => ipcRenderer.invoke('wechat:start'),
  wechatStop: () => ipcRenderer.invoke('wechat:stop'),
  onStreamEvent: (callback) => {
    const handler = (_event: unknown, streamEvent: StreamEvent) => callback(streamEvent);
    ipcRenderer.on('stream:event', handler);
    return () => ipcRenderer.removeListener('stream:event', handler);
  },
  onTasksChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('tasks:changed', handler);
    return () => ipcRenderer.removeListener('tasks:changed', handler);
  },
};

contextBridge.exposeInMainWorld('weagent', api);

declare global {
  interface Window {
    weagent: WeAgentAPI;
  }
}
