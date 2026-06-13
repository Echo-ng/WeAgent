import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { CloseButton } from './CloseButton';

interface PreviewState {
  src: string;
  alt: string;
}

const ImagePreviewContext = createContext<{
  openPreview: (preview: PreviewState) => void;
} | null>(null);

export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const openPreview = useCallback((next: PreviewState) => {
    setPreview(next);
  }, []);

  const close = useCallback(() => setPreview(null), []);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, close]);

  return (
    <ImagePreviewContext.Provider value={{ openPreview }}>
      {children}
      {preview && (
        <div
          className="image-lightbox-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={preview.alt || '图片预览'}
          onClick={close}
        >
          <CloseButton
            size="lg"
            variant="overlay"
            className="image-lightbox-close"
            onClick={close}
            aria-label="关闭"
          />
          <img
            className="image-lightbox-img"
            src={preview.src}
            alt={preview.alt}
            onClick={(e) => e.stopPropagation()}
          />
          {preview.alt && preview.alt !== '图片' && (
            <div className="image-lightbox-caption">{preview.alt}</div>
          )}
        </div>
      )}
    </ImagePreviewContext.Provider>
  );
}

function useImagePreview() {
  const ctx = useContext(ImagePreviewContext);
  if (!ctx) throw new Error('useImagePreview must be used within ImagePreviewProvider');
  return ctx;
}

interface ChatImageProps {
  src?: string;
  alt?: string;
  className?: string;
  filePath?: string;
}

export function ChatImage({ src, alt = '图片', className, filePath }: ChatImageProps) {
  const { openPreview } = useImagePreview();
  const [thumbSrc, setThumbSrc] = useState(src);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setThumbSrc(src);
  }, [src]);

  const resolveSrc = async (): Promise<string | null> => {
    if (thumbSrc) return thumbSrc;
    if (!filePath) return null;
    try {
      return await window.weagent.readAttachmentImage(filePath);
    } catch {
      return null;
    }
  };

  const handleClick = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const url = await resolveSrc();
      if (url) {
        if (!thumbSrc) setThumbSrc(url);
        openPreview({ src: url, alt });
      }
    } finally {
      setLoading(false);
    }
  };

  if (!thumbSrc && !filePath) return null;

  return (
    <button
      type="button"
      className={`chat-image-btn${loading ? ' is-loading' : ''}`}
      onClick={() => void handleClick()}
      aria-label={`查看大图：${alt}`}
    >
      {thumbSrc ? (
        <img src={thumbSrc} alt={alt} className={className} draggable={false} />
      ) : (
        <span className={`chat-image-placeholder ${className ?? ''}`}>{loading ? '加载中…' : alt}</span>
      )}
      <span className="chat-image-zoom-hint" aria-hidden>
        放大
      </span>
    </button>
  );
}
