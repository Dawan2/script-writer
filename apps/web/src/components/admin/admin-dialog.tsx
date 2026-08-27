"use client";

import { X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import styles from "./admin.module.css";

type AdminDialogProps = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  destructive?: boolean;
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function AdminDialog({
  title,
  children,
  confirmLabel,
  busy,
  destructive,
  confirmDisabled,
  onCancel,
  onConfirm
}: AdminDialogProps) {
  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!busy && !confirmDisabled) onConfirm();
  }

  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={() => !busy && onCancel()}>
      <form className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="admin-dialog-title" onSubmit={handleSubmit} onMouseDown={(event) => event.stopPropagation()}>
        <div className={styles.dialogHeader}>
          <h2 id="admin-dialog-title">{title}</h2>
          <button type="button" className={styles.iconButton} onClick={onCancel} disabled={busy} aria-label="关闭" title="关闭">
            <X size={17} />
          </button>
        </div>
        <div className={styles.dialogBody}>{children}</div>
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>取消</button>
          <button type="submit" className={destructive ? styles.dangerButton : styles.primaryButton} disabled={busy || confirmDisabled}>
            {busy ? "处理中" : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
