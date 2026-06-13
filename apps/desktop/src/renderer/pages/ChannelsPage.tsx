import { useCallback, useEffect, useState } from 'react';
import type { Conversation, Message } from '@weagent/shared';
import { MarkdownContent } from '../components/MarkdownContent';

interface Props {
  conversations: Conversation[];
  onRefresh: () => Promise<void>;
  onOpenConversation: (conversationId: string) => void;
}

type QrState = {
  qrcodeId: string;
  imageSrc: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  waiting: '等待扫码…',
  scanned: '已扫码，请在手机上确认',
  confirmed: '登录成功',
  expired: '二维码已过期',
  error: '状态异常',
};

export function ChannelsPage({ conversations, onRefresh, onOpenConversation }: Props) {
  const [loggedIn, setLoggedIn] = useState(false);
  const [listening, setListening] = useState(false);
  const [qr, setQr] = useState<QrState | null>(null);
  const [polling, setPolling] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const wechatConversations = conversations.filter((c) => c.channel === 'wechat');
  const selectedUpdatedAt = wechatConversations.find((c) => c.id === selectedId)?.updatedAt;

  const refreshStatus = useCallback(async () => {
    const s = await window.weagent.wechatStatus();
    setLoggedIn(s.loggedIn);
    setListening(s.listening);
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 4000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    if (!selectedId && wechatConversations.length > 0) {
      setSelectedId(wechatConversations[0].id);
    }
  }, [wechatConversations, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    setLoadingMessages(true);
    void window.weagent
      .getMessages(selectedId, { limit: 40 })
      .then((result) => setMessages(result.messages))
      .finally(() => setLoadingMessages(false));
  }, [selectedId, selectedUpdatedAt]);

  const startLogin = async () => {
    setError('');
    setPolling(true);
    setStatus('正在获取二维码…');

    try {
      const result = await window.weagent.wechatGetQrCode();
      const imageSrc = resolveQrImageSrc(result);

      if (!imageSrc) {
        setError('未能获取二维码图片，请确认微信 PC 版已开启 ClawBot 插件');
      }

      setQr({ qrcodeId: result.qrcode, imageSrc });
      setStatus(STATUS_LABEL.waiting);

      void pollUntilDone(result.qrcode);
    } catch (err) {
      setPolling(false);
      setError(err instanceof Error ? err.message : String(err));
      setStatus('');
    }
  };

  const pollUntilDone = async (qrcodeId: string) => {
    try {
      while (true) {
        const result = await window.weagent.wechatPollQrStatus(qrcodeId);
        setStatus(STATUS_LABEL[result.status] ?? result.status);

        if (result.status === 'confirmed') {
          setLoggedIn(true);
          setQr(null);
          setPolling(false);
          await refreshStatus();
          await onRefresh();
          return;
        }
        if (result.status === 'expired' || result.status === 'error') {
          setPolling(false);
          if (result.status === 'expired') {
            setError('二维码已过期，请点击重新获取');
          }
          return;
        }
      }
    } catch (err) {
      setPolling(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleListening = async () => {
    if (listening) {
      const result = await window.weagent.wechatStop();
      setListening(result.listening);
    } else {
      const result = await window.weagent.wechatStart();
      setListening(result.listening);
    }
  };

  const selectedConv = wechatConversations.find((c) => c.id === selectedId);

  return (
    <div className="channel-page-wide">
      <div className="card channel-card">
        <div className="channel-card-header">
          <h3>微信 iLink / ClawBot</h3>
          <div className="channel-status-group">
            <span className={`status-badge ${loggedIn ? 'ok' : 'error'}`}>
              {loggedIn ? '已登录' : '未登录'}
            </span>
            {loggedIn && (
              <span className={`status-badge ${listening ? 'ok' : 'error'}`}>
                {listening ? '监听中' : '未监听'}
              </span>
            )}
          </div>
        </div>

        <p className="channel-desc">
          在 PC 微信「设置 → 插件」中开启 ClawBot 插件，扫码绑定后可通过微信远程对话。
          登录后监听在后台自动运行，离开本页不会中断。
        </p>

        {error && <div className="channel-error">{error}</div>}

        {!loggedIn && (
          <div className="qr-section">
            {!qr && (
              <button onClick={() => void startLogin()} disabled={polling}>
                {polling ? '获取中…' : '获取登录二维码'}
              </button>
            )}

            {qr && (
              <div className="qr-display">
                {qr.imageSrc ? (
                  <div className="qr-image-wrap">
                    <img src={qr.imageSrc} alt="微信登录二维码" className="qr-image" />
                  </div>
                ) : (
                  <div className="qr-image-wrap qr-image-fallback">
                    <p>二维码图片加载失败</p>
                    <code>{qr.qrcodeId.slice(0, 32)}…</code>
                  </div>
                )}

                <p className="qr-status">{status}</p>
                <p className="qr-hint">请使用微信扫描上方二维码</p>

                {!polling && (
                  <button className="secondary" onClick={() => void startLogin()} style={{ marginTop: 12 }}>
                    刷新二维码
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {loggedIn && (
          <div className="channel-logged-in">
            <button onClick={() => void toggleListening()}>
              {listening ? '暂停消息监听' : '恢复消息监听'}
            </button>
            <p className="channel-hint">
              远程命令：/new · /list · /switch · /agent · /status
            </p>
          </div>
        )}
      </div>

      {loggedIn && (
        <div className="channel-conversations card">
          <div className="channel-conv-header">
            <h3>微信对话记录</h3>
            <button className="secondary" type="button" onClick={() => void onRefresh()}>
              刷新
            </button>
          </div>

          {wechatConversations.length === 0 ? (
            <div className="empty-state" style={{ padding: '24px 12px' }}>
              暂无微信对话。向机器人发送消息后，记录会出现在这里和「对话」页。
            </div>
          ) : (
            <div className="channel-conv-layout">
              <div className="channel-conv-list">
                {wechatConversations.map((conv) => (
                  <button
                    key={conv.id}
                    type="button"
                    className={`channel-conv-item${selectedId === conv.id ? ' active' : ''}`}
                    onClick={() => setSelectedId(conv.id)}
                  >
                    <div className="channel-conv-title">{conv.title}</div>
                    <div className="channel-conv-meta">
                      {conv.channelPeerId?.slice(0, 12) ?? conv.id.slice(0, 8)}
                    </div>
                  </button>
                ))}
              </div>

              <div className="channel-message-panel">
                {selectedConv ? (
                  <>
                    <div className="channel-message-header">
                      <div>
                        <div className="channel-message-title">{selectedConv.title}</div>
                        <div className="channel-message-sub">
                          用户 {selectedConv.channelPeerId?.slice(0, 16) ?? '—'}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => onOpenConversation(selectedConv.id)}
                      >
                        在对话页打开
                      </button>
                    </div>

                    <div className="channel-message-list">
                      {loadingMessages && (
                        <div className="empty-state" style={{ padding: 16, fontSize: 12 }}>
                          加载中…
                        </div>
                      )}
                      {!loadingMessages && messages.length === 0 && (
                        <div className="empty-state" style={{ padding: 16, fontSize: 12 }}>
                          暂无消息
                        </div>
                      )}
                      {messages.map((m) => (
                        <div key={m.id} className={`channel-message-row ${m.role}`}>
                          <span className="channel-message-role">
                            {m.role === 'user' ? '微信' : 'AI'}
                          </span>
                          <div className="channel-message-content">
                            {m.role === 'assistant' ? (
                              <MarkdownContent content={m.content} />
                            ) : (
                              m.content
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="empty-state" style={{ padding: 24 }}>
                    选择左侧对话查看记录
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function resolveQrImageSrc(result: {
  qrcode: string;
  qrcodeImageContent?: string;
  qrcodeImageUrl?: string;
}): string | null {
  const content = result.qrcodeImageContent;
  if (!content) return null;
  if (content.startsWith('data:')) return content;
  return null;
}
