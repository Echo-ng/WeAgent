import type { ButtonHTMLAttributes } from 'react';
import { IconClose } from './Icons';

const ICON_SIZE = { sm: 14, md: 16, lg: 18 } as const;

type CloseButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: keyof typeof ICON_SIZE;
  variant?: 'ghost' | 'bordered' | 'overlay';
};

export function CloseButton({
  size = 'md',
  variant = 'ghost',
  className = '',
  ...props
}: CloseButtonProps) {
  const iconSize = ICON_SIZE[size];

  return (
    <button
      type="button"
      className={`icon-close-btn icon-close-btn-${size} icon-close-btn-${variant} ${className}`.trim()}
      {...props}
    >
      <IconClose width={iconSize} height={iconSize} aria-hidden />
    </button>
  );
}
