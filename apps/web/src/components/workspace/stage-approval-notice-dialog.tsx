"use client";

import { Check, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";

type StageApprovalNoticeDialogProps = {
  stageName: string;
  subsequentFileNames: string[];
  onClose: () => void;
};

function trapFocus(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (event.key !== "Tab" || !container) return;
  const elements = Array.from(container.querySelectorAll<HTMLElement>("button:not(:disabled)"));
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

export function StageApprovalNoticeDialog({
  stageName,
  subsequentFileNames,
  onClose
}: StageApprovalNoticeDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const subsequentFiles = subsequentFileNames.map((name) => `「${name}」`).join("、");

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  return (
    <div
      className="modal-backdrop stage-approval-notice-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="stage-approval-notice-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="stage-approval-notice-title"
        aria-describedby="stage-approval-notice-description"
        tabIndex={-1}
        onKeyDown={(event) => trapFocus(event, dialogRef.current)}
      >
        <header className="stage-approval-notice-header">
          <span className="stage-approval-notice-mark" aria-hidden="true"><Check size={21} /></span>
          <div>
            <span>确认完成</span>
            <h2 id="stage-approval-notice-title">后续内容已保留</h2>
          </div>
          <button
            ref={closeRef}
            className="stage-approval-notice-close"
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="stage-approval-notice-body">
          <p id="stage-approval-notice-description">
            「{stageName}」已确认。后续的{subsequentFiles}已有内容，系统将保留现有版本，不会自动继续生成。
          </p>
          <p className="stage-approval-notice-guidance">
            如需根据本次确认更新后续内容，请进入相应文件后点击“重新生成”。
          </p>
        </div>
        <footer className="stage-approval-notice-actions">
          <button type="button" className="primary-action" onClick={onClose}>
            知道了
          </button>
        </footer>
      </section>
    </div>
  );
}
