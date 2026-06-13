import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import type {
  WeChatCredentials,
  WeChatIncomingMessage,
  WeChatQrCodeResult,
  WeChatQrPollResult,
} from '@weagent/shared';

export interface WeChatChannelAdapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(toUserId: string, text: string, contextToken: string): Promise<void>;
  sendTyping?(toUserId: string, contextToken: string): Promise<void>;
}

const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const MESSAGE_ITEM_TEXT = 1;
const CHANNEL_VERSION = '1.0.3';
const QR_POLL_TIMEOUT_MS = 35_000;

export interface WeChatAdapterOptions {
  credentialsPath: string;
  baseUrl?: string;
  onMessage: (msg: WeChatIncomingMessage) => Promise<void>;
}

export class WeChatILinkAdapter implements WeChatChannelAdapter {
  name = 'wechat';
  private token: string | null = null;
  private baseUrl: string;
  private polling = false;
  private pollAbort?: AbortController;
  private getUpdatesBuf = '';
  private processedMessageIds = new Set<string>();
  private static readonly MAX_PROCESSED_IDS = 2000;

  constructor(private options: WeChatAdapterOptions) {
    this.baseUrl = options.baseUrl ?? 'https://ilinkai.weixin.qq.com';
    this.loadCredentials();
  }

  private loadCredentials(): void {
    if (existsSync(this.options.credentialsPath)) {
      try {
        const creds = JSON.parse(
          readFileSync(this.options.credentialsPath, 'utf-8'),
        ) as WeChatCredentials;
        this.token = creds.token;
        if (creds.baseUrl) this.baseUrl = creds.baseUrl;
        if (creds.getUpdatesBuf) this.getUpdatesBuf = creds.getUpdatesBuf;
      } catch {
        // ignore
      }
    }
  }

  saveCredentials(creds: WeChatCredentials): void {
    const payload: WeChatCredentials = {
      ...creds,
      getUpdatesBuf: this.getUpdatesBuf,
    };
    writeFileSync(this.options.credentialsPath, JSON.stringify(payload, null, 2), 'utf-8');
    this.token = creds.token;
    if (creds.baseUrl) this.baseUrl = creds.baseUrl;
  }

  private persistCursor(): void {
    if (!this.token || !existsSync(this.options.credentialsPath)) return;
    try {
      const creds = JSON.parse(
        readFileSync(this.options.credentialsPath, 'utf-8'),
      ) as WeChatCredentials;
      creds.getUpdatesBuf = this.getUpdatesBuf;
      writeFileSync(this.options.credentialsPath, JSON.stringify(creds, null, 2), 'utf-8');
    } catch {
      // ignore
    }
  }

  private rememberMessageId(messageId: string): boolean {
    if (!messageId || this.processedMessageIds.has(messageId)) return false;
    this.processedMessageIds.add(messageId);
    if (this.processedMessageIds.size > WeChatILinkAdapter.MAX_PROCESSED_IDS) {
      const drop = this.processedMessageIds.values().next().value;
      if (drop) this.processedMessageIds.delete(drop);
    }
    return true;
  }

  isLoggedIn(): boolean {
    return !!this.token;
  }

  isListening(): boolean {
    return this.polling;
  }

  async getQrCode(): Promise<WeChatQrCodeResult> {
    const res = await this.apiGet('ilink/bot/get_bot_qrcode?bot_type=3', { qrLogin: true });
    const data = unwrapPayload(res);

    const qrcode = String(
      data.qrcode ?? data.qr_code ?? data.qrcode_id ?? '',
    );
    const qrcodeImageContent = pickString(
      data.qrcode_img_content,
      data.qrcodeImgContent,
      data.qrcode_image,
    );
    const qrcodeImageUrl = pickString(
      data.qrcode_img_url,
      data.qrcode_url,
      data.qrcodeUrl,
      data.url,
    );

    if (!qrcode) {
      throw new Error(`获取二维码失败：响应缺少 qrcode 字段 (${JSON.stringify(res).slice(0, 200)})`);
    }

    const scanUrl = pickScanUrl(qrcode, qrcodeImageContent, qrcodeImageUrl);
    let renderedImageContent = qrcodeImageContent;

    if (scanUrl) {
      renderedImageContent = await QRCode.toDataURL(scanUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 280,
        color: { dark: '#000000', light: '#FFFFFF' },
      });
    } else if (qrcodeImageContent && !qrcodeImageContent.startsWith('data:')) {
      if (looksLikeBase64(qrcodeImageContent)) {
        renderedImageContent = `data:image/png;base64,${qrcodeImageContent.replace(/\s/g, '')}`;
      }
    }

