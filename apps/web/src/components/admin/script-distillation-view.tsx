"use client";

import {
  BookOpenText,
  Boxes,
  ChevronLeft,
  ChevronRight,
  FileSearch,
  LayoutGrid,
  Library,
  Lightbulb,
  List,
  LoaderCircle,
  PencilLine,
  RefreshCcw,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  UploadCloud,
  X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import {
  deleteAdminScriptLibraryScript,
  deleteAdminScriptFormula,
  getAdminScriptFormulas,
  getAdminScriptLibrary,
  getAdminScriptLibraryScript,
  getAdminScriptSource,
  retryAdminScriptDistillation,
  updateAdminScriptLibraryScript,
  uploadAdminScripts
} from "@/lib/admin-api";
import type {
  ScriptFormulaCard,
  ScriptFormulaPayload,
  ScriptLibraryPayload,
  ScriptLibraryScript,
  ScriptLibraryStatus,
  ScriptLibraryTagKind,
  ScriptSourceChunk
} from "@/lib/admin-types";
import { formatDateTime } from "@/lib/date-time";
import { PageLoading } from "@/components/ui/page-loading";
import styles from "./admin.module.css";

type LibraryMode = "scripts" | "formulas" | "principles";
type DetailTab = "case" | "formulas" | "principles" | "source";
type DistillationDrawer = "script" | "formula";

const TAG_LABELS: Record<ScriptLibraryTagKind, string> = {
  theme: "主题",
  setting: "设定",
  background: "背景",
  audience: "受众"
};

const STATUS_LABELS: Record<ScriptLibraryStatus, string> = {
  queued: "等待蒸馏",
  processing: "正在蒸馏",
  ready: "已入库",
  failed: "蒸馏失败"
};

const FORMULA_LABELS: Record<string, string> = {
  story_engine: "故事运行公式",
  world_rule: "世界规则公式",
  character_relationship: "人物关系公式",
  long_arc: "长线结构公式",
  episode_structure: "单集结构公式",
  hook_information: "钩子与信息公式",
  audience_payoff: "观众回报公式",
  emotional_progression: "情绪推进公式",
  scene_conflict: "场景冲突公式",
  dialogue_action: "对白行动公式",
  principle: "创作原则",
  core: "故事运行公式",
  world: "世界规则公式",
  gratification: "观众回报公式",
  mechanism: "创作原则"
};
const CREATIVE_STAGE_LABELS: Record<string, string> = {
  global: "全流程",
  novel_analysis: "小说解读",
  world_view: "世界观",
  outline_rewrite: "故事梗概",
  character_rewrite: "人物小传",
  trial_generate: "剧本试稿",
  full_generate: "剧本全稿",
  dialogue_translate: "台词翻译",
  foreign_review: "海外审稿"
};

const PRINCIPLE_STATUS_LABELS = {
  candidate: "待验证",
  active: "已验证"
} as const;

const SCRIPT_STATUS_KEYS: ScriptLibraryStatus[] = ["queued", "processing", "ready", "failed"];
const CARD_STATUS_KEYS = ["active", "candidate"] as const;

function cardCategory(card: ScriptFormulaCard) {
  return card.category || card.formula_type || (card.card_kind === "principle" ? "principle" : "story_engine");
}

function isPrinciple(card: ScriptFormulaCard) {
  return card.card_kind === "principle" || cardCategory(card) === "principle" || card.formula_type === "mechanism";
}

function cardStatusLabel(card: ScriptFormulaCard) {
  if (isPrinciple(card)) return card.status === "active" ? PRINCIPLE_STATUS_LABELS.active : PRINCIPLE_STATUS_LABELS.candidate;
  return card.status === "active" ? "已验证" : "待更多案例";
}

function creativeStageLabel(stage: string) {
  return CREATIVE_STAGE_LABELS[stage] ?? stage;
}

function scriptSourceLabel(script: ScriptLibraryScript) {
  if (script.source_type === "manual") return "手动上传";
  if (script.source_type === "project_archive") return script.source_label || "项目归档";
  return "剧本库导入";
}

function sourceCountLabel(card: ScriptFormulaCard) {
  return `关联 ${formatNumber(card.source_count)} 部剧本`;
}

type RelatedScript = { id?: number; title: string };

function relatedScripts(card: ScriptFormulaCard): RelatedScript[] {
  if (card.source_scripts?.length) return card.source_scripts;
  return card.source_script_titles.map((title) => ({ title }));
}

function RelatedScriptList({
  card,
  onOpenScript,
  compact = false
}: {
  card: ScriptFormulaCard;
  onOpenScript?: (scriptId: number) => void;
  compact?: boolean;
}) {
  const scripts = relatedScripts(card);
  const visible = scripts.slice(0, compact ? 2 : 3);
  const hiddenCount = Math.max(0, scripts.length - visible.length);
  return (
    <div className={`${styles.formulaAssociations} ${compact ? styles.formulaAssociationsCompact : ""}`}>
      <div className={styles.formulaAssociationsHeader}>
        <span>关联剧本</span><strong>{sourceCountLabel(card)}</strong>
      </div>
      <div className={styles.formulaAssociationNames}>
        {visible.map((script, index) => script.id && onOpenScript ? (
          <button type="button" key={`${script.id}-${script.title}`} onClick={() => onOpenScript(script.id!)} title={`查看剧本：${script.title}`}>
            {script.title}
          </button>
        ) : <span key={`${script.title}-${index}`}>{script.title}</span>)}
        {hiddenCount ? <small>另有 {formatNumber(hiddenCount)} 部</small> : null}
        {!scripts.length ? <small>暂无关联剧本</small> : null}
      </div>
    </div>
  );
}

const BACKGROUND_ERA_TAGS = new Set(["现代", "古代", "年代", "民国"]);

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDate(value: string) {
  return formatDateTime(value, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function recordArray(value: unknown) {
  return arrayValue(value).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
}

function StatusBadge({ status }: { status: ScriptLibraryStatus }) {
  const icon = status === "processing" ? <LoaderCircle size={11} className={styles.spinIcon} /> : null;
  return <span className={`${styles.badge} ${styles[`job_${status === "processing" ? "running" : status === "ready" ? "succeeded" : status}`]}`}>{icon}{STATUS_LABELS[status]}</span>;
}

function DistillationProgress({ script, compact = false }: { script: ScriptLibraryScript; compact?: boolean }) {
  if (script.status === "ready") return null;
  const progress = script.distillation_progress;
  const label = script.status === "queued" ? "等待处理" : progress?.label || STATUS_LABELS[script.status];
  const message = progress?.message || (script.status === "failed" ? script.error_message : "");
  return (
    <div className={`${styles.distillationProgress} ${compact ? styles.distillationProgressCompact : ""}`}>
      <div><span>{label}</span>{progress?.total ? <strong>{progress.percent}%</strong> : null}</div>
      {progress?.total ? <span className={styles.distillationProgressTrack}><i style={{ width: `${progress.percent}%` }} /></span> : null}
      {message ? <small>{message}</small> : null}
    </div>
  );
}

function pageItems(page: number, totalPages: number): Array<number | string> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (page <= 4) return [1, 2, 3, 4, "end-gap", totalPages];
  if (page >= totalPages - 3) return [1, "start-gap", totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  return [1, "start-gap", page - 1, page, page + 1, "end-gap", totalPages];
}

function DistillationPagination({
  page,
  totalPages,
  onChange
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  const [targetPage, setTargetPage] = useState("");

  function jump() {
    const parsed = Number.parseInt(targetPage, 10);
    if (!Number.isFinite(parsed)) return;
    onChange(Math.min(totalPages, Math.max(1, parsed)));
    setTargetPage("");
  }

  return (
    <nav className={styles.distillationPagination} aria-label="分页">
      <button className={styles.paginationArrow} disabled={page <= 1} onClick={() => onChange(page - 1)} title="上一页" aria-label="上一页"><ChevronLeft size={16} /></button>
      <div className={styles.paginationPages}>
        {pageItems(page, totalPages).map((item) => typeof item === "number" ? (
          <button key={item} className={item === page ? styles.paginationPageActive : styles.paginationPage} onClick={() => onChange(item)} aria-current={item === page ? "page" : undefined}>{item}</button>
        ) : <span key={item}>…</span>)}
      </div>
      <button className={styles.paginationArrow} disabled={page >= totalPages} onClick={() => onChange(page + 1)} title="下一页" aria-label="下一页"><ChevronRight size={16} /></button>
      <div className={styles.paginationJump}>
        <span>跳至</span>
        <input value={targetPage} onChange={(event) => setTargetPage(event.target.value.replace(/\D/g, ""))} onKeyDown={(event) => { if (event.key === "Enter") jump(); }} inputMode="numeric" placeholder="页码" aria-label="跳转页码" />
      </div>
    </nav>
  );
}

function TagList({ values, kind }: { values: string[]; kind?: ScriptLibraryTagKind }) {
  return (
    <span className={styles.distillationTagList}>
      {values.map((value) => <span key={`${kind ?? "tag"}-${value}`} data-kind={kind}>{value}</span>)}
      {!values.length ? <small>未标注</small> : null}
    </span>
  );
}

export function AdminScriptDistillationView({ onNotice }: { onNotice: (message: string) => void }) {
  const [mode, setMode] = useState<LibraryMode>("scripts");
  const [payload, setPayload] = useState<ScriptLibraryPayload | null>(null);
  const [formulas, setFormulas] = useState<ScriptFormulaCard[]>([]);
  const [formulaPayload, setFormulaPayload] = useState<ScriptFormulaPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ScriptLibraryStatus | "">("");
  const [tagFilters, setTagFilters] = useState<Partial<Record<ScriptLibraryTagKind, string>>>({});
  const [page, setPage] = useState(1);
  const [formulaPage, setFormulaPage] = useState(1);
  const [formulaStage, setFormulaStage] = useState("");
  const [formulaStatus, setFormulaStatus] = useState<"candidate" | "active" | "">("");
  const [principleStage, setPrincipleStage] = useState("");
  const [principleStatus, setPrincipleStatus] = useState<"candidate" | "active" | "">("");
  const [formulaTagFilters, setFormulaTagFilters] = useState<Partial<Record<ScriptLibraryTagKind, string>>>({});
  const [formulaLayout, setFormulaLayout] = useState<"cards" | "list">("cards");
  const [selectedFormula, setSelectedFormula] = useState<ScriptFormulaCard | null>(null);
  const [selected, setSelected] = useState<ScriptLibraryScript | null>(null);
  const [drawerOrder, setDrawerOrder] = useState<DistillationDrawer[]>([]);
  const [detailTab, setDetailTab] = useState<DetailTab>("case");
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftTags, setDraftTags] = useState<Record<ScriptLibraryTagKind, string[]>>({ theme: [], setting: [], background: [], audience: [] });
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceChunks, setSourceChunks] = useState<ScriptSourceChunk[]>([]);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadDragActive, setUploadDragActive] = useState(false);
  const [uploadRejected, setUploadRejected] = useState<Array<{ filename: string; message: string }>>([]);

  const loadScripts = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const result = await getAdminScriptLibrary({
        query,
        status: statusFilter || undefined,
        tags: tagFilters,
        page
      });
      setPayload(result);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "剧本库加载失败");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [onNotice, page, query, statusFilter, tagFilters]);

  const loadCards = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAdminScriptFormulas({
        cardKind: mode === "principles" ? "principle" : "formula",
        stage: mode === "principles" ? principleStage || undefined : formulaStage || undefined,
        status: mode === "principles" ? principleStatus || undefined : formulaStatus || undefined,
        query,
        tags: formulaTagFilters,
        page: formulaPage
      });
      setFormulas(result.formulas);
      setFormulaPayload(result);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : mode === "principles" ? "创作原则加载失败" : "公式卡加载失败");
    } finally {
      setLoading(false);
    }
  }, [formulaPage, formulaStage, formulaStatus, formulaTagFilters, mode, onNotice, principleStage, principleStatus, query]);

  useEffect(() => {
    if (mode === "scripts") void loadScripts();
    else void loadCards();
  }, [loadCards, loadScripts, mode]);

  useEffect(() => {
    if (!payload?.stats.processing) return;
    const timer = window.setInterval(() => void loadScripts(true), 6000);
    return () => window.clearInterval(timer);
  }, [loadScripts, payload?.stats.processing]);

  function bringDrawerToFront(drawer: DistillationDrawer) {
    setDrawerOrder((current) => [...current.filter((item) => item !== drawer), drawer]);
  }

  function closeDrawer(drawer: DistillationDrawer) {
    if (drawer === "script") setSelected(null);
    else setSelectedFormula(null);
    setDrawerOrder((current) => current.filter((item) => item !== drawer));
  }

  async function openScript(scriptId: number) {
    try {
      const result = await getAdminScriptLibraryScript(scriptId);
      setSelected(result.script);
      bringDrawerToFront("script");
      setDetailTab("case");
      setEditing(false);
      setDraftTitle(result.script.title);
      setDraftTags(Object.fromEntries(
        (Object.keys(TAG_LABELS) as ScriptLibraryTagKind[]).map((kind) => [kind, [...result.script.tags[kind]]])
      ) as Record<ScriptLibraryTagKind, string[]>);
      setSourceQuery("");
      setSourceChunks([]);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "剧本详情加载失败");
    }
  }

  async function handleUpload(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true);
    try {
      const result = await uploadAdminScripts(files);
      const rejected = result.rejected?.length ?? 0;
      onNotice(`${result.scripts.length} 个剧本已进入蒸馏队列${rejected ? `，${rejected} 个文件未上传` : ""}`);
      setUploadRejected(result.rejected ?? []);
      if (rejected) {
        const rejectedNames = new Set(result.rejected.map((item) => item.filename));
        setUploadFiles((current) => current.filter((file) => rejectedNames.has(file.name)));
      } else {
        setUploadOpen(false);
        setUploadFiles([]);
      }
      setPage(1);
      await loadScripts(true);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "剧本上传失败");
    } finally {
      setBusy(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  function addUploadFiles(files: File[]) {
    setUploadRejected([]);
    const allowed = new Set([".pdf", ".doc", ".docx", ".md", ".markdown", ".txt"]);
    const next = files.filter((file) => allowed.has(file.name.slice(file.name.lastIndexOf(".")).toLowerCase()));
    setUploadFiles((current) => {
      const merged = [...current, ...next];
      const seen = new Set<string>();
      return merged.filter((file) => {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 20);
    });
  }

  function handleUploadDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setUploadDragActive(false);
    addUploadFiles(Array.from(event.dataTransfer.files ?? []));
  }

  async function saveMetadata() {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const result = await updateAdminScriptLibraryScript(selected.id, { title: draftTitle.trim(), tags: draftTags });
      setSelected(result.script);
      setEditing(false);
      onNotice("剧本标签已保存");
      await loadScripts(true);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "剧本标签保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function retry(scriptId: number) {
    setBusy(true);
    try {
      const result = await retryAdminScriptDistillation(scriptId);
      setSelected(result.script);
      bringDrawerToFront("script");
      setDetailTab("case");
      onNotice("已从上次完成的阶段继续蒸馏");
      await loadScripts(true);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "继续蒸馏失败");
    } finally {
      setBusy(false);
    }
  }

  async function remove(script: ScriptLibraryScript) {
    if (!window.confirm(`确认从剧本库删除「${script.title}」？`) || busy) return;
    setBusy(true);
    try {
      await deleteAdminScriptLibraryScript(script.id);
      closeDrawer("script");
      onNotice("剧本已删除");
      await loadScripts(true);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "剧本删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function removeFormula(formula: ScriptFormulaCard) {
    const cardLabel = isPrinciple(formula) ? "创作原则" : "公式卡";
    if (!window.confirm(`确认删除${cardLabel}「${formula.title}」？`) || busy) return;
    setBusy(true);
    try {
      await deleteAdminScriptFormula(formula.id);
      closeDrawer("formula");
      onNotice(`${cardLabel}已删除`);
      await Promise.all([loadCards(), loadScripts(true)]);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : `${cardLabel}删除失败`);
    } finally {
      setBusy(false);
    }
  }

  function openFormula(formula: ScriptFormulaCard) {
    setSelectedFormula(formula);
    bringDrawerToFront("formula");
  }

  async function searchSource() {
    if (!selected) return;
    try {
      const result = await getAdminScriptSource(selected.id, sourceQuery);
      setSourceChunks(result.chunks);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "原文检索失败");
    }
  }

  function toggleDraftTag(kind: ScriptLibraryTagKind, value: string) {
    setDraftTags((current) => {
      const selectedValues = current[kind];
      if (selectedValues.includes(value)) {
        return { ...current, [kind]: selectedValues.filter((item) => item !== value) };
      }
      const limit = kind === "audience" ? 1 : 4;
      const availableValues = kind === "background" && BACKGROUND_ERA_TAGS.has(value)
        ? selectedValues.filter((item) => !BACKGROUND_ERA_TAGS.has(item))
        : selectedValues;
      return { ...current, [kind]: kind === "audience" ? [value] : [...availableValues, value].slice(0, limit) };
    });
  }

  const caseCard = selected?.case_card ?? {};
  const storyEngine = (caseCard.story_engine && typeof caseCard.story_engine === "object" ? caseCard.story_engine : {}) as Record<string, unknown>;
  const characters = recordArray(caseCard.characters ?? caseCard.character_arcs);
  const narrativePhases = recordArray(caseCard.narrative_phases ?? caseCard.key_turning_points);
  const worldRules = recordArray(caseCard.world_rules);
  const relationshipDynamics = recordArray(caseCard.relationship_dynamics);
  const audiencePayoffs = recordArray(caseCard.audience_payoffs);
  const keyObservations = recordArray(caseCard.key_observations);
  const sourceSpecificTerms = arrayValue(caseCard.source_specific_terms).filter((item): item is string => typeof item === "string");
  const activeFilters = Boolean(statusFilter || Object.values(tagFilters).some(Boolean));
  const activeFormulaFilters = mode === "principles"
    ? Boolean(principleStage || principleStatus)
    : Boolean(formulaStage || formulaStatus || Object.values(formulaTagFilters).some(Boolean));
  const metrics = payload?.stats;
  const currentCardLabel = mode === "principles" ? "创作原则" : "公式卡";
  const formulaFilterCounts = formulaPayload?.filter_counts;
  const topDrawer = drawerOrder.at(-1);
  const scriptDrawerLayer = 100 + Math.max(0, drawerOrder.indexOf("script"));
  const formulaDrawerLayer = 100 + Math.max(0, drawerOrder.indexOf("formula"));
  const emptyCardMessage = mode === "principles"
    ? "暂无创作原则，完成跨剧本审核后会在此集中展示。"
    : "暂无公式卡，完成新一轮剧本蒸馏后会按公式归并展示，剧本只作为关联案例。";
  const canSaveMetadata = Boolean(draftTitle.trim() && (Object.keys(TAG_LABELS) as ScriptLibraryTagKind[]).every((kind) => draftTags[kind].length));

  return (
    <div className={`${styles.view} ${styles.distillationView}`}>
      <section className={styles.viewToolbar}>
        <div className={styles.distillationTabRow}>
          <div className={`${styles.segmented} ${styles.libraryModeSwitch}`}>
            <button className={mode === "scripts" ? styles.segmentedActive : ""} onClick={() => { setMode("scripts"); setPage(1); }}><Library size={14} />剧本 <strong className={styles.libraryModeCount}>{formatNumber(metrics?.total ?? 0)}</strong></button>
            <button className={mode === "formulas" ? styles.segmentedActive : ""} onClick={() => { setMode("formulas"); setFormulaPage(1); }}><Boxes size={14} />公式卡 <strong className={styles.libraryModeCount}>{formatNumber(metrics?.formula_cards ?? 0)}</strong></button>
            <button className={mode === "principles" ? styles.segmentedActive : ""} onClick={() => { setMode("principles"); setFormulaPage(1); }}><Lightbulb size={14} />创作原则 <strong className={styles.libraryModeCount}>{formatNumber(metrics?.principle_cards ?? 0)}</strong></button>
          </div>
          <div className={styles.toolbarRight}>
            {mode === "scripts" ? <>
              <button className={styles.primaryButton} onClick={() => setUploadOpen(true)} disabled={busy}>{busy ? <LoaderCircle size={15} className={styles.spinIcon} /> : <Upload size={15} />}上传剧本</button>
            </> : <div className={`${styles.segmented} ${styles.layoutSwitch}`} aria-label={`${currentCardLabel}预览方式`}><button className={formulaLayout === "cards" ? styles.segmentedActive : ""} onClick={() => setFormulaLayout("cards")} title="卡片模式" aria-label="卡片模式"><LayoutGrid size={14} /></button><button className={formulaLayout === "list" ? styles.segmentedActive : ""} onClick={() => setFormulaLayout("list")} title="列表模式" aria-label="列表模式"><List size={14} /></button></div>}
            <button className={styles.iconButton} onClick={() => mode === "scripts" ? void loadScripts() : void loadCards()} title="刷新" aria-label="刷新"><RefreshCcw size={14} /></button>
          </div>
        </div>
        <div className={styles.distillationFilterRow}>
          <div className={styles.distillationFilterSide}>
            <label className={`${styles.searchBox} ${styles.librarySearch}`}><Search size={14} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); setFormulaPage(1); }} placeholder={mode === "scripts" ? "搜索剧名或摘要" : `搜索${currentCardLabel}`} /></label>
            {mode === "scripts" ? <select className={`${styles.toolbarFilterSelect} ${styles.distillationStatusSelect}`} value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as ScriptLibraryStatus | ""); setPage(1); }}><option value="">全部状态（{formatNumber(metrics?.status_counts?.all ?? 0)}）</option>{SCRIPT_STATUS_KEYS.map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}（{formatNumber(metrics?.status_counts?.[value] ?? 0)}）</option>)}</select> : mode === "formulas" ? <>
              <select className={styles.principleFilterSelect} value={formulaStage} onChange={(event) => { setFormulaStage(event.target.value); setFormulaPage(1); }}><option value="">全部适用阶段（{formatNumber(formulaFilterCounts?.stage?.all ?? 0)}）</option>{Object.entries(CREATIVE_STAGE_LABELS).filter(([value]) => value !== "global").map(([value, label]) => <option key={value} value={value}>{label}（{formatNumber(formulaFilterCounts?.stage?.[value] ?? 0)}）</option>)}</select>
              <select className={styles.principleFilterSelect} value={formulaStatus} onChange={(event) => { setFormulaStatus(event.target.value as "candidate" | "active" | ""); setFormulaPage(1); }}><option value="">全部验证状态（{formatNumber(formulaFilterCounts?.status?.all ?? 0)}）</option>{CARD_STATUS_KEYS.map((value) => <option key={value} value={value}>{value === "active" ? "已验证" : "待更多案例"}（{formatNumber(formulaFilterCounts?.status?.[value] ?? 0)}）</option>)}</select>
            </> : <>
              <select className={styles.principleFilterSelect} value={principleStage} onChange={(event) => { setPrincipleStage(event.target.value); setFormulaPage(1); }}><option value="">全部适用阶段（{formatNumber(formulaFilterCounts?.stage?.all ?? 0)}）</option>{Object.entries(CREATIVE_STAGE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}（{formatNumber(formulaFilterCounts?.stage?.[value] ?? 0)}）</option>)}</select>
              <select className={styles.principleFilterSelect} value={principleStatus} onChange={(event) => { setPrincipleStatus(event.target.value as "candidate" | "active" | ""); setFormulaPage(1); }}><option value="">全部验证状态（{formatNumber(formulaFilterCounts?.status?.all ?? 0)}）</option>{Object.entries(PRINCIPLE_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}（{formatNumber(formulaFilterCounts?.status?.[value] ?? 0)}）</option>)}</select>
            </>}
          </div>
          <div className={styles.distillationFilterSide}>
            {mode !== "principles" ? <><span className={styles.toolbarFilterLabel}>标签筛选</span>
            {(Object.keys(TAG_LABELS) as ScriptLibraryTagKind[]).map((kind) => (
              <select key={kind} className={styles.toolbarFilterSelect} value={(mode === "scripts" ? tagFilters : formulaTagFilters)[kind] ?? ""} onChange={(event) => {
                if (mode === "scripts") { setTagFilters((current) => ({ ...current, [kind]: event.target.value })); setPage(1); }
                else { setFormulaTagFilters((current) => ({ ...current, [kind]: event.target.value })); setFormulaPage(1); }
              }}>
                <option value="">全部{TAG_LABELS[kind]}</option>
                {(mode === "scripts" ? (payload?.facets[kind] ?? []) : (formulaPayload?.facets[kind] ?? [])).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            ))}</> : null}
            <button className={styles.distillationClear} disabled={mode === "scripts" ? !activeFilters : !activeFormulaFilters} onClick={() => { if (mode === "scripts") { setStatusFilter(""); setTagFilters({}); setPage(1); } else if (mode === "formulas") { setFormulaStage(""); setFormulaStatus(""); setFormulaTagFilters({}); setFormulaPage(1); } else { setPrincipleStage(""); setPrincipleStatus(""); setFormulaPage(1); } }}><RotateCcw size={13} />重置筛选</button>
          </div>
        </div>
      </section>

      {loading ? <PageLoading label="正在读取剧本库" /> : mode === "scripts" ? (
        <>
          <div className={styles.tableWrap}>
            <table className={`${styles.table} ${styles.distillationTable}`}>
              <thead><tr><th>剧本</th><th>主题 / 设定</th><th>背景</th><th>受众</th><th>篇幅</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead>
              <tbody>
                {(payload?.scripts ?? []).map((script) => (
                  <tr key={script.id}>
                    <td><button className={styles.distillationTitle} onClick={() => void openScript(script.id)}>{script.title}</button><small className={styles.cellSub}>{scriptSourceLabel(script)}</small></td>
                    <td><TagList values={[...script.tags.theme, ...script.tags.setting].slice(0, 4)} /></td>
                    <td><TagList kind="background" values={script.tags.background.slice(0, 2)} /></td>
                    <td><TagList kind="audience" values={script.tags.audience.slice(0, 2)} /></td>
                    <td><span className={styles.mono}>{formatNumber(script.chars)} 字</span>{script.episode_count ? <small className={styles.cellSub}>{script.episode_count} 集</small> : null}</td>
                    <td><StatusBadge status={script.status} /><DistillationProgress script={script} compact /></td>
                    <td><time>{formatDate(script.updated_at)}</time></td>
                    <td><div className={styles.rowActions}><button className={styles.iconButton} onClick={() => void openScript(script.id)} title="查看" aria-label="查看"><FileSearch size={14} /></button>{script.retryable ? <button className={styles.iconButton} onClick={() => void retry(script.id)} title="继续蒸馏" aria-label="继续蒸馏"><RefreshCcw size={14} /></button> : null}<button className={styles.iconButtonDanger} onClick={() => void remove(script)} disabled={script.status === "processing"} title="删除" aria-label="删除"><Trash2 size={14} /></button></div></td>
                  </tr>
                ))}
                {!payload?.scripts.length ? <tr><td colSpan={8} className={styles.emptyCell}>暂无符合条件的剧本</td></tr> : null}
              </tbody>
            </table>
          </div>
          <DistillationPagination page={page} totalPages={payload?.pagination.total_pages ?? 1} onChange={setPage} />
        </>
      ) : (
        <>
          {formulaLayout === "list" ? (
            <div className={`${styles.tableWrap} ${styles.formulaTableWrap}`}>
              <table className={`${styles.table} ${styles.formulaTable} ${mode === "principles" ? styles.principleTable : ""}`}>
                <thead><tr><th>序号</th>{mode === "principles" ? <><th>创作原则</th><th>关联剧本</th><th>适用阶段</th><th>验证状态</th><th>整理来源</th><th>操作</th></> : <><th>适用阶段</th><th>使用场景</th><th>公式名称</th><th>关联剧本</th><th>验证状态</th><th>操作</th></>}</tr></thead>
                <tbody>
                  {formulas.map((formula, index) => (
                    <tr key={formula.id}>
                      <td className={styles.formulaIndex}>{(formulaPage - 1) * (formulaPayload?.pagination.page_size ?? formulas.length) + index + 1}</td>
                      {mode === "principles" ? <>
                        <td><strong className={styles.formulaTableTitle}>{formula.title}</strong><p className={styles.formulaExcerpt}>{formula.description}</p></td>
                        <td><RelatedScriptList card={formula} onOpenScript={(scriptId) => void openScript(scriptId)} compact /></td>
                        <td><TagList values={formula.stages.map(creativeStageLabel).slice(0, 5)} /></td>
                        <td><span className={`${styles.formulaTypeLabel} ${styles.formulaType_mechanism}`}>{cardStatusLabel(formula)}</span></td>
                        <td><span className={styles.formulaOriginLabel}>{formula.origin === "script-distillation" ? "剧本蒸馏" : "知识库整理"}</span><small className={styles.cellSub}>第 {formula.revision} 版</small></td>
                      </> : <>
                        <td><TagList values={formula.stages.map(creativeStageLabel)} /></td>
                        <td><p className={styles.formulaScenario}>{formula.usage_scenario || formula.description}</p></td>
                        <td><strong className={styles.formulaTableTitle}>{formula.title}</strong><p className={styles.formulaCoreFormula}>{formula.core_formula}</p></td>
                        <td><RelatedScriptList card={formula} onOpenScript={(scriptId) => void openScript(scriptId)} compact /></td>
                        <td><span className={styles.formulaTypeLabel}>{cardStatusLabel(formula)}</span></td>
                      </>}
                      <td><div className={styles.rowActions}><button className={styles.iconButton} onClick={() => openFormula(formula)} title="查看" aria-label="查看"><FileSearch size={14} /></button><button className={styles.iconButtonDanger} onClick={() => void removeFormula(formula)} disabled={busy} title="删除" aria-label="删除"><Trash2 size={14} /></button></div></td>
                    </tr>
                  ))}
                  {!formulas.length ? <tr><td colSpan={7} className={styles.emptyCell}>{activeFormulaFilters ? `暂无符合条件的${currentCardLabel}` : emptyCardMessage}</td></tr> : null}
                </tbody>
              </table>
            </div>
          ) : <div className={styles.formulaGrid}>
            {formulas.map((formula) => (
              <article key={formula.id} className={styles.formulaCard} data-type={cardCategory(formula)}>
                <header><span>{FORMULA_LABELS[cardCategory(formula)] ?? "公式"}</span><small>{cardStatusLabel(formula)}</small></header>
                <div className={styles.formulaCardMain}><h3>{formula.title}</h3>{!isPrinciple(formula) ? <p>{formula.usage_scenario || formula.description}</p> : <p>{formula.description}</p>}</div>
                {isPrinciple(formula) ? (
                  <div className={styles.formulaCardDetails}>
                    <p><b>适用阶段：</b>{formula.stages.map(creativeStageLabel).join("、") || "未指定"}</p>
                    <p><b>成立原因：</b>{stringValue(formula.content.rationale)}</p>
                  </div>
                ) : <div className={styles.formulaCardDetails}><p><b>适用阶段：</b>{formula.stages.map(creativeStageLabel).join("、")}</p><p><b>核心公式：</b>{formula.core_formula}</p></div>}
                <RelatedScriptList card={formula} onOpenScript={(scriptId) => void openScript(scriptId)} />
                <footer className={isPrinciple(formula) ? styles.formulaCardFooterActionOnly : undefined}>{!isPrinciple(formula) ? <TagList values={formula.applicable_tags.slice(0, 5)} /> : null}<button type="button" className={styles.formulaCardOpen} onClick={() => openFormula(formula)}><FileSearch size={13} />查看详情</button></footer>
              </article>
            ))}
            {!formulas.length ? <div className={styles.distillationEmpty}>{activeFormulaFilters ? `暂无符合条件的${currentCardLabel}` : emptyCardMessage}</div> : null}
          </div>}
          <DistillationPagination page={formulaPage} totalPages={formulaPayload?.pagination.total_pages ?? 1} onChange={setFormulaPage} />
        </>
      )}

      {selectedFormula ? (
        <div className={styles.distillationDetailBackdrop} data-drawer="formula" aria-hidden={topDrawer !== "formula"} style={{ zIndex: formulaDrawerLayer }} onMouseDown={() => !busy && closeDrawer("formula")}>
          <section className={`${styles.distillationDetail} ${styles.formulaDetail}`} role="dialog" aria-modal={topDrawer === "formula"} aria-label={`${isPrinciple(selectedFormula) ? "创作原则" : "公式卡"}详情`} onMouseDown={(event) => event.stopPropagation()}>
            <header className={styles.distillationDetailHeader}>
              <div><span className={`${styles.formulaTypeLabel} ${styles[`formulaType_${cardCategory(selectedFormula)}`]}`}>{FORMULA_LABELS[cardCategory(selectedFormula)] ?? "公式"}</span><h2>{selectedFormula.title}</h2><p>{cardStatusLabel(selectedFormula)}</p></div>
              <button className={styles.iconButton} onClick={() => closeDrawer("formula")} title="关闭" aria-label="关闭"><X size={16} /></button>
            </header>
            <div className={styles.distillationDetailBody}>
              <section className={styles.formulaDetailSection}><span>{isPrinciple(selectedFormula) ? "原则说明" : "使用场景"}</span><p>{isPrinciple(selectedFormula) ? selectedFormula.description : selectedFormula.usage_scenario || selectedFormula.description}</p></section>
              {isPrinciple(selectedFormula) ? <div className={styles.principleDetailGrid}>
                <section className={styles.formulaDetailSection}><span>适用阶段</span><TagList values={selectedFormula.stages.map(creativeStageLabel)} /></section>
                <section className={styles.formulaDetailSection}><span>成立原因</span><p>{stringValue(selectedFormula.content.rationale)}</p></section>
                <section className={styles.formulaDetailSection}><span>适用条件</span><ul>{arrayValue(selectedFormula.content.applies_when).map((item, index) => <li key={index}>{String(item)}</li>)}</ul></section>
                <section className={styles.formulaDetailSection}><span>例外与失效情况</span><ul>{arrayValue(selectedFormula.content.fails_or_changes_when).map((item, index) => <li key={index}>{String(item)}</li>)}</ul></section>
                <section className={`${styles.formulaDetailSection} ${styles.principleReviewSection}`}><span>审核标准</span><ul>{arrayValue(selectedFormula.content.review_criteria).map((item, index) => <li key={index}>{String(item)}</li>)}</ul></section>
              </div> : <>
                <section className={styles.formulaDetailSection}><span>适用阶段</span><TagList values={selectedFormula.stages.map(creativeStageLabel)} /></section>
                <section className={styles.formulaDetailSection}><span>不适用情况</span><ul>{selectedFormula.not_applicable.map((item, index) => <li key={index}>{item}</li>)}</ul></section>
                <section className={styles.formulaDetailSection}><span>创作目标</span><p>{stringValue(selectedFormula.content.goal)}</p></section>
                <section className={`${styles.formulaDetailSection} ${styles.formulaCoreSection}`}><span>核心公式</span><strong>{selectedFormula.core_formula}</strong></section>
                <section className={styles.formulaDetailSection}><span>使用前确认</span><ul>{arrayValue(selectedFormula.content.conditions).map((item, index) => <li key={index}>{String(item)}</li>)}</ul></section>
                <section className={styles.formulaDetailSection}><span>可替换内容</span><TagList values={arrayValue(selectedFormula.content.variables).map(String)} /></section>
                <section className={styles.formulaDetailSection}><span>使用方法</span><ol>{selectedFormula.usage_guidance.map((step, index) => <li key={index}>{step}</li>)}</ol></section>
                <section className={styles.formulaDetailSection}><span>生效原因</span><p>{stringValue(selectedFormula.content.mechanism)}</p></section>
                <section className={styles.formulaDetailSection}><span>完成标准</span><ul>{selectedFormula.completion_criteria.map((item, index) => <li key={index}>{item}</li>)}</ul></section>
                <section className={styles.formulaDetailSection}><span>常见失效方式</span><ul>{arrayValue(selectedFormula.content.failure_modes).map((item, index) => <li key={index}>{String(item)}</li>)}</ul></section>
                <section className={styles.formulaDetailSection}><span>改写与新创作</span><p><b>改写：</b>{stringValue(selectedFormula.content.rewrite_usage)}</p><p><b>新创作：</b>{stringValue(selectedFormula.content.original_usage)}</p></section>
                <section className={styles.formulaDetailSection}><span>题材适配</span>{recordArray(selectedFormula.content.genre_adaptations).map((adaptation, index) => <article key={index} className={styles.formulaAdaptation}><strong>{arrayValue(adaptation.tags).join("、")}</strong><p>{stringValue(adaptation.difference)}</p><p><b>用法调整：</b>{stringValue(adaptation.usage_adjustment)}</p><p><b>边界调整：</b>{stringValue(adaptation.boundary_adjustment)}</p></article>)}</section>
                <section className={styles.formulaDetailSection}><span>适用标签</span><TagList values={selectedFormula.applicable_tags} /></section>
              </>}
              <section className={styles.formulaDetailSection}><RelatedScriptList card={selectedFormula} onOpenScript={(scriptId) => void openScript(scriptId)} /></section>
            </div>
            <footer className={styles.distillationDetailFooter}><button className={styles.dangerButton} onClick={() => void removeFormula(selectedFormula)} disabled={busy}><Trash2 size={14} />删除</button><button className={styles.secondaryButton} onClick={() => closeDrawer("formula")}>关闭</button></footer>
          </section>
        </div>
      ) : null}

      {selected ? (
        <div className={styles.distillationDetailBackdrop} data-drawer="script" aria-hidden={topDrawer !== "script"} style={{ zIndex: scriptDrawerLayer }} onMouseDown={() => !busy && closeDrawer("script")}>
          <section className={styles.distillationDetail} role="dialog" aria-modal={topDrawer === "script"} aria-label="剧本蒸馏详情" onMouseDown={(event) => event.stopPropagation()}>
            <header className={styles.distillationDetailHeader}>
              <div><StatusBadge status={selected.status} /><h2>{selected.title}</h2><p>{formatNumber(selected.chars)} 字{selected.episode_count ? ` · ${selected.episode_count} 集` : ""} · {scriptSourceLabel(selected)}</p></div>
              <div className={styles.rowActions}>
                {selected.status === "ready" ? <button className={styles.iconButton} onClick={() => setEditing((value) => !value)} title="编辑标签" aria-label="编辑标签"><PencilLine size={15} /></button> : null}
                <button className={styles.iconButton} onClick={() => closeDrawer("script")} title="关闭" aria-label="关闭"><X size={16} /></button>
              </div>
            </header>

            {editing ? (
              <div className={styles.distillationEditor}>
                <label><span>剧本名称</span><input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} /></label>
                {(Object.keys(TAG_LABELS) as ScriptLibraryTagKind[]).map((kind) => (
                  <div key={kind} className={styles.distillationTagEditor}>
                    <span>{TAG_LABELS[kind]}<small>{draftTags[kind].length}/{kind === "audience" ? 1 : 4}</small></span>
                    <div>
                      {(payload?.taxonomy[kind] ?? []).map((value) => {
                        const active = draftTags[kind].includes(value);
                        const full = kind !== "audience" && draftTags[kind].length >= 4;
                        return <button type="button" key={value} data-active={active} disabled={!active && full} onClick={() => toggleDraftTag(kind, value)}>{value}</button>;
                      })}
                    </div>
                  </div>
                ))}
                <div className={styles.distillationEditorActions}><button className={styles.secondaryButton} onClick={() => setEditing(false)}>取消</button><button className={styles.primaryButton} onClick={() => void saveMetadata()} disabled={busy || !canSaveMetadata}>保存</button></div>
              </div>
            ) : (
              <div className={styles.distillationTagMatrix}>
                {(Object.keys(TAG_LABELS) as ScriptLibraryTagKind[]).map((kind) => <div key={kind}><span>{TAG_LABELS[kind]}</span><TagList kind={kind} values={selected.tags[kind]} /></div>)}
              </div>
            )}

            <nav className={styles.distillationDetailTabs}>
              <button data-active={detailTab === "case"} onClick={() => setDetailTab("case")}><BookOpenText size={14} />案例卡</button>
              <button data-active={detailTab === "formulas"} onClick={() => setDetailTab("formulas")}><Boxes size={14} />公式卡</button>
              <button data-active={detailTab === "principles"} onClick={() => setDetailTab("principles")}><Lightbulb size={14} />创作原则</button>
              <button data-active={detailTab === "source"} onClick={() => setDetailTab("source")}><FileSearch size={14} />原文索引</button>
            </nav>

            <div className={styles.distillationDetailBody}>
              {selected.status === "failed" ? <div className={styles.distillationFailure}><strong>{selected.retryable ? "蒸馏未完成" : "原文暂不可用"}</strong><p>{selected.error_message}</p>{selected.retryable ? <button className={styles.primaryButton} onClick={() => void retry(selected.id)} disabled={busy}><RefreshCcw size={14} />继续蒸馏</button> : null}</div> : null}
              {selected.status === "queued" || selected.status === "processing" ? <div className={styles.distillationPending}><LoaderCircle size={22} className={styles.spinIcon} /><strong>{selected.status === "queued" ? "等待处理" : selected.distillation_progress?.label || STATUS_LABELS.processing}</strong><DistillationProgress script={selected} /></div> : null}
              {selected.status === "ready" && detailTab === "case" ? (
                <div className={styles.caseCardLayout}>
                  <section className={styles.caseLead}><span>一句话故事</span><strong>{stringValue(caseCard.logline) || selected.summary}</strong><p>{stringValue(caseCard.audience_promise)}</p></section>
                  <div className={styles.caseFieldGrid}>
                    {[ ["故事开始", "initial_situation"], ["主角目标", "protagonist_goal"], ["主要阻力", "main_resistance"], ["失败代价", "stakes"], ["冲突循环", "repeatable_conflict_loop"], ["结局变化", "ending_change"] ].map(([label, key]) => <section key={key}><span>{label}</span><p>{stringValue(storyEngine[key]) || "待补充"}</p></section>)}
                  </div>
                  {worldRules.length ? <section className={styles.caseSequence}><h3>世界运行方式</h3>{worldRules.map((rule, index) => <article key={index}><header><strong>{stringValue(rule.rule) || `规则 ${index + 1}`}</strong></header><p>{stringValue(rule.story_function)}</p><small>资源或限制：{stringValue(rule.resource_or_limit)}　违反代价：{stringValue(rule.violation_cost)}</small></article>)}</section> : null}
                  {characters.length ? <section className={styles.caseSequence}><h3>主要人物</h3>{characters.map((character, index) => <article key={`${stringValue(character.name)}-${index}`}><header><strong>{stringValue(character.name) || `人物 ${index + 1}`}</strong><span>{stringValue(character.dramatic_function)}</span></header><p>{stringValue(character.initial_state)} → {stringValue(character.turning_action)} → {stringValue(character.final_state)}</p><small>欲望：{stringValue(character.desire)}　筹码：{stringValue(character.leverage)}</small></article>)}</section> : null}
                  {relationshipDynamics.length ? <section className={styles.caseSequence}><h3>关系变化</h3>{relationshipDynamics.map((relationship, index) => <article key={index}><header><strong>{arrayValue(relationship.parties).join("、")}</strong></header><p>{stringValue(relationship.change_chain)}</p><small>{stringValue(relationship.initial_power)} → {stringValue(relationship.final_state)}</small></article>)}</section> : null}
                  {narrativePhases.length ? <section className={styles.caseSequence}><h3>叙事阶段</h3>{narrativePhases.map((phase, index) => <article key={`${stringValue(phase.phase)}-${index}`}><header><strong>{stringValue(phase.phase) || `阶段 ${index + 1}`}</strong></header><p>{stringValue(phase.goal)}；阻力：{stringValue(phase.opposition)}</p><small>{stringValue(phase.irreversible_change)}　观众回报：{stringValue(phase.audience_return)}</small></article>)}</section> : null}
                  {audiencePayoffs.length ? <section className={styles.caseSequence}><h3>观众回报</h3>{audiencePayoffs.map((payoff, index) => <article key={index}><header><strong>{stringValue(payoff.payoff_type)}</strong></header><p>{stringValue(payoff.setup)} → {stringValue(payoff.pressure)} → {stringValue(payoff.release)}</p><small>{stringValue(payoff.story_consequence)}</small></article>)}</section> : null}
                  {keyObservations.length ? <section className={styles.caseSequence}><h3>关键写法观察</h3>{keyObservations.map((observation, index) => <article key={index}><header><strong>{stringValue(observation.observation_id)}</strong><span>{stringValue(observation.stage)}</span></header><p>{stringValue(observation.author_choice)}</p><small>{stringValue(observation.story_change)}　边界：{stringValue(observation.tradeoff_or_boundary)}</small></article>)}</section> : null}
                  {sourceSpecificTerms.length ? <section className={styles.signatureElements}><strong>原文专属词</strong><TagList values={sourceSpecificTerms} /></section> : null}
                  {arrayValue(caseCard.strengths).length ? <section className={styles.signatureElements}><strong>值得学习的地方</strong><p>{arrayValue(caseCard.strengths).join("；")}</p></section> : null}
                  <section className={styles.originalityBoundary}><strong>案例局限</strong><p>{arrayValue(caseCard.limitations).join("；") || "暂无补充"}</p></section>
                </div>
              ) : null}
              {selected.status === "ready" && detailTab === "formulas" ? (
                <div className={styles.detailFormulaList}>
                  {(selected.formula_cards ?? []).map((formula) => <article className={styles.detailKnowledgeCard} key={formula.id}><button type="button" className={styles.detailKnowledgeCardAction} onClick={() => openFormula(formula)}><span>{formula.stages.map(creativeStageLabel).join("、") || FORMULA_LABELS[cardCategory(formula)] || "公式"}</span><h3>{formula.title}</h3><p>{formula.usage_scenario || formula.description}</p><small>核心公式：{formula.core_formula}</small></button><RelatedScriptList card={formula} compact /></article>)}
                  {!selected.formula_cards?.length ? <p className={styles.distillationEmpty}>本剧没有新增或关联公式候选{stringValue(selected.distillation_result?.no_formula_reason) ? `：${stringValue(selected.distillation_result?.no_formula_reason)}` : ""}</p> : null}
                </div>
              ) : null}
              {selected.status === "ready" && detailTab === "principles" ? (
                <div className={styles.principleList}>
                  <h3>本剧关联的创作原则</h3>
                  {(selected.principle_cards ?? []).map((principle) => <button type="button" className={styles.detailPrincipleCard} key={principle.id} onClick={() => openFormula(principle)}><strong>{principle.title}</strong><p>{principle.description}</p><p><b>适用阶段：</b>{principle.stages.map(creativeStageLabel).join("、")}</p><p><b>成立原因：</b>{stringValue(principle.content.rationale)}</p><small><b>适用边界：</b>{arrayValue(principle.content.fails_or_changes_when).join("；")}</small></button>)}
                  {!selected.principle_cards?.length ? <p className={styles.distillationEmpty}>本剧没有新增或关联创作原则{stringValue(selected.distillation_result?.no_principle_reason) ? `：${stringValue(selected.distillation_result?.no_principle_reason)}` : ""}</p> : null}
                </div>
              ) : null}
              {selected.status === "ready" && detailTab === "source" ? (
                <div className={styles.sourceIndexView}>
                  <div className={styles.sourceSearch}><label className={styles.searchBox}><Search size={14} /><input value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void searchSource()} placeholder="搜索原文" /></label><button className={styles.primaryButton} onClick={() => void searchSource()}>检索</button></div>
                  {(sourceChunks.length ? sourceChunks : (selected.source_index ?? []).map((item) => ({ ...item, content: item.preview }))).map((chunk) => <article key={chunk.id}><header><strong>{chunk.id}</strong><span>{chunk.locator}</span></header><p>{chunk.content}</p></article>)}
                </div>
              ) : null}
            </div>

            <footer className={styles.distillationDetailFooter}>
              <button className={styles.dangerButton} onClick={() => void remove(selected)} disabled={busy || selected.status === "processing"}><Trash2 size={14} />删除</button>
              <button className={styles.secondaryButton} onClick={() => closeDrawer("script")}>关闭</button>
            </footer>
          </section>
        </div>
      ) : null}

      {uploadOpen ? (
        <div className={styles.dialogBackdrop} role="presentation" onMouseDown={() => !busy && setUploadOpen(false)}>
          <section className={`${styles.dialog} ${styles.scriptUploadDialog}`} role="dialog" aria-modal="true" aria-label="上传剧本" onMouseDown={(event) => event.stopPropagation()}>
            <header className={styles.dialogHeader}>
              <div><h2>上传剧本</h2><p className={styles.dialogText}>上传后将自动整理并进入蒸馏队列。</p></div>
              <button className={styles.iconButton} onClick={() => setUploadOpen(false)} disabled={busy} title="关闭" aria-label="关闭"><X size={16} /></button>
            </header>
            <div className={styles.scriptUploadBody}>
              <div
                className={`${styles.scriptUploadDropzone} ${uploadDragActive ? styles.scriptUploadDropzoneActive : ""}`}
                onDragOver={(event) => { event.preventDefault(); setUploadDragActive(true); }}
                onDragLeave={() => setUploadDragActive(false)}
                onDrop={handleUploadDrop}
              >
                <input ref={uploadRef} className={styles.hiddenInput} type="file" accept=".pdf,.doc,.docx,.md,.markdown,.txt" multiple onChange={(event) => { addUploadFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
                <UploadCloud size={30} />
                <strong>拖动剧本到这里，或点击选择文件</strong>
                <span>支持 PDF、DOC、DOCX、Markdown、TXT，可一次选择多个文件</span>
                <button type="button" className={styles.secondaryButton} onClick={() => uploadRef.current?.click()} disabled={busy}><Upload size={14} />选择文件</button>
              </div>
              <div className={styles.scriptUploadQueue}>
                <div className={styles.scriptUploadQueueHeader}><strong>待上传文件</strong><span>{uploadFiles.length}/20</span><button type="button" className={styles.textButton} onClick={() => setUploadFiles([])} disabled={!uploadFiles.length || busy}>清空</button></div>
                {uploadFiles.length ? <ul>{uploadFiles.map((file) => <li key={`${file.name}:${file.size}:${file.lastModified}`}><span>{file.name}</span><small>{file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`}</small></li>)}</ul> : <p className={styles.scriptUploadEmpty}>尚未选择剧本</p>}
                {uploadRejected.length ? <div className={styles.scriptUploadRejected} role="alert">{uploadRejected.map((item) => <p key={`${item.filename}:${item.message}`}><strong>{item.filename}</strong><span>{item.message}</span></p>)}</div> : null}
              </div>
            </div>
            <footer className={`${styles.dialogActions} ${styles.scriptUploadActions}`}>
              <button className={styles.secondaryButton} onClick={() => { setUploadOpen(false); setUploadRejected([]); }} disabled={busy}>取消</button>
              <button className={styles.primaryButton} onClick={() => void handleUpload(uploadFiles)} disabled={busy || !uploadFiles.length}>{busy ? <LoaderCircle size={14} className={styles.spinIcon} /> : <Sparkles size={14} />}开始蒸馏</button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
