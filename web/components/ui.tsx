"use client";

import type { ButtonHTMLAttributes, ComponentPropsWithRef, ReactNode } from "react";
import { useEffect, useId, useRef } from "react";
import { AlertCircle, Check, Loader2, RefreshCw, X } from "lucide-react";

type ButtonVariant = "primary" | "gold" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "primary",
  size = "md",
  busy = false,
  icon,
  children,
  className = "",
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  busy?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      {...props}
      disabled={disabled || busy}
      className={`btn btn-${variant} btn-${size} ${className}`}
    >
      {busy ? <Loader2 size={17} className="spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className={`icon-btn ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "aside";
}) {
  return <Tag className={`card ${className}`}>{children}</Tag>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="eyebrow-sm">{eyebrow}</p> : null}
        <h1 className="page-title">{title}</h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function SectionHeading({
  title,
  action,
  hint,
}: {
  title: string;
  action?: ReactNode;
  hint?: string;
}) {
  return (
    <div className="section-heading-row">
      <div>
        <h2 className="section-title">{title}</h2>
        {hint ? <p className="section-hint">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Chip({
  children,
  tone = "muted",
  className = "",
}: {
  children: ReactNode;
  tone?: "brand" | "gold" | "success" | "warning" | "danger" | "muted" | "info";
  className?: string;
}) {
  return <span className={`chip chip-${tone} ${className}`}>{children}</span>;
}

export function Alert({
  tone = "danger",
  title,
  children,
  action,
}: {
  tone?: "danger" | "warning" | "info" | "success";
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`alert alert-${tone}`}>
      <AlertCircle size={18} aria-hidden="true" className="alert-icon" />
      <div className="alert-body">
        {title ? <p className="alert-title">{title}</p> : null}
        <div className="alert-text">{children}</div>
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <h3 className="empty-title">{title}</h3>
      <p className="empty-body">{body}</p>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={24} aria-hidden="true" />
      <p>{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} icon={<RefreshCw size={15} />}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}

export function LoadingBlock({ rows = 3 }: { rows?: number }) {
  return (
    <div className="loading-block" aria-label="Loading" role="status">
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className={index === 0 ? "h-6 w-1/3" : "h-20 w-full"} />
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && !error ? <p className="field-hint">{hint}</p> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({ className = "", ...props }: ComponentPropsWithRef<"input">) {
  return <input {...props} className={`input ${className}`} />;
}

export function TextArea({
  className = "",
  ...props
}: ComponentPropsWithRef<"textarea">) {
  return <textarea {...props} className={`textarea ${className}`} />;
}

export function Select({ className = "", children, ...props }: ComponentPropsWithRef<"select">) {
  return (
    <select {...props} className={`input select ${className}`}>
      {children}
    </select>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={`segmented-item ${value === option.value ? "is-selected" : ""}`}
          onClick={() => onChange(option.value)}
        >
          <span>{option.label}</span>
          {option.hint ? <small>{option.hint}</small> : null}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="toggle-row">
      <div>
        <label htmlFor={id} className="toggle-label">
          {label}
        </label>
        {description ? <p className="toggle-description">{description}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`toggle ${checked ? "is-on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

export function ProgressBar({
  value,
  label,
  tone = "brand",
}: {
  value: number;
  label?: string;
  tone?: "brand" | "gold" | "success";
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={label ?? "Progress"}
    >
      <span className={`progress-fill progress-${tone}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function Avatar({
  name,
  imageUrl,
  size = 40,
}: {
  name: string;
  imageUrl?: string | null;
  size?: number;
}) {
  const label = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "S";
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={`${name}'s profile photo`}
        width={size}
        height={size}
        className="avatar"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span className="avatar avatar-initials" style={{ width: size, height: size, fontSize: size * 0.34 }} aria-hidden="true">
      {label}
    </span>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={description ? "modal-description" : undefined}
        tabIndex={-1}
        className={`modal ${wide ? "modal-wide" : ""}`}
      >
        <div className="modal-header">
          <div>
            <h2 id="modal-title" className="modal-title">
              {title}
            </h2>
            {description ? (
              <p id="modal-description" className="modal-description">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label="Close" onClick={onClose} type="button">
            <X size={18} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = "Confirm",
  tone = "danger",
  busy = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: string;
  confirmLabel?: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={body}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button variant={tone} onClick={onConfirm} busy={busy} type="button">
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

export function StatusBadge({ state, stage }: { state: string; stage?: string }) {
  if (state === "done") return <Chip tone="success"><Check size={12} /> Ready</Chip>;
  if (state === "failed") return <Chip tone="danger">Failed</Chip>;
  if (state === "running" || state === "queued") {
    return <Chip tone="info"><Loader2 size={12} className="spin" /> {stageLabel(stage)}</Chip>;
  }
  return <Chip tone="muted">Not generated</Chip>;
}

export function stageLabel(stage?: string) {
  switch (stage) {
    case "reading":
      return "Reading source";
    case "reading_scans":
      return "Reading scans";
    case "digesting":
      return "Digesting";
    case "writing":
      return "Writing";
    case "checking":
      return "Checking facts";
    case "summarising":
      return "Summarising";
    case "making_cards":
      return "Making cards";
    case "marking":
      return "Marking quiz";
    default:
      return "Queued";
  }
}
