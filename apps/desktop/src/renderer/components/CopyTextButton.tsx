import { useCallback, useEffect, useRef, useState } from 'react';
import { IconCopy } from './Icons';

interface Props {
  text: string;
  label?: string;
  className?: string;
}

export function CopyTextButton({ text, label = '复制', className = '' }: Props) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback(async () => {
    const value = text.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [text]);

  if (!text.trim()) return null;

  return (
    <button
      type="button"
      className={`copy-text-btn${copied ? ' is-copied' : ''} ${className}`.trim()}
      onClick={() => void copy()}
      aria-label={copied ? '已复制' : label}
      title={copied ? '已复制' : label}
    >
      {copied ? (
        <span className="copy-text-btn-label">已复制</span>
      ) : (
        <>
          <IconCopy width={13} height={13} aria-hidden />
          <span className="copy-text-btn-label">{label}</span>
        </>
      )}
    </button>
  );
}
