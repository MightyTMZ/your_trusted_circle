import { useId, type ReactNode } from 'react';
import { Icon } from './Icon';

/** On/off switch: 88×44 track, knob slides right and fills with the accent when on. */
export function Toggle({
  checked,
  onChange,
  labelledBy,
  label,
  disabled,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  labelledBy?: string;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className="btn toggle"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="knob">
        <Icon name="power" />
      </span>
      <span className="tl">{checked ? 'On' : 'Off'}</span>
    </button>
  );
}

/** A labelled toggle inside a card list. `sub` only for what the person must know to decide. */
export function ToggleRow({
  label,
  sub,
  checked,
  onChange,
  disabled,
  children,
}: {
  label: string;
  sub?: ReactNode;
  checked: boolean;
  onChange(v: boolean): void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="toggle-row">
      <div className="stack grow" style={{ gap: 4 }}>
        <span className="t-name" id={id}>
          {label}
        </span>
        {sub && <span className="t-sub">{sub}</span>}
        {children}
      </div>
      <Toggle checked={checked} onChange={onChange} labelledBy={id} disabled={disabled} />
    </div>
  );
}

export interface Option<T extends string> {
  value: T;
  label: string;
  /** Shown only while this option is selected. */
  help?: string;
}

/** Single-choice list. Selected row gets the accent ring and a filled check. */
export function OptionList<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Option<T>[];
  value: T | null;
  onChange(v: T): void;
}) {
  const id = useId();
  return (
    <div className="fgroup" role="radiogroup" aria-labelledby={id}>
      <span className="lbl" id={id}>
        {label}
      </span>
      {options.map((o) => {
        const sel = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={sel}
            className={`btn opt ${sel ? 'is-sel' : ''}`}
            onClick={() => onChange(o.value)}
          >
            <span className="stack grow">
              <span className="t-name">{o.label}</span>
              {sel && o.help && <span className="t-sub">{o.help}</span>}
            </span>
            <span className="radio">
              <Icon name="check" />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Segmented choice as a row of chips. */
export function ChipChoice<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange(v: T): void;
}) {
  const id = useId();
  return (
    <div className="fgroup">
      <span className="lbl" id={id}>
        {label}
      </span>
      <div className="seg-chips" role="radiogroup" aria-labelledby={id}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={`btn chip num ${o.value === value ? 'on-accent' : 'glass'}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** − value + for small numeric settings. */
export function Stepper({
  label,
  value,
  unit,
  step,
  min,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  step: number;
  min: number;
  onChange(v: number): void;
}) {
  return (
    <div className="row">
      <span className="t-body grow">{label}</span>
      <button
        type="button"
        className="btn ibtn ibtn-sm glass-2"
        aria-label={`Decrease ${label}`}
        disabled={value - step < min}
        onClick={() => onChange(Math.max(min, value - step))}
      >
        <Icon name="minus" />
      </button>
      <span className="t-name num center" style={{ width: 56 }} aria-live="polite">
        {value} {unit}
      </span>
      <button type="button" className="btn ibtn ibtn-sm glass-2" aria-label={`Increase ${label}`} onClick={() => onChange(value + step)}>
        <Icon name="plus" />
      </button>
    </div>
  );
}

/** Step progress for multi-step flows. */
export function StepBar({ step, total }: { step: number; total: number }) {
  return (
    <div className="seg" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={i < step ? 'is-on' : ''} />
      ))}
    </div>
  );
}

/** Back button, centred title, optional right slot. */
export function ScreenHeader({
  title,
  onBack,
  backLabel = 'Back',
  right,
}: {
  title: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  right?: ReactNode;
}) {
  return (
    <header className="header-back">
      {onBack ? (
        <button type="button" className="btn ibtn glass" aria-label={backLabel} onClick={onBack}>
          <Icon name="chevronLeft" />
        </button>
      ) : (
        <span />
      )}
      <h1 className="t-head">{title}</h1>
      <span style={{ justifySelf: 'end' }}>{right}</span>
    </header>
  );
}

/** Profile picture when there is one, initials otherwise. */
export function Avatar({ name, src, size = 40, className = 'glass-2' }: { name: string; src?: string | null; size?: number; className?: string }) {
  return (
    <span className={`av ${className}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.3), overflow: 'hidden' }}>
      {src ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials(name)}
    </span>
  );
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
