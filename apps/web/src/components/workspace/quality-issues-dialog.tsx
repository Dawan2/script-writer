"use client";

import { AlertTriangle, Pencil, Sparkles, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import type { StageFile } from "@/lib/types";

type QualityIssuesDialogProps = {
  file: StageFile;
  creditCost?: number | null;
  creditBalance?: number | null;
  creditsManaged?: boolean;
  onClose: () => void;
  onAutoRepair: () => void;
  onManualEdit: () => void;
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

export function QualityIssuesDialog({ file, creditCost, creditBalance, creditsManaged = false, onClose, onAutoRepair, onManualEdit }: QualityIssuesDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const warnings = file.quality_warnings ?? [];
  const creditInsufficient = Boolean(creditsManaged && creditCost !== null && creditCost !== undefined && creditBalance !== null && creditBalance !== undefined && creditBalance < creditCost);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
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
      className="modal-backdrop quality-issues-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="quality-issues-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="quality-issues-title"
        aria-describedby="quality-issues-guidance"
        tabIndex={-1}
        onKeyDown={(event) => trapFocus(event, dialogRef.current)}
      >
        <header className="quality-issues-header">
          <span className="quality-issues-mark" aria-hidden="true"><AlertTriangle size={21} /></span>
          <div>
            <span>内容检查</span>
            <h2 id="quality-issues-title">{file.name}需要处理</h2>
          </div>
          <button
            className="quality-issues-close"
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="quality-issues-body">
          <p>发现 {warnings.length} 项问题：</p>
          <ol>
            {warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
          </ol>
          <p id="quality-issues-guidance" className="quality-issues-guidance">
            {file.next_action || "请根据上述问题修改并保存当前文档，然后点击“下一步”重新检查。"}
          </p>
          {creditCost !== null && creditCost !== undefined ? (
            <p className={`quality-credit-note${creditInsufficient ? " insufficient" : ""}`}>
              {creditInsufficient
                ? `自动修复需要 ${creditCost} 额度，当前可用 ${creditBalance ?? 0} 额度。你仍可选择手动修改。`
                : `使用自动修复将消耗 ${creditCost} 额度；执行失败时会自动退还。`}
            </p>
          ) : null}
        </div>
        <footer className="quality-issues-actions">
          <button type="button" className="manual-action" onClick={onManualEdit}>
            <Pencil size={14} />
            手动编辑
          </button>
          <button type="button" className="primary-action" onClick={onAutoRepair} disabled={creditInsufficient} title={creditInsufficient ? "创作额度不足，请联系管理员补充额度" : undefined}>
            <Sparkles size={14} />
            {creditInsufficient ? "额度不足" : creditCost !== null && creditCost !== undefined ? `自动修复 · ${creditCost}额度` : "自动修复"}
          </button>
        </footer>
      </section>
    </div>
  );
}
