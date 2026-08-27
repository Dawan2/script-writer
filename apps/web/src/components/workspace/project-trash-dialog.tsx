"use client";

import { AlertTriangle, Archive, Check, ChevronLeft, ChevronRight, Clock3, LoaderCircle, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { formatDateTime } from "@/lib/date-time";
import type { TrashedProject } from "@/lib/types";

type ConfirmationDialogProps = {
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  tone?: "primary" | "warning" | "danger";
  intent?: "delete" | "archive" | "reopen" | "review" | "sync";
  secondaryActionLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
  onSecondaryAction?: () => void;
};

type ProjectTrashDialogProps = {
  projects: TrashedProject[];
  loading: boolean;
  error?: string | null;
  page: number;
  total: number;
  totalPages: number;
  busyProjectId?: number | null;
  onClose: () => void;
  onRetry: () => void;
  onPageChange: (page: number) => void;
  onRestore: (project: TrashedProject) => void;
  onRequestPermanentDelete: (project: TrashedProject) => void;
};

type PaginationItem = number | "left-ellipsis" | "right-ellipsis";

function paginationItems(page: number, totalPages: number): PaginationItem[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, "right-ellipsis", totalPages];
  if (page >= totalPages - 3) {
    return [1, "left-ellipsis", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, "left-ellipsis", page - 1, page, page + 1, "right-ellipsis", totalPages];
}

function trapFocus(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (event.key !== "Tab" || !container) return;
  const elements = Array.from(
    container.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled)')
  ).filter((element) => !element.hasAttribute("hidden"));
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

export function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  busy = false,
  tone = "warning",
  intent = "delete",
  secondaryActionLabel,
  onCancel,
  onConfirm,
  onSecondaryAction
}: ConfirmationDialogProps) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    cancelRef.current?.focus();
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const eyebrow = intent === "archive"
    ? "项目归档"
    : intent === "reopen"
      ? "重新开启"
      : intent === "review"
        ? "AI 审稿"
        : intent === "sync"
          ? "剧本名称"
        : tone === "danger" ? "不可撤销" : "删除项目";
  const ConfirmIcon = intent === "archive" ? Archive : intent === "reopen" ? RotateCcw : intent === "review" ? RefreshCw : intent === "sync" ? Check : Trash2;

  return (
    <div
      className="modal-backdrop confirmation-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <form
        ref={dialogRef}
        className={`confirmation-dialog ${tone} ${intent}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-dialog-title"
        aria-describedby="confirmation-dialog-description"
        onKeyDown={(event) => trapFocus(event, dialogRef.current)}
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <div className="confirmation-dialog-mark" aria-hidden="true">
          <AlertTriangle size={22} />
        </div>
        <div className="confirmation-dialog-copy">
          <span>{eyebrow}</span>
          <h2 id="confirmation-dialog-title">{title}</h2>
          <p id="confirmation-dialog-description">{description}</p>
        </div>
        <div className="confirmation-dialog-actions">
          {secondaryActionLabel && onSecondaryAction ? (
            <button
              type="button"
              className="confirmation-dialog-text-action"
              onClick={onSecondaryAction}
              disabled={busy}
            >
              {secondaryActionLabel}
            </button>
          ) : null}
          <button ref={cancelRef} type="button" className="cancel-action" onClick={onCancel} disabled={busy}>
            <X size={14} />
            取消
          </button>
          <button type="submit" className={`destructive-action ${tone}`} disabled={busy}>
            {busy ? <LoaderCircle className="button-spinner" size={14} /> : <ConfirmIcon size={14} />}
            {busy ? "处理中" : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ProjectTrashDialog({
  projects,
  loading,
  error,
  page,
  total,
  totalPages,
  busyProjectId,
  onClose,
  onRetry,
  onPageChange,
  onRestore,
  onRequestPermanentDelete
}: ProjectTrashDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const busyProjectIdRef = useRef(busyProjectId);
  busyProjectIdRef.current = busyProjectId;
  const pages = paginationItems(page, totalPages);
  const paginationDisabled = loading || busyProjectId != null;

  useEffect(() => {
    closeRef.current?.focus();
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && busyProjectIdRef.current == null) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop trash-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && busyProjectId == null) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="trash-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trash-dialog-title"
        onKeyDown={(event) => trapFocus(event, dialogRef.current)}
      >
        <header className="trash-dialog-header">
          <div className="trash-dialog-title">
            <span className="trash-dialog-icon" aria-hidden="true"><Trash2 size={19} /></span>
            <span>
              <small>30 天保留期</small>
              <h2 id="trash-dialog-title">回收站</h2>
            </span>
          </div>
          <button ref={closeRef} type="button" className="trash-close-button" aria-label="关闭回收站" title="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="trash-retention-note">
          <Clock3 size={15} />
          <span>项目会在删除 30 天后自动彻底清理。</span>
        </div>

        <div className="trash-dialog-body" aria-busy={loading}>
          {loading ? (
            <div className="trash-dialog-state">
              <LoaderCircle className="trash-loading-icon" size={22} />
              <span>正在读取已删除项目</span>
            </div>
          ) : error ? (
            <div className="trash-dialog-state error">
              <span>{error}</span>
              <button type="button" className="trash-retry-button" onClick={onRetry}>
                <RefreshCw size={14} />
                重试
              </button>
            </div>
          ) : projects.length ? (
            <div className="trash-list">
              {projects.map((project) => {
                const busy = busyProjectId === project.id;
                return (
                  <article key={project.id} className="trash-item">
                    <div className="trash-item-copy">
                      <strong>{project.name}</strong>
                      <span>{project.task_type === "novel" ? "小说改编" : project.task_type === "replicate" ? "爆款复刻" : project.task_type === "review" ? "剧本审核" : project.task_type === "translate" ? "台词翻译" : project.task_type === "humanize" ? "剧本润色" : "剧本改写"}{project.target_region ? ` · ${project.target_region}` : ""}</span>
                    </div>
                    <div className="trash-item-retention">
                      <span>{formatDateTime(project.deleted_at, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 删除</span>
                      <strong>{project.days_remaining > 0 ? `剩余 ${project.days_remaining} 天` : "等待系统清理"}</strong>
                    </div>
                    <div className="trash-item-actions">
                      <button type="button" className="trash-restore-button" disabled={busyProjectId != null} onClick={() => onRestore(project)}>
                        {busy ? <LoaderCircle className="button-spinner" size={14} /> : <RotateCcw size={14} />}
                        {busy ? "处理中" : "恢复"}
                      </button>
                      <button
                        type="button"
                        className="trash-delete-button"
                        disabled={busyProjectId != null}
                        onClick={() => onRequestPermanentDelete(project)}
                      >
                        <Trash2 size={14} />
                        彻底删除
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="trash-dialog-state empty">
              <Trash2 size={24} />
              <strong>回收站是空的</strong>
              <span>已删除的项目会显示在这里</span>
            </div>
          )}
        </div>

        <footer className="trash-dialog-footer">
          <span className="trash-footer-count">共 {total} 个已删除项目</span>
          {!error && totalPages > 1 ? (
            <nav className="trash-pagination" aria-label="回收站分页">
              {page > 1 ? (
                <button
                  type="button"
                  className="trash-page-arrow"
                  aria-label="上一页"
                  title="上一页"
                  disabled={paginationDisabled}
                  onClick={() => onPageChange(page - 1)}
                >
                  <ChevronLeft size={15} />
                </button>
              ) : null}
              {pages.map((item) => typeof item === "number" ? (
                <button
                  key={item}
                  type="button"
                  className={`trash-page-number${item === page ? " current" : ""}`}
                  aria-label={`第 ${item} 页`}
                  aria-current={item === page ? "page" : undefined}
                  disabled={paginationDisabled || item === page}
                  onClick={() => onPageChange(item)}
                >
                  {item}
                </button>
              ) : (
                <span key={item} className="trash-page-ellipsis" aria-hidden="true">…</span>
              ))}
              {page < totalPages ? (
                <button
                  type="button"
                  className="trash-page-arrow"
                  aria-label="下一页"
                  title="下一页"
                  disabled={paginationDisabled}
                  onClick={() => onPageChange(page + 1)}
                >
                  <ChevronRight size={15} />
                </button>
              ) : null}
            </nav>
          ) : <span aria-hidden="true" />}
          <button type="button" className="cancel-action" onClick={onClose} disabled={busyProjectId != null}>关闭</button>
        </footer>
      </section>
    </div>
  );
}
