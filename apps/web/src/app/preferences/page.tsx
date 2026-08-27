"use client";

import Link from "next/link";
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  CircleUserRound,
  Download,
  FilePenLine,
  FileText,
  BookOpenText,
  Globe2,
  Languages,
  ListTree,
  LogOut,
  Pencil,
  Plus,
  ScanSearch,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X
} from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmationDialog } from "@/components/workspace/project-trash-dialog";
import { PageLoading } from "@/components/ui/page-loading";
import {
  createWriterPreference,
  deleteWriterPreference,
  exportWriterPreferences,
  getMe,
  getWriterPreferences,
  importWriterPreferences,
  logout,
  reorderWriterPreferences,
  updateWriterPreference
} from "@/lib/api-client";
import { formatDateTime } from "@/lib/date-time";
import type {
  User,
  WriterPreference,
  WriterPreferenceBackupItem,
  WriterPreferenceImportMode,
  WriterPreferenceScope,
  WriterPreferenceScopeKey,
  WriterPreferencesPayload
} from "@/lib/types";


type ScopeFilter = "all" | WriterPreferenceScopeKey;
type StatusFilter = "all" | "enabled" | "disabled" | "ai";

const SCOPE_ICONS: Record<WriterPreferenceScopeKey, typeof Sparkles> = {
  global: Sparkles,
  novel_analysis: BookOpenText,
  world_view: Globe2,
  outline_rewrite: ListTree,
  character_rewrite: Users,
  trial_generate: FilePenLine,
  full_generate: FileText,
  dialogue_translate: Languages,
  foreign_review: ScanSearch,
  humanizer_zh: FilePenLine
};

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "enabled", label: "已启用" },
  { key: "disabled", label: "已停用" },
  { key: "ai", label: "AI 建议" }
];
const PREFERENCE_SCOPE_KEYS = new Set<WriterPreferenceScopeKey>([
  "novel_analysis", "world_view", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "dialogue_translate", "foreign_review", "humanizer_zh"
]);
const PREFERENCE_BACKUP_SCHEMA_VERSION = "1.0";
const MAX_PREFERENCE_BACKUP_FILE_BYTES = 1_000_000;

type PreferenceImportPreview = {
  schemaVersion: string;
  preferences: WriterPreferenceBackupItem[];
};


function scopeLabel(scopes: WriterPreferenceScope[], key: WriterPreferenceScopeKey) {
  return scopes.find((scope) => scope.key === key)?.name ?? key;
}


function preferenceSource(preference: WriterPreference) {
  if (preference.is_system_preference) {
    return { label: preference.can_edit_system_preference ? "由我创建的系统偏好" : "系统偏好", summaryJobId: null };
  }
  if (preference.source === "manual") {
    return { label: "本人手动添加", summaryJobId: null };
  }
  const evidence = preference.evidence ?? {};
  const projectName = typeof evidence.project_name === "string" ? evidence.project_name : "已归档项目";
  const refs = Array.isArray(evidence.evidence_refs) ? evidence.evidence_refs.length : 0;
  const summaryJobId = typeof evidence.summary_job_id === "number" ? evidence.summary_job_id : null;
  return {
    label: `归档项目「${projectName}」的偏好总结${refs ? ` · ${refs} 条手动输入或调整证据` : ""}`,
    summaryJobId
  };
}


function parsePreferenceBackup(value: unknown): PreferenceImportPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("请选择创作偏好导出的 JSON 文件");
  }
  const payload = value as Record<string, unknown>;
  if (payload.schema_version !== PREFERENCE_BACKUP_SCHEMA_VERSION) {
    throw new Error("该创作偏好备份版本暂不支持");
  }
  if (!Array.isArray(payload.preferences)) {
    throw new Error("备份文件缺少创作偏好列表");
  }
  const preferences = payload.preferences.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`第 ${index + 1} 条偏好格式不正确`);
    }
    const preference = item as Record<string, unknown>;
    if (
      typeof preference.content !== "string"
      || !Array.isArray(preference.scopes)
      || !preference.scopes.every((scope) => typeof scope === "string")
      || (preference.enabled !== undefined && typeof preference.enabled !== "boolean")
    ) {
      throw new Error(`第 ${index + 1} 条偏好格式不正确`);
    }
    return {
      content: preference.content,
      scopes: preference.scopes as WriterPreferenceScopeKey[],
      enabled: preference.enabled ?? true
    };
  });
  return { schemaVersion: payload.schema_version, preferences };
}


