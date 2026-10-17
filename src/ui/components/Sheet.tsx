import type { ReactNode } from 'react';

export function Sheet({ children, onClose }: { children: ReactNode; onClose(): void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
