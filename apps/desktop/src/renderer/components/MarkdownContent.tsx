import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

interface Props {
  content: string;
  className?: string;
}

const markdownComponents: Components = {
  pre({ children }) {
    return <pre className="md-pre">{children}</pre>;
  },
  code({ className, children, ...props }) {
    const isFenced = Boolean(className?.startsWith('language-'));
    if (isFenced) {
      return (
        <code className={`md-code-block ${className ?? ''}`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="md-code-inline" {...props}>
        {children}
      </code>
    );
  },
  a({ href, children }) {
    return (
      <a href={href} className="md-link" target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="md-table-wrap">
        <table className="md-table">{children}</table>
      </div>
    );
  },
};

export const MarkdownContent = memo(function MarkdownContent({ content, className }: Props) {
  if (!content.trim()) return null;

  return (
    <div className={`markdown-body${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
