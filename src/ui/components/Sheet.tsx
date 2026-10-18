import { useEffect, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Confirmation sheet: bottom sheet on phones, centred dialog on larger screens.
 * Portalled to <body>: callers sit inside material surfaces (backdrop-filter) and
 * the bottom nav (transform), which would otherwise trap a fixed overlay.
 */
export function Sheet({
  title,
  children,
  onClose,
  centered = false,
  className = '',
}: {
  title: ReactNode;
  children: ReactNode;
  onClose(): void;
  /** Centred on every screen size, phones included, instead of a bottom sheet. */
  centered?: boolean;
  className?: string;
}) {
  const id = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className={`sheet-backdrop ${centered ? 'is-center' : ''}`} onClick={onClose}>
      <div className={`material sheet ${className}`} role="dialog" aria-modal="true" aria-labelledby={id} onClick={(e) => e.stopPropagation()}>
        <h2 className="t-title" id={id}>
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
