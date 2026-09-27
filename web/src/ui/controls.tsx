/**
 * Panel primitives.
 *
 * Every control shows the physical quantity it sets and the unit it sets it in
 * — printer points, log exposure, density, stops, micrometres. This is the
 * paper's parameter-honesty principle carried into the interface: a slider
 * labelled "warmth 0–100" would be a small lie about what the model is doing.
 */

import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** Which sections the user has folded, by title — a per-device convenience. */
const SECTIONS_KEY = 'emulsion.sections.v1';

function readFolded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function writeFolded(title: string, folded: boolean) {
  try {
    const all = readFolded();
    if (folded) all[title] = true;
    else delete all[title];
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(all));
  } catch {
    // A refused write (private mode, quota) only costs the fold on reload.
  }
}

/**
 * A disclosure group. The header is one button — chevron, title and the
 * section's summary reading — so a folded section still reports its state.
 * The body springs open on a 0fr→1fr grid row: the height is the content's
 * own, never a guessed max-height, and an interrupted fold retargets from
 * wherever it is.
 */
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
  const bodyId = useId();
  const [open, setOpen] = useState(() => readFolded()[title] !== true);
  const toggle = () =>
    setOpen((was) => {
      writeFolded(title, was);
      return !was;
    });

  return (
    <section className={`panel-section${accent ? ' is-accent' : ''}${open ? ' is-open' : ''}`}>
      <h2 className="panel-section__heading">
        <button
          type="button"
          className="panel-section__head"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <svg className="panel-section__chevron" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3.5 2 L6.5 5 L3.5 8" />
          </svg>
          <span className="label">{title}</span>
          {meta ? <span className="panel-section__meta num">{meta}</span> : null}
        </button>
      </h2>
      <div className="panel-section__collapse" id={bodyId}>
        <div className="panel-section__clip">
          <div className="panel-section__body">{children}</div>
        </div>
      </div>
    </section>
  );
}

/**
 * The explanation behind a control, one tap away. The bench's hints are long
 * and they are the point — they say what the model is doing — but read once
 * they are clutter, so they fold behind an info button rather than going.
 * The hint stays the control's accessible description either way.
 */
function useHint() {
  const [open, setOpen] = useState(false);
  return { open, toggle: () => setOpen((o) => !o) };
}

function HintButton({
  label,
  hintId,
  open,
  onToggle,
}: {
  label: string;
  hintId: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`control__info${open ? ' is-on' : ''}`}
      aria-expanded={open}
      aria-controls={hintId}
      aria-label={`About ${label}`}
      onClick={onToggle}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25" />
        <path d="M8 7.2 V11.2 M8 4.9 V5" />
      </svg>
    </button>
  );
}

function Hint({ id, open, children }: { id: string; open: boolean; children: ReactNode }) {
  return (
    <div className={`control__hint-wrap${open ? ' is-open' : ''}`}>
      <div className="control__hint-clip">
        <p className="control__hint" id={id}>
          {children}
        </p>
      </div>
    </div>
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
  const tip = useHint();
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  const text = format ? format(value) : value.toFixed(decimals);
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className={`control${disabled ? ' is-disabled' : ''}`}>
      <div className="control__row">
        <span className="control__name">
          <label className="control__label" htmlFor={id}>
            {label}
          </label>
          {hint ? (
            <HintButton label={label} hintId={`${id}-hint`} open={tip.open} onToggle={tip.toggle} />
          ) : null}
        </span>
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
        <Hint id={`${id}-hint`} open={tip.open}>
          {hint}
        </Hint>
      ) : null}
    </div>
  );
}

/**
 * A labelled control that is not a slider — a segmented choice, a group of
 * them — with the same folding explanation every slider has, so no control
 * on the bench spends the phone's height on a paragraph nobody asked to read.
 */
export function Field({
  label,
  hint,
  disabled,
  children,
}: {
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const tip = useHint();
  return (
    <div className={`control${disabled ? ' is-disabled' : ''}`} role="group" aria-labelledby={`${id}-label`}>
      <div className="control__row">
        <span className="control__name">
          <span className="control__label" id={`${id}-label`}>
            {label}
          </span>
          {hint ? (
            <HintButton label={label} hintId={`${id}-hint`} open={tip.open} onToggle={tip.toggle} />
          ) : null}
        </span>
      </div>
      {children}
      {hint ? (
        <Hint id={`${id}-hint`} open={tip.open}>
          {hint}
        </Hint>
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
  swatch,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; detail?: string; swatch?: string }[];
  onChange: (v: T) => void;
  hint?: string;
  /** A CSS colour for the dot at the head of the pill, when the choice names
   *  something that has a colour — a record, a stock family, an illuminant.
   *  Per-option `swatch` wins, so the dot can follow the selection. */
  swatch?: string;
}) {
  const id = useId();
  const tip = useHint();
  const selected = options.find((o) => o.value === value);
  const dot = selected?.swatch ?? swatch;
  const note = selected?.detail ?? hint;
  return (
    <div className="control control--choice">
      <div className="control__row">
        <span className="control__name">
          <label className="control__label" htmlFor={id}>
            {label}
          </label>
          {note ? (
            <HintButton label={label} hintId={`${id}-hint`} open={tip.open} onToggle={tip.toggle} />
          ) : null}
        </span>
      </div>
      <div className={`select${dot ? ' has-swatch' : ''}`}>
        {dot ? <span className="select__swatch" aria-hidden="true" style={{ background: dot }} /> : null}
        <select
          id={id}
          value={value}
          aria-describedby={note ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.value as T)}
        >
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
      {note ? (
        <Hint id={`${id}-hint`} open={tip.open}>
          {note}
        </Hint>
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
  /** The selected segment's box, which the sliding thumb takes. */
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  /** Off for the first placement, so the thumb appears in place instead of
      sliding in from the left edge on mount. */
  const [ready, setReady] = useState(false);

  // One thumb that slides between segments, rather than each segment lighting
  // itself: the selection reads as one object moving, which is the motion
  // that tells you where it went. Measured from the live layout, so segments
  // of any width work, and re-measured when the group reflows.
  useLayoutEffect(() => {
    const group = ref.current;
    if (!group) return;
    const place = () => {
      const on = group.querySelector<HTMLButtonElement>('[aria-checked="true"]');
      setThumb(on ? { x: on.offsetLeft, w: on.offsetWidth } : null);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(group);
    return () => ro.disconnect();
  }, [value, options.length]);

  useLayoutEffect(() => {
    if (!thumb || ready) return;
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, [thumb, ready]);

  // A radiogroup is one tab stop whose options the arrows walk — the plain
  // tab stops browsers give a row of buttons make four modes four stops.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const group = ref.current;
    if (!group) return;
    const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]')).filter(
      (b) => !b.closest('.is-disabled'),
    );
    if (radios.length < 2) return;
    const current = radios.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const next = radios[(current + step + radios.length) % radios.length]!;
    e.preventDefault();
    next.focus();
    const v = next.dataset.value;
    if (v) onChange(v as T);
  };

  return (
    <div
      className={`segmented${ready ? ' is-ready' : ''}`}
      role="radiogroup"
      aria-label={label}
      ref={ref}
      onKeyDown={onKeyDown}
    >
      {thumb ? (
        <span
          className="segmented__thumb"
          aria-hidden="true"
          style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
        />
      ) : null}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          data-value={o.value}
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
