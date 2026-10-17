import { useEffect, useId, type ReactNode } from 'react';

/** Confirmation sheet: bottom sheet on phones, centred dialog on larger screens. */
export function Sheet({ title, children, onClose }: { title: ReactNode; children: ReactNode; onClose(): void }) {
  const id = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="glass sheet" role="dialog" aria-modal="true" aria-labelledby={id} onClick={(e) => e.stopPropagation()}>
        <h2 className="t-title" id={id}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
