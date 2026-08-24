/**
 * Panel primitives.
 *
 * Every control shows the physical quantity it sets and the unit it sets it in
 * — printer points, log exposure, density, stops, micrometres. This is the
 * paper's parameter-honesty principle carried into the interface: a slider
 * labelled "warmth 0–100" would be a small lie about what the model is doing.
 */

import { useCallback, useId, useRef, type ReactNode } from 'react';

export function Section({
  title,
  meta,
  children,
  accent,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  accent?: boolean;
}) {
  return (
    <section className={`panel-section${accent ? ' is-accent' : ''}`}>
      <header className="panel-section__head">
        <h2 className="label">{title}</h2>
        {meta ? <div className="panel-section__meta num">{meta}</div> : null}
      </header>
      <div className="panel-section__body">{children}</div>
    </section>
  );
}

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** Rendered readout; defaults to the value fixed to the step's precision. */
  format?: (v: number) => string;
  /** Values that get a tick and snap-on-release, e.g. the normal process. */
  detents?: number[];
  hint?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  unit,
  format,
  detents,
  hint,
  disabled,
  onChange,
}: SliderProps) {
  const id = useId();
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  const text = format ? format(value) : value.toFixed(decimals);
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className={`control${disabled ? ' is-disabled' : ''}`}>
      <div className="control__row">
        <label className="control__label" htmlFor={id} title={hint}>
          {label}
        </label>
        <output className="control__value num" htmlFor={id}>
          {text}
          {unit ? <span className="control__unit">{unit}</span> : null}
        </output>
      </div>
      <div className="slider">
        {detents?.length ? (
          <div className="slider__detents" aria-hidden="true">
            {detents.map((d) => (
              <i key={d} style={{ left: `${((d - min) / (max - min)) * 100}%` }} />
            ))}
          </div>
        ) : null}
        <div className="slider__track" aria-hidden="true">
          <div className="slider__fill" style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} />
        </div>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      {hint ? (
        <p className="control__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The printer point control. Integer by design: printer points are integers in
 * practice, the quantisation is finer than the visual threshold, and integers
 * are what makes a grade communicable between a lab and a client. A continuous
 * slider here would be a small betrayal for no benefit.
 */
export function PointStepper({
  label,
  record,
  value,
  limit,
  onChange,
}: {
  label: string;
  record?: 'r' | 'g' | 'b';
  value: number;
  limit: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const clamp = useCallback((v: number) => Math.max(-limit, Math.min(limit, Math.round(v))), [limit]);
  const pct = ((value + limit) / (2 * limit)) * 100;

  return (
    <div className={`stepper${record ? ` stepper--${record}` : ''}`}>
      <label className="stepper__label num" htmlFor={id}>
        {label}
      </label>
      <div className="stepper__track">
        <div className="stepper__centre" aria-hidden="true" />
        <div
          className="stepper__bar"
          aria-hidden="true"
          style={{
            left: `${Math.min(50, pct)}%`,
            width: `${Math.abs(pct - 50)}%`,
          }}
        />
        <input
          id={id}
          type="range"
          min={-limit}
          max={limit}
          step={1}
          value={value}
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
        />
      </div>
      <output className="stepper__value num" htmlFor={id}>
        {value > 0 ? `+${value}` : value}
      </output>
    </div>
  );
}

export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; detail?: string }[];
  onChange: (v: T) => void;
  hint?: string;
}) {
  const id = useId();
  const selected = options.find((o) => o.value === value);
  return (
    <div className="control control--choice">
      <div className="control__row">
        <label className="control__label" htmlFor={id}>
          {label}
        </label>
      </div>
      <div className="select">
        <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <svg viewBox="0 0 12 12" aria-hidden="true" className="select__caret">
          <path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </div>
      {(selected?.detail ?? hint) ? (
        <p className="control__hint">{selected?.detail ?? hint}</p>
      ) : null}
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="toggle">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>
        <span className="toggle__box" aria-hidden="true">
          <svg viewBox="0 0 12 12">
            <path d="M2.5 6.2l2.4 2.4L9.6 3.9" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </span>
        <span>
          {label}
          {hint ? <em>{hint}</em> : null}
        </span>
      </label>
    </div>
  );
}

/** A row of mutually exclusive inspection modes. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="segmented" role="radiogroup" aria-label={label} ref={ref}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          className={value === o.value ? 'is-on' : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: 'ghost' | 'primary';
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`btn btn--${variant}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