    return {
      qrcode,
      qrcodeImageContent: renderedImageContent,
      qrcodeImageUrl: scanUrl ?? qrcodeImageUrl,
    };
  }

  async pollQrCodeStatus(qrcode: string): Promise<WeChatQrPollResult> {
    const res = await this.apiGet(
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      { qrLogin: true, longPoll: true },
    );
    const data = unwrapPayload(res);
    const status = normalizeQrStatus(data.status ?? data.qrcode_status);

    if (status === 'confirmed') {
      const token = String(
        data.bot_token ?? data.token ?? data.access_token ?? '',
      );
      const baseurl = String(data.baseurl ?? data.base_url ?? this.baseUrl);
      const botId = String(data.ilink_bot_id ?? data.bot_id ?? '');

      if (token) {
        this.saveCredentials({
          token,
          baseUrl: baseurl || this.baseUrl,
          botId: botId || undefined,
        });
      }
      return { status: 'confirmed', token: token || undefined, botId: botId || undefined };
    }

    return { status };
  }

  async start(): Promise<void> {
    if (!this.token || this.polling) return;
    this.polling = true;
    this.pollAbort = new AbortController();
    void this.pollLoop(this.pollAbort.signal);
  }

  async stop(): Promise<void> {
    this.polling = false;
    this.pollAbort?.abort();
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (this.polling && !signal.aborted) {
      try {
        const res = await this.apiPost(
          'ilink/bot/getupdates',
          {
            get_updates_buf: this.getUpdatesBuf,
            base_info: { channel_version: CHANNEL_VERSION },
          },
          { longPoll: true },
        );
        const data = unwrapPayload(res);
        if (data.get_updates_buf) {
          this.getUpdatesBuf = String(data.get_updates_buf);
          this.persistCursor();
        }

        const updates = (data.msgs ?? data.updates ?? data.msg_list ?? []) as unknown[];
        for (const update of updates) {
          const msg = this.parseIncomingMessage(update);
          if (msg && this.rememberMessageId(msg.messageId)) {
            await this.options.onMessage(msg);
          }
        }
      } catch {
        if (signal.aborted) break;
        await sleep(3000);
      }
    }
  }

  private parseIncomingMessage(raw: unknown): WeChatIncomingMessage | null {
    const obj = raw as Record<string, unknown>;
    const msg = (obj.msg ?? obj) as Record<string, unknown>;

    if (Number(msg.message_type) === MESSAGE_TYPE_BOT) return null;

    const fromUserId = String(msg.from_user_id ?? msg.fromUserId ?? '');
    if (!fromUserId) return null;

    const itemList = (msg.item_list ?? msg.itemList ?? []) as Array<Record<string, unknown>>;
    const textItem = itemList.find((i) => Number(i.type) === MESSAGE_ITEM_TEXT || i.text_item);
    const textObj = (textItem?.text_item ?? textItem) as Record<string, unknown> | undefined;
    const text = String(textObj?.text ?? textObj?.content ?? msg.content ?? '');

    if (!text) return null;

    return {
      fromUserId,
      text,
      contextToken: String(msg.context_token ?? msg.contextToken ?? ''),
      messageId: String(msg.client_id ?? msg.message_id ?? uuidv4()),
      raw,
    };
  }

  async sendMessage(toUserId: string, text: string, contextToken: string): Promise<void> {
    if (!this.token) throw new Error('WeChat not logged in');

    await this.apiPost('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: uuidv4(),
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        item_list: [
          {
            type: MESSAGE_ITEM_TEXT,
            text_item: { text },
          },
        ],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    });
  }

  async sendTyping(toUserId: string, contextToken: string): Promise<void> {
    if (!this.token) return;
    try {
      const config = await this.apiPost('ilink/bot/getconfig', {
        ilink_user_id: toUserId,
        context_token: contextToken,
        base_info: { channel_version: CHANNEL_VERSION },
      });
      const data = unwrapPayload(config);
      const typingTicket = String(data.typing_ticket ?? '');
      if (!typingTicket) return;

      await this.apiPost('ilink/bot/sendtyping', {
        ilink_user_id: toUserId,
        context_token: contextToken,
        typing_ticket: typingTicket,
        status: 1,
        base_info: { channel_version: CHANNEL_VERSION },
      });
    } catch {
      // typing is best-effort
    }
  }

  private async apiGet(
    path: string,
    opts?: { qrLogin?: boolean; longPoll?: boolean },
  ): Promise<Record<string, unknown>> {
    const url = `${normalizeBaseUrl(this.baseUrl)}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };

    if (opts?.qrLogin) {
      headers['iLink-App-ClientVersion'] = '1';
    } else {
      Object.assign(headers, buildAuthHeaders(this.token, ''));
    }

    const controller = new AbortController();
    const timeout = opts?.longPoll ? QR_POLL_TIMEOUT_MS : 15_000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`WeChat API GET ${path} failed: ${res.status} ${errText}`);
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      if (opts?.longPoll && err instanceof Error && err.name === 'AbortError') {
        return { status: 'wait' };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async apiPost(
    path: string,
    body: Record<string, unknown>,
    opts?: { longPoll?: boolean },
  ): Promise<Record<string, unknown>> {
    const url = `${normalizeBaseUrl(this.baseUrl)}${path}`;
    const bodyStr = JSON.stringify(body);
    const headers = buildAuthHeaders(this.token, bodyStr);

    const controller = new AbortController();
    const timeout = opts?.longPoll ? QR_POLL_TIMEOUT_MS : 15_000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`WeChat API POST ${path} failed: ${res.status} ${errText}`);
      }
      const json = (await res.json()) as Record<string, unknown>;
      const ret = Number(json.ret ?? json.errcode ?? 0);
      if (ret !== 0) {
        const errmsg = String(json.errmsg ?? json.errMsg ?? json.message ?? `错误码 ${ret}`);
        throw new Error(errmsg);
      }
      return json;
    } catch (err) {
      if (opts?.longPoll && err instanceof Error && err.name === 'AbortError') {
        return { ret: 0, msgs: [], get_updates_buf: this.getUpdatesBuf };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildAuthHeaders(token: string | null, bodyStr: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (bodyStr) {
    headers['Content-Length'] = String(Buffer.byteLength(bodyStr, 'utf-8'));
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function unwrapPayload(res: Record<string, unknown>): Record<string, unknown> {
  const nested = res.data ?? res.result;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return { ...res, ...(nested as Record<string, unknown>) };
  }
  return res;
}

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function normalizeQrStatus(raw: unknown): WeChatQrPollResult['status'] {
  if (typeof raw === 'string') {
    const s = raw.toLowerCase();
    if (s === 'confirmed') return 'confirmed';
    if (s === 'scaned' || s === 'scanned') return 'scanned';
    if (s === 'expired') return 'expired';
    if (s === 'wait' || s === 'waiting') return 'waiting';
    return 'error';
  }
  const n = Number(raw);
  if (n === 2) return 'confirmed';
  if (n === 1) return 'scanned';
  if (n === 3) return 'expired';
  if (n === 0) return 'waiting';
  return 'error';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 将 API 返回的图片字段转为可渲染的 img src */
export function resolveWeChatQrImageSrc(result: WeChatQrCodeResult): string | null {
  const content = result.qrcodeImageContent;
  if (!content) return null;
  if (content.startsWith('data:')) return content;
  if (isDirectImageUrl(content)) return content;
  if (looksLikeBase64(content)) {
    return `data:image/png;base64,${content.replace(/\s/g, '')}`;
  }
  return null;
}

function pickScanUrl(
  qrcode: string,
  qrcodeImageContent?: string,
  qrcodeImageUrl?: string,
): string | undefined {
  for (const candidate of [qrcodeImageContent, qrcodeImageUrl]) {
    if (candidate?.startsWith('http') && !isDirectImageUrl(candidate)) {
      return candidate;
    }
  }
  if (qrcode) {
    return `https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=${encodeURIComponent(qrcode)}&bot_type=3`;
  }
  return undefined;
}

function isDirectImageUrl(url: string): boolean {
  if (!url.startsWith('http')) return false;
  if (url.includes('liteapp.weixin.qq.com')) return false;
  return /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(url);
}

function looksLikeBase64(value: string): boolean {
  const clean = value.replace(/\s/g, '');
  return clean.length > 64 && /^[A-Za-z0-9+/=]+$/.test(clean);
}
