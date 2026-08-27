"use client";

import { History, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getFileVersion, getFileVersions, restoreFileVersion } from "@/lib/api-client";
import { formatDateTime } from "@/lib/date-time";
import { renderMarkdown } from "@/lib/markdown";
import type { FileVersion, FileVersionHistory, FileVersionSummary, StageDocument, StageFile } from "@/lib/types";

type FileVersionDialogProps = {
  projectId: number;
  file: StageFile;
  restoreDisabledReason?: string | null;
  onClose: () => void;
  onRestored: (file: StageDocument) => void | Promise<void>;
};

const OPERATION_LABELS: Record<string, string> = {
  initial: "初始版本",
  manual_save: "手动保存",
  agent_edit: "对话调整",
  agent_generation: "内容生成",
  regenerate: "重新生成",
  restore: "版本恢复",
  unknown: "内容更新"
};

function formatVersionTime(value: string) {
  return formatDateTime(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function jsonValueToMarkdown(value: unknown, depth = 1): string {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item && typeof item === "object") {
        return `${"#".repeat(Math.min(depth + 1, 3))} 第 ${index + 1} 项\n\n${jsonValueToMarkdown(item, depth + 1)}`;
      }
      return `- ${String(item ?? "")}`;
    }).join("\n\n");
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (item && typeof item === "object") {
        return `${"#".repeat(Math.min(depth, 3))} ${key}\n\n${jsonValueToMarkdown(item, depth + 1)}`;
      }
      return `**${key}**\n\n${String(item ?? "")}`;
    }).join("\n\n");
  }
  return String(value ?? "");
}

function readableVersionContent(content: string) {
  try {
    return jsonValueToMarkdown(JSON.parse(content));
  } catch {
    return content;
  }
}

export function FileVersionDialog({
  projectId,
  file,
  restoreDisabledReason,
  onClose,
  onRestored
}: FileVersionDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<FileVersionHistory | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<FileVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !restoring) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, restoring]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getFileVersions(projectId, file.stage)
      .then((result) => {
        if (cancelled) return;
        setHistory(result);
        setSelectedId(result.versions[0]?.id ?? null);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "版本记录加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [file.stage, projectId]);

  useEffect(() => {
    if (selectedId === null) {
      setSelectedVersion(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setConfirming(false);
    setError(null);
    getFileVersion(projectId, file.stage, selectedId)
      .then((version) => {
        if (!cancelled) setSelectedVersion(version);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "版本内容加载失败");
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => { cancelled = true; };
  }, [file.stage, projectId, selectedId]);

  const selectedSummary = useMemo(
    () => history?.versions.find((version) => version.id === selectedId) ?? null,
    [history, selectedId]
  );
  const preview = useMemo(
    () => readableVersionContent(selectedVersion?.content ?? ""),
    [selectedVersion?.content]
  );
  const restoreUnavailable = restoreDisabledReason || (!selectedSummary?.can_restore ? "当前已是这个版本" : null);

  async function handleRestore() {
    if (!history || !selectedId || restoreUnavailable) return;
    setRestoring(true);
    setError(null);
    try {
      const restored = await restoreFileVersion(
        projectId,
        file.stage,
        selectedId,
        history.current_content_hash
      );
      await onRestored(restored);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "版本恢复失败");
      setConfirming(false);
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="modal-backdrop file-version-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !restoring) onClose();
    }}>
      <div
        ref={dialogRef}
        className="file-version-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-version-title"
        tabIndex={-1}
      >
        <header className="file-version-header">
          <span className="file-version-mark" aria-hidden="true"><History size={20} /></span>
          <div>
            <span>版本记录</span>
            <h2 id="file-version-title">{file.name}</h2>
            <p>查看每次确定保存的内容，并可恢复到任意历史版本。</p>
          </div>
          <button type="button" aria-label="关闭版本记录" onClick={onClose} disabled={restoring}>
            <X size={18} />
          </button>
        </header>

        <div className="file-version-body">
          <aside className="file-version-list" aria-label="版本列表">
            {loading ? (
              <div className="file-version-state"><LoaderCircle className="spin" size={18} /><span>正在加载版本记录…</span></div>
            ) : history?.versions.length ? history.versions.map((version: FileVersionSummary) => (
              <button
                type="button"
                key={version.id}
                className={version.id === selectedId ? "selected" : ""}
                onClick={() => setSelectedId(version.id)}
              >
                <span className="file-version-list-heading">
                  <strong>V{version.version_number}</strong>
                  {version.is_current ? <em>当前</em> : null}
                </span>
                <span>{OPERATION_LABELS[version.operation] ?? OPERATION_LABELS.unknown}</span>
                <small>{formatVersionTime(version.created_at)} · {version.editor_name || "项目成员"}</small>
              </button>
            )) : (
              <div className="file-version-state"><span>暂无可查看的版本</span></div>
            )}
          </aside>

          <section className="file-version-preview">
            <div className="file-version-preview-heading">
              <div>
                <span>{selectedSummary ? `V${selectedSummary.version_number}` : "版本内容"}</span>
                <strong>{selectedSummary ? OPERATION_LABELS[selectedSummary.operation] ?? OPERATION_LABELS.unknown : "请选择版本"}</strong>
              </div>
              {selectedSummary ? <time>{formatVersionTime(selectedSummary.created_at)}</time> : null}
            </div>
            <div className="file-version-preview-content markdown-preview">
              {previewLoading ? (
                <div className="file-version-state"><LoaderCircle className="spin" size={18} /><span>正在加载内容…</span></div>
              ) : selectedVersion ? renderMarkdown(preview) : null}
            </div>
          </section>
        </div>

        <footer className="file-version-footer">
          <div className="file-version-footer-copy">
            {error ? <p className="file-version-error" role="alert">{error}</p> : (
              <p>每个文件最多保留最近 10 个版本。恢复后会新增一个版本，相关创作资料会在下次继续处理时更新。</p>
            )}
          </div>
          {confirming ? (
            <div className="file-version-confirm-actions">
              <span>确定恢复到 V{selectedSummary?.version_number}？</span>
              <button type="button" onClick={() => setConfirming(false)} disabled={restoring}>取消</button>
              <button type="button" className="primary-action" onClick={() => void handleRestore()} disabled={restoring}>
                {restoring ? <><LoaderCircle className="spin" size={14} />正在恢复…</> : "确定恢复"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="file-version-restore-action"
              disabled={!selectedSummary || Boolean(restoreUnavailable) || previewLoading}
              title={restoreUnavailable ?? "恢复到该版本"}
              onClick={() => setConfirming(true)}
            >
              <RotateCcw size={15} />
              恢复此版本
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
