import { useEffect, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';

/**
 * A centred prompt over a blurred app, for access the session cannot work
 * without (motion for check-ins, location for the group map). Shown before
 * the browser's own permission request, so people know why it comes
 * (privacy.md › Pre-alert screens). It always has a way out that respects
 * the person's choice (modality.md › Best practices), named by the caller.
 */
export function AccessPrompt({
  icon,
  title,
  children,
  primary,
  secondary,
}: {
  icon: IconName;
  title: string;
  children: ReactNode;
  primary: { label: string; onClick(): void };
  secondary: { label: string; onClick(): void };
}) {
  const id = useId();
  // The page behind cannot scroll while the prompt is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  return createPortal(
    <div className="sheet-backdrop is-center">
      <div className="material sheet access" role="alertdialog" aria-modal="true" aria-labelledby={id}>
        <span className="access-ic" aria-hidden="true">
          <Icon name={icon} size={28} />
        </span>
        <h2 className="t-title" id={id}>
          {title}
        </h2>
        <div className="t-sub">{children}</div>
        <button type="button" className="btn pbtn on-accent" onClick={primary.onClick}>
          {primary.label}
        </button>
        <button type="button" className="btn pbtn fill" onClick={secondary.onClick}>
          {secondary.label}
        </button>
      </div>
    </div>,
    document.body,
  );
}