function preferenceBackupFileName(exportedAt: string) {
  const timestamp = exportedAt.replace(/[^0-9]/g, "").slice(0, 14);
  return `创作偏好-${timestamp || "备份"}.json`;
}


export default function PreferencesPage() {
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<WriterPreferencesPayload | null>(null);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<WriterPreference | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [editorScopes, setEditorScopes] = useState<WriterPreferenceScopeKey[]>(["global"]);
  const [editorEnabled, setEditorEnabled] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<WriterPreference | null>(null);
  const [sourceJobId, setSourceJobId] = useState<number | null>(null);
  const [importPreview, setImportPreview] = useState<PreferenceImportPreview | null>(null);
  const [importMode, setImportMode] = useState<WriterPreferenceImportMode>("append");
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const payload = await getWriterPreferences();
    setData(payload);
    return payload;
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getMe(), getWriterPreferences()])
      .then(([nextUser, payload]) => {
        if (cancelled) return;
        setUser(nextUser);
        setData(payload);
      })
      .catch(() => {
        window.location.href = "/?login=1";
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const requestedScope = search.get("scope");
    if (requestedScope === "global" || PREFERENCE_SCOPE_KEYS.has(requestedScope as WriterPreferenceScopeKey)) {
      setScopeFilter(requestedScope as WriterPreferenceScopeKey);
    }
    const requestedSourceJob = Number(search.get("source_job"));
    if (Number.isInteger(requestedSourceJob) && requestedSourceJob > 0) {
      setSourceJobId(requestedSourceJob);
      setStatusFilter("ai");
    }
  }, []);

  useEffect(() => {
    if (!data || scopeFilter === "all") return;
    window.requestAnimationFrame(() => document.getElementById(`scope-${scopeFilter}`)?.scrollIntoView({ block: "center" }));
  }, [data, scopeFilter]);

  useEffect(() => {
    if (!data || !sourceJobId) return;
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-source-job="${sourceJobId}"]`)?.scrollIntoView({ block: "center" });
    });
  }, [data, sourceJobId]);

  useEffect(() => {
    if (!editorOpen) return;
    window.requestAnimationFrame(() => editorTextareaRef.current?.focus());
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) setEditorOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, editorOpen]);

  const filteredPreferences = useMemo(() => {
    const preferences = data?.preferences ?? [];
    return preferences.filter((preference) => {
      if (scopeFilter !== "all" && !preference.scopes.includes(scopeFilter)) return false;
      if (statusFilter === "enabled" && !preference.enabled) return false;
      if (statusFilter === "disabled" && preference.enabled) return false;
      if (statusFilter === "ai" && preference.source !== "ai") return false;
      return true;
    });
  }, [data?.preferences, scopeFilter, statusFilter]);
  const editableFilteredPreferences = filteredPreferences.filter((item) => !item.is_system_preference);

  const activeCount = data?.preferences.filter((item) => item.enabled).length ?? 0;
  const ownedPreferenceCount = data?.preferences.filter((item) => !item.is_system_preference).length ?? 0;
  const currentScopeName = scopeFilter === "all"
    ? "全部偏好"
    : scopeLabel(data?.scopes ?? [], scopeFilter);

  function openCreateEditor() {
    setEditing(null);
    setEditorContent("");
    setEditorScopes(scopeFilter !== "all" ? [scopeFilter] : ["global"]);
    setEditorEnabled(true);
    setEditorOpen(true);
    setError(null);
    setNotice(null);
  }

  function openEditEditor(preference: WriterPreference) {
    setEditing(preference);
    setEditorContent(preference.content);
    setEditorScopes(preference.scopes);
    setEditorEnabled(preference.enabled);
    setEditorOpen(true);
    setError(null);
    setNotice(null);
  }

  function toggleEditorScope(scope: WriterPreferenceScopeKey) {
    if (scope === "global") {
      setEditorScopes(["global"]);
      return;
    }
    setEditorScopes((current) => {
      const withoutGlobal = current.filter((item) => item !== "global");
      return withoutGlobal.includes(scope)
        ? withoutGlobal.filter((item) => item !== scope)
        : [...withoutGlobal, scope];
    });
  }

  async function handleSavePreference() {
    const content = editorContent.trim();
    if (!content || !editorScopes.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const patch = {
          content,
          scopes: editorScopes
        };
        await updateWriterPreference(editing.id, editing.is_system_preference ? patch : {
          ...patch,
          enabled: editorEnabled
        });
      } else {
        await createWriterPreference({ content, scopes: editorScopes, enabled: editorEnabled });
      }
      await refresh();
      setEditorOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "偏好保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleTogglePreference(preference: WriterPreference) {
    setBusy(true);
    setError(null);
    try {
      const result = await updateWriterPreference(preference.id, { enabled: !preference.enabled });
      setData((current) => current ? {
        ...current,
        profile_revision: result.profile_revision,
        preferences: current.preferences.map((item) => item.id === preference.id ? result.preference : item)
      } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "偏好状态更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleMove(preference: WriterPreference, direction: -1 | 1) {
    if (!data || busy || preference.is_system_preference) return;
    const visibleIndex = editableFilteredPreferences.findIndex((item) => item.id === preference.id);
    const neighbor = editableFilteredPreferences[visibleIndex + direction];
    if (!neighbor) return;
    const reordered = data.preferences.filter((item) => !item.is_system_preference);
    const currentIndex = reordered.findIndex((item) => item.id === preference.id);
    const neighborIndex = reordered.findIndex((item) => item.id === neighbor.id);
    [reordered[currentIndex], reordered[neighborIndex]] = [reordered[neighborIndex], reordered[currentIndex]];
    const systemPreferences = data.preferences.filter((item) => item.is_system_preference);
    setData({ ...data, preferences: [...reordered.map((item, index) => ({ ...item, position: index })), ...systemPreferences] });
    setBusy(true);
    setError(null);
    try {
      setData(await reorderWriterPreferences(reordered.map((item) => item.id)));
    } catch (err) {
      await refresh();
      setError(err instanceof Error ? err.message : "偏好排序失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeletePreference() {
    if (!deleteTarget || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteWriterPreference(deleteTarget.id);
      await refresh();
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "偏好删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleExportPreferences() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const backup = await exportWriterPreferences();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = preferenceBackupFileName(backup.exported_at);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice(`已导出 ${backup.preferences.length} 条创作偏好`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创作偏好导出失败");
    } finally {
      setBusy(false);
    }
  }

  function openImportPicker() {
    if (!busy) importInputRef.current?.click();
  }

  async function handleImportFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busy) return;
    setError(null);
    setNotice(null);
    if (file.size > MAX_PREFERENCE_BACKUP_FILE_BYTES) {
      setError("创作偏好备份文件不能超过 1 MB");
      return;
    }
    try {
      const preview = parsePreferenceBackup(JSON.parse(await file.text()) as unknown);
      setImportPreview(preview);
      setImportMode("append");
    } catch (err) {
      setError(err instanceof Error ? err.message : "创作偏好备份读取失败");
    }
  }

  async function handleConfirmImport() {
    if (!importPreview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importWriterPreferences({
        schema_version: importPreview.schemaVersion,
        preferences: importPreview.preferences,
        mode: importMode
      });
      await refresh();
      setImportPreview(null);
      if (importMode === "replace") {
        setNotice(
          result.imported_count
            ? `已导入 ${result.imported_count} 条创作偏好，并替换原有 ${result.removed_count} 条偏好`
            : `已清空原有 ${result.removed_count} 条创作偏好`
        );
      } else if (result.imported_count) {
        setNotice(
          result.skipped_duplicate_count
            ? `已导入 ${result.imported_count} 条创作偏好，跳过 ${result.skipped_duplicate_count} 条重复偏好`
            : `已导入 ${result.imported_count} 条创作偏好`
        );
      } else {
        setNotice("没有新增偏好，备份中的内容已存在");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "创作偏好导入失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await logout();
    window.location.href = "/?login=1";
  }

  return (
    <main className="preferences-page">
      <header className="preferences-topbar">
        <Link className="preferences-brand" href="/workspace" aria-label="返回剧本工作台">
          <span className="brand-mark" aria-hidden="true">
            <img className="brand-logo" src="/logo.png" alt="" />
          </span>
          <strong>出海剧作家</strong>
        </Link>
        <span className="preferences-location">
          <Settings2 size={15} />
          创作偏好
        </span>
        <div className="preferences-account">
          <span className="avatar" aria-hidden="true">
            {user?.display_name?.[0] ?? user?.username?.[0] ?? "用"}
          </span>
          <span>{user?.display_name ?? user?.username ?? "用户"}</span>
          <button className="preferences-icon-button" type="button" onClick={() => void handleLogout()} title="退出登录" aria-label="退出登录">
            <LogOut size={16} />
          </button>
        </div>
      </header>

      <div className="preferences-workbench">
        <aside className="preferences-sidebar" aria-label="偏好层级">
          <Link className="preferences-back-link" href="/workspace">
            <ArrowLeft size={15} />
            返回工作台
          </Link>
          <nav className="preferences-scope-nav">
            <button
              id="scope-global"
              type="button"
              className={scopeFilter === "all" ? "active" : ""}
              onClick={() => setScopeFilter("all")}
            >
              <CircleUserRound size={17} />
              <span>全部偏好</span>
              <small>{data?.preferences.length ?? 0}</small>
            </button>
            {(data?.scopes ?? []).map((scope) => {
              const Icon = SCOPE_ICONS[scope.key];
              const count = data?.preferences.filter((item) => item.scopes.includes(scope.key)).length ?? 0;
              return (
                <button
                  id={`scope-${scope.key}`}
                  key={scope.key}
                  type="button"
                  className={scopeFilter === scope.key ? "active" : ""}
                  onClick={() => setScopeFilter(scope.key)}
                >
                  <Icon size={17} />
                  <span>{scope.name}</span>
                  <small>{count}</small>
                </button>
              );
            })}
          </nav>
          <div className="preferences-revision">
            <span>PROFILE</span>
            <strong>r{data?.profile_revision ?? 0}</strong>
            <small>{activeCount} 条启用</small>
          </div>
        </aside>

        <section className="preferences-main" aria-labelledby="preferences-title">
          <div className="preferences-toolbar">
            <div>
              <span>PERSONAL WRITER</span>
              <h1 id="preferences-title">{currentScopeName}</h1>
            </div>
            <div className="preferences-toolbar-actions">
              <input
                ref={importInputRef}
                className="preferences-import-input"
                type="file"
                accept="application/json,.json"
                aria-label="选择创作偏好备份文件"
                onChange={(event) => void handleImportFileChange(event)}
              />
              <button className="preferences-secondary-action" type="button" disabled={busy} onClick={openImportPicker}>
                <Upload size={16} />
                导入
              </button>
              <button className="preferences-secondary-action" type="button" disabled={busy} onClick={() => void handleExportPreferences()}>
                <Download size={16} />
                导出
              </button>
              <button className="preferences-primary-action" type="button" disabled={busy} onClick={openCreateEditor}>
                <Plus size={16} />
                新增偏好
              </button>
            </div>
          </div>

          <div className="preferences-filterbar">
            <div className="preferences-segmented" aria-label="状态筛选">
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  className={statusFilter === filter.key ? "active" : ""}
                  onClick={() => setStatusFilter(filter.key)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <span>{filteredPreferences.length} 条</span>
          </div>

          {error || notice ? (
            <div className="preferences-feedback">
              {error ? (
                <div className="preferences-error" role="alert">
                  <span>{error}</span>
                  <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示" title="关闭">
                    <X size={14} />
                  </button>
                </div>
              ) : null}
              {notice ? (
                <div className="preferences-notice" role="status">
                  <span>{notice}</span>
                  <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示" title="关闭">
                    <X size={14} />
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="preferences-list" aria-busy={loading || busy}>
            {loading ? <PageLoading label="正在加载创作偏好" /> : null}
            {!loading && !filteredPreferences.length ? (
              <div className="preferences-empty">
                <Settings2 size={24} />
                <strong>当前范围暂无偏好</strong>
                <button type="button" disabled={busy} onClick={openCreateEditor}>
                  <Plus size={14} />
                  新增偏好
                </button>
              </div>
            ) : null}
            {filteredPreferences.map((preference) => {
              const source = preferenceSource(preference);
              const canEditSystemPreference = preference.is_system_preference && preference.can_edit_system_preference;
              return (
              <article
                data-source-job={source.summaryJobId ?? undefined}
                key={preference.id}
                className={`preference-row${preference.enabled ? "" : " disabled"}${preference.is_system_preference ? " system" : ""}${canEditSystemPreference ? " system-editable" : ""}${source.summaryJobId === sourceJobId ? " highlighted" : ""}`}
              >
                <div className="preference-leading-control">
                  <button
                    className="preference-switch"
                    type="button"
                    role="switch"
                    aria-checked={preference.enabled}
                    aria-label={preference.enabled ? "停用偏好" : "启用偏好"}
                    title={preference.enabled ? "停用" : "启用"}
                    disabled={busy}
                    onClick={() => void handleTogglePreference(preference)}
                  >
                    <span />
                  </button>
                  {preference.is_system_preference ? <span className="preference-system-marker">系统</span> : null}
                </div>
                <div className="preference-copy">
                  <p>{preference.content}</p>
                  <div className="preference-origin">
                    {preference.is_system_preference ? <Settings2 size={13} /> : preference.source === "ai" ? <Archive size={13} /> : <CircleUserRound size={13} />}
                    <span>来源：{source.label}</span>
                  </div>
                  <div className="preference-meta">
                    <span className={`preference-source ${preference.source}`}>
                      {preference.is_system_preference ? "系统偏好" : preference.source === "ai" ? "归档总结" : "手动添加"}
                    </span>
                    {preference.scopes.map((scope) => (
                      <span key={scope}>{scopeLabel(data?.scopes ?? [], scope)}</span>
                    ))}
                    <span>v{preference.version}</span>
                    <time>{formatDateTime(preference.updated_at, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
                  </div>
                </div>
                <div className={`preference-actions${canEditSystemPreference ? " system-editable-actions" : ""}`}>
                  {!preference.is_system_preference ? <>
                  <button
                    type="button"
                    disabled={busy || editableFilteredPreferences.findIndex((item) => item.id === preference.id) === 0}
                    onClick={() => void handleMove(preference, -1)}
                    title="上移"
                    aria-label="上移偏好"
                  >
                    <ChevronUp size={15} />
                  </button>
                  <button
                    type="button"
                    disabled={busy || editableFilteredPreferences.findIndex((item) => item.id === preference.id) === editableFilteredPreferences.length - 1}
                    onClick={() => void handleMove(preference, 1)}
                    title="下移"
                    aria-label="下移偏好"
                  >
                    <ChevronDown size={15} />
                  </button>
                  <button type="button" disabled={busy} onClick={() => openEditEditor(preference)} title="编辑" aria-label="编辑偏好">
                    <Pencil size={14} />
                  </button>
                  <button type="button" disabled={busy} onClick={() => setDeleteTarget(preference)} title="删除" aria-label="删除偏好">
                    <Trash2 size={14} />
                  </button>
                  </> : null}
                  {canEditSystemPreference ? <button type="button" disabled={busy} onClick={() => openEditEditor(preference)} title="编辑系统偏好" aria-label="编辑系统偏好">
                    <Pencil size={14} />
                  </button> : null}
                </div>
              </article>
              );
            })}
          </div>
        </section>
      </div>

      {editorOpen ? (
        <div className="modal-backdrop preference-editor-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) setEditorOpen(false);
        }}>
          <form
            className="preference-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preference-editor-title"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSavePreference();
            }}
          >
            <div className="preference-editor-heading">
              <div>
                <span>{editing ? editing.is_system_preference ? "SYSTEM PREFERENCE" : `VERSION ${editing.version}` : "NEW RULE"}</span>
                <h2 id="preference-editor-title">{editing ? editing.is_system_preference ? "编辑系统偏好" : "编辑创作偏好" : "新增创作偏好"}</h2>
              </div>
              <button type="button" onClick={() => setEditorOpen(false)} disabled={busy} aria-label="关闭" title="关闭">
                <X size={17} />
              </button>
            </div>
            <label className="preference-editor-field">
              <span>偏好内容</span>
              <textarea
                ref={editorTextareaRef}
                value={editorContent}
                maxLength={data?.limits.max_content_chars ?? 2000}
                onChange={(event) => setEditorContent(event.target.value)}
              />
              <small>{editorContent.length} / {data?.limits.max_content_chars ?? 2000}</small>
            </label>
            <fieldset className="preference-scope-fieldset">
              <legend>适用范围</legend>
              <div className="preference-scope-options">
                {(data?.scopes ?? []).map((scope: WriterPreferenceScope) => {
                  const checked = editorScopes.includes(scope.key);
                  return (
                    <label key={scope.key} className={checked ? "checked" : ""}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleEditorScope(scope.key)}
                      />
                      <span>{scope.name}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            {!editing?.is_system_preference ? <label className="preference-enabled-field">
              <input
                type="checkbox"
                checked={editorEnabled}
                onChange={(event) => setEditorEnabled(event.target.checked)}
              />
              <span>启用</span>
            </label> : null}
            <div className="preference-editor-actions">
              <button className="cancel-action" type="button" onClick={() => setEditorOpen(false)} disabled={busy}>取消</button>
              <button
                className="save-action"
                type="submit"
                disabled={busy || !editorContent.trim() || !editorScopes.length}
              >
                {busy ? "保存中" : "保存偏好"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {importPreview ? (
        <div className="modal-backdrop preference-editor-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) setImportPreview(null);
        }}>
          <section className="preference-import-dialog" role="dialog" aria-modal="true" aria-labelledby="preference-import-title">
            <div className="preference-editor-heading">
              <div>
                <span>导入备份</span>
                <h2 id="preference-import-title">导入创作偏好</h2>
              </div>
              <button type="button" onClick={() => setImportPreview(null)} disabled={busy} aria-label="关闭" title="关闭">
                <X size={17} />
              </button>
            </div>
            <div className="preference-import-summary">
              <p>已读取 {importPreview.preferences.length} 条创作偏好，导入后将按备份中的顺序排列。</p>
              <div>
                <span>备份内容<strong>{importPreview.preferences.length} 条</strong></span>
                <span>当前偏好<strong>{ownedPreferenceCount} 条</strong></span>
              </div>
            </div>
            <fieldset className="preference-import-mode-fieldset">
              <legend>导入方式</legend>
              <label className={importMode === "append" ? "checked" : ""}>
                <input
                  type="radio"
                  name="preference-import-mode"
                  checked={importMode === "append"}
                  disabled={busy}
                  onChange={() => {
                    setImportMode("append");
                    setError(null);
                  }}
                />
                <span>
                  <strong>追加到现有偏好</strong>
                  <small>保留现有内容，已存在的相同偏好会自动跳过</small>
                </span>
              </label>
              <label className={importMode === "replace" ? "checked" : ""}>
                <input
                  type="radio"
                  name="preference-import-mode"
                  checked={importMode === "replace"}
                  disabled={busy}
                  onChange={() => {
                    setImportMode("replace");
                    setError(null);
                  }}
                />
                <span>
                  <strong>替换现有偏好</strong>
                  <small>移除当前所有偏好，仅保留备份内容</small>
                </span>
              </label>
            </fieldset>
            {importMode === "replace" && ownedPreferenceCount > 0 ? (
              <p className="preference-import-warning">确认后，当前的 {ownedPreferenceCount} 条创作偏好将被替换。</p>
            ) : null}
            {error ? <p className="preference-import-error" role="alert">{error}</p> : null}
            <div className="preference-editor-actions">
              <button className="cancel-action" type="button" disabled={busy} onClick={() => setImportPreview(null)}>取消</button>
              <button className="save-action" type="button" disabled={busy} onClick={() => void handleConfirmImport()}>
                {busy ? "导入中" : "确认导入"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <ConfirmationDialog
          title="删除这条创作偏好？"
          description="删除后，新建的 Agent 任务将不再读取这条规则。此操作无法撤销。"
          confirmLabel="删除偏好"
          tone="danger"
          busy={busy}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void handleDeletePreference()}
        />
      ) : null}
    </main>
  );
}
