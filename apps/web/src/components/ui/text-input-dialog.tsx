"use client";

import { Check, LoaderCircle, Pencil, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef } from "react";

type TextInputDialogProps = {
  title: string;
  label: string;
  value: string;
  confirmLabel: string;
  busy?: boolean;
  maxLength?: number;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

function trapFocus(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (event.key !== "Tab" || !container) return;
  const elements = Array.from(
    container.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")
  );
  if (!elements.length) return;
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function TextInputDialog({
  title,
  label,
  value,
  confirmLabel,
  busy = false,
  maxLength,
  onChange,
  onCancel,
  onConfirm
}: TextInputDialogProps) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  cancelRef.current = onCancel;
  busyRef.current = busy;
  const canConfirm = value.trim().length > 0;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    inputRef.current?.select();

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) cancelRef.current();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!busy && canConfirm) onConfirm();
  }

  return (
    <div
      className="modal-backdrop text-input-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <form
        ref={dialogRef}
        className="text-input-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="text-input-dialog-title"
        onKeyDown={(event) => trapFocus(event, dialogRef.current)}
        onSubmit={handleSubmit}
      >
        <header className="text-input-dialog-header">
          <span className="text-input-dialog-mark" aria-hidden="true"><Pencil size={18} /></span>
          <h2 id="text-input-dialog-title">{title}</h2>
        </header>
        <label className="text-input-dialog-field">
          <span>{label}</span>
          <input
            ref={inputRef}
            value={value}
            maxLength={maxLength}
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        <div className="text-input-dialog-actions">
          <button type="button" className="cancel-action" onClick={onCancel} disabled={busy}>
            <X size={14} />
            取消
          </button>
          <button type="submit" className="primary-action" disabled={busy || !canConfirm}>
            {busy ? <LoaderCircle className="button-spinner" size={14} /> : <Check size={14} />}
            {busy ? "正在保存" : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
