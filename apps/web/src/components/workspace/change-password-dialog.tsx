"use client";

import { Check, KeyRound, LoaderCircle, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { changePassword } from "@/lib/api-client";

type ChangePasswordDialogProps = {
  onClose: () => void;
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

export function ChangePasswordDialog({ onClose }: ChangePasswordDialogProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const dialogRef = useRef<HTMLFormElement>(null);
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const completeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  const newPasswordError = newPassword && newPassword.length < 8
    ? "新密码至少需要 8 个字符"
    : currentPassword && newPassword === currentPassword
      ? "新密码不能与当前密码相同"
      : null;
  const confirmationError = confirmation && confirmation !== newPassword ? "两次输入的新密码不一致" : null;
  const canSubmit = Boolean(currentPassword && newPassword && confirmation)
    && !newPasswordError
    && !confirmationError;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    currentPasswordRef.current?.focus();

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) onCloseRef.current();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (complete) completeButtonRef.current?.focus();
  }, [complete]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;

    setBusy(true);
    setError(null);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setComplete(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "密码修改失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="modal-backdrop text-input-dialog-backdrop change-password-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="text-input-dialog change-password-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-password-dialog-title"
        aria-describedby="change-password-dialog-description"
        onKeyDown={(event) => trapFocus(event, dialogRef.current)}
        onSubmit={(event) => void handleSubmit(event)}
      >
        <header className="text-input-dialog-header">
          <span className="text-input-dialog-mark" aria-hidden="true"><KeyRound size={18} /></span>
          <span className="change-password-dialog-heading">
            <h2 id="change-password-dialog-title">修改密码</h2>
            <p id="change-password-dialog-description">请先验证当前密码，再设置新密码。</p>
          </span>
        </header>
        {complete ? (
          <>
            <div className="change-password-success" role="status">
              <Check size={18} aria-hidden="true" />
              <span>密码已修改</span>
            </div>
            <div className="text-input-dialog-actions">
              <button ref={completeButtonRef} type="button" className="primary-action" onClick={onClose}>
                完成
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="change-password-fields">
              <label className="text-input-dialog-field">
                <span>当前密码</span>
                <input
                  ref={currentPasswordRef}
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  maxLength={200}
                  disabled={busy}
                  required
                  onChange={(event) => {
                    setCurrentPassword(event.target.value);
                    setError(null);
                  }}
                />
              </label>
              <label className="text-input-dialog-field">
                <span>新密码</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  minLength={8}
                  maxLength={200}
                  disabled={busy}
                  required
                  aria-invalid={Boolean(newPasswordError)}
                  aria-describedby={newPasswordError ? "change-password-new-error" : undefined}
                  onChange={(event) => {
                    setNewPassword(event.target.value);
                    setError(null);
                  }}
                />
                {newPasswordError ? <small id="change-password-new-error" className="change-password-field-error">{newPasswordError}</small> : <small>至少 8 个字符</small>}
              </label>
              <label className="text-input-dialog-field">
                <span>确认新密码</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  maxLength={200}
                  disabled={busy}
                  required
                  aria-invalid={Boolean(confirmationError)}
                  aria-describedby={confirmationError ? "change-password-confirmation-error" : undefined}
                  onChange={(event) => {
                    setConfirmation(event.target.value);
                    setError(null);
                  }}
                />
                {confirmationError ? <small id="change-password-confirmation-error" className="change-password-field-error">{confirmationError}</small> : null}
              </label>
            </div>
            {error ? <p className="change-password-form-error" role="alert">{error}</p> : null}
            <div className="text-input-dialog-actions">
              <button type="button" className="cancel-action" onClick={onClose} disabled={busy}>
                <X size={14} />
                取消
              </button>
              <button type="submit" className="primary-action" disabled={busy || !canSubmit}>
                {busy ? <LoaderCircle className="button-spinner" size={14} /> : <Check size={14} />}
                {busy ? "正在修改" : "确认修改"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>,
    document.body
  );
}
