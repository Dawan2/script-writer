"use client";

import {
  ChevronDown,
  Coins,
  FileCheck2,
  LockKeyhole,
  Send,
  SlidersHorizontal,
  UploadCloud,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent } from "react";
import { ScenarioSelect } from "@/components/workspace/scenario-select";
import { DEFAULT_MATURITY_TARGET, MATURITY_TARGET_OPTIONS } from "@/lib/maturity-targets";
import { PROJECT_SCENARIOS } from "@/lib/project-scenarios";
import type { CreditConcurrency, CreditPrice, Project, ProjectInitialization, ScriptTagTaxonomy, TargetRegion } from "@/lib/types";

const AUTO_ADAPT = "自动适配";
const BACKGROUND_ERA_TAGS = new Set(["现代", "古代", "年代", "民国"]);
const SCRIPT_PROFILE_FIELDS = ["audience", "theme", "background", "setting"] as const;
type ScriptProfileField = typeof SCRIPT_PROFILE_FIELDS[number];
type ProductionBriefField = "episode_duration" | "target_episode_count" | "maturity_target";

type NewProjectFormProps = {
  busy: boolean;
  error?: string | null;
  regions: TargetRegion[];
  scriptTagTaxonomy: ScriptTagTaxonomy;
  creditPrices?: CreditPrice[];
  creditBalance?: number | null;
  creditsManaged?: boolean;
  concurrency?: CreditConcurrency;
  allowedScenarioKeys?: readonly Project["task_type"][];
  variant?: "create" | "regenerate";
  initialValues?: ProjectInitialization | null;
  onCancel: () => void;
  onSubmit: (formData: FormData) => void;
};

type ReleaseBriefFields = {
  episode_duration: string;
  target_episode_count: string;
  maturity_target: string;
  theme: string[];
  setting: string[];
  background: string[];
  audience: string[];
};

const EMPTY_RELEASE_BRIEF: ReleaseBriefFields = {
  episode_duration: "90 秒",
  target_episode_count: "35",
  maturity_target: DEFAULT_MATURITY_TARGET,
  theme: [AUTO_ADAPT],
  setting: [AUTO_ADAPT],
  background: [AUTO_ADAPT],
  audience: [AUTO_ADAPT]
};

function releaseBriefDefaults(initialValues?: ProjectInitialization | null): ReleaseBriefFields {
  const initial = initialValues?.brief;
  const initialMaturityTarget = initial?.maturity_target;
  return {
    episode_duration: initial?.episode_duration ?? EMPTY_RELEASE_BRIEF.episode_duration,
    target_episode_count: initial?.target_episode_count === null || initial?.target_episode_count === undefined
      ? EMPTY_RELEASE_BRIEF.target_episode_count
      : String(initial.target_episode_count),
    maturity_target: initialMaturityTarget && MATURITY_TARGET_OPTIONS.some((option) => option.value === initialMaturityTarget)
      ? initialMaturityTarget
      : EMPTY_RELEASE_BRIEF.maturity_target,
    theme: initial?.theme?.length ? initial.theme : [AUTO_ADAPT],
    setting: initial?.setting?.length ? initial.setting : [AUTO_ADAPT],
    background: initial?.background?.length ? initial.background : [AUTO_ADAPT],
    audience: initial?.audience?.length ? initial.audience : [AUTO_ADAPT]
  };
}

type ScriptTagPickerProps = {
  field: ScriptProfileField;
  label: string;
  options: string[];
  selected: string[];
  disabled: boolean;
  open: boolean;
  single?: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (value: string) => void;
};

function ScriptTagPicker({ field, label, options, selected, disabled, open, single = false, onOpenChange, onToggle }: ScriptTagPickerProps) {
  const pickerRef = useRef<HTMLDetailsElement>(null);
  const summary = selected.join("、") || AUTO_ADAPT;
  const atLimit = !single && !selected.includes(AUTO_ADAPT) && selected.length >= 4;

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) onOpenChange(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  return (
    <div className="new-project-distribution-field">
      <span>{label}</span>
      <input type="hidden" name={field} value={selected.join(",")} />
      <details
        ref={pickerRef}
        className="new-project-tag-picker"
        open={open}
        onToggle={(event) => {
          if (event.currentTarget.open !== open) onOpenChange(event.currentTarget.open);
        }}
      >
        <summary aria-label={`选择${label}`} aria-disabled={disabled} onClick={(event) => {
          if (disabled) event.preventDefault();
        }}>
          <span title={summary}>{summary}</span>
          <ChevronDown size={15} aria-hidden="true" />
        </summary>
        <div className="new-project-tag-options" role="group" aria-label={`${label}选项`}>
          {[AUTO_ADAPT, ...options].map((option) => {
            const checked = selected.includes(option);
            const conflictsWithSelectedEra = field === "background"
              && BACKGROUND_ERA_TAGS.has(option)
              && selected.some((value) => value !== option && BACKGROUND_ERA_TAGS.has(value));
            const optionDisabled = disabled || (!checked && option !== AUTO_ADAPT && (atLimit || conflictsWithSelectedEra));
            return (
              <label key={option}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={optionDisabled}
                  onChange={() => {
                    onToggle(option);
                    if (single || option === AUTO_ADAPT) onOpenChange(false);
                  }}
                />
                <span>{option}</span>
              </label>
            );
          })}
        </div>
      </details>
    </div>
  );
}

function projectNameFromFile(file: File | null) {
  if (!file) return "未命名剧本";
  return file.name.replace(/\.[^.]+$/, "").trim() || "未命名剧本";
}

function fileSizeLabel(file: File) {
  if (file.size < 1024 * 1024) return `${Math.max(1, Math.round(file.size / 1024))} KB`;
  return `${(file.size / 1024 / 1024).toFixed(1)} MB`;
}

export function NewProjectForm({
  busy,
  error,
  regions,
  scriptTagTaxonomy,
  creditPrices,
  creditBalance,
  creditsManaged = false,
  concurrency,
  allowedScenarioKeys,
  variant = "create",
  initialValues,
  onCancel,
  onSubmit
}: NewProjectFormProps) {
  const regenerating = variant === "regenerate";
  const scenarioOptions = useMemo(() => {
    if (!allowedScenarioKeys) return PROJECT_SCENARIOS;
    const allowed = new Set(allowedScenarioKeys);
    return PROJECT_SCENARIOS.filter((scenario) => allowed.has(scenario.key));
  }, [allowedScenarioKeys]);
  const [taskType, setTaskType] = useState<ProjectInitialization["task_type"]>(initialValues?.task_type ?? scenarioOptions[0]?.key ?? "rewrite");
  const [extraRequirements, setExtraRequirements] = useState(initialValues?.extra_requirements ?? "");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(regenerating);
  const [openTagPicker, setOpenTagPicker] = useState<ScriptProfileField | null>(null);
  const initialRegion = useMemo(
    () => regions.find((region) => region.key === initialValues?.target_region) ?? regions[0],
    [initialValues?.target_region, regions]
  );
  const [regionKey, setRegionKey] = useState(initialRegion?.key ?? "");
  const selectedRegion = regions.find((region) => region.key === regionKey) ?? initialRegion;
  const regionOptions = useMemo(
    () => regions.map((region) => ({ key: region.key, label: region.key })),
    [regions]
  );
  const [releaseBrief, setReleaseBrief] = useState<ReleaseBriefFields>(() => releaseBriefDefaults(initialValues));
  const existingSourceName = regenerating ? initialValues?.source.display_name : "";
  const projectName = regenerating
    ? initialValues?.project_name ?? "未命名剧本"
    : projectNameFromFile(sourceFile);
  const hasRequiredInput = !!(sourceFile || existingSourceName) && !!selectedRegion && !busy;
  const isReviewTask = taskType === "review";
  const isNovelTask = taskType === "novel";
  const isReplicationTask = taskType === "replicate";
  const isTranslateTask = taskType === "translate";
  const isHumanizeTask = taskType === "humanize";
  const hasScriptProfile = taskType === "rewrite" || taskType === "novel" || taskType === "replicate";
  const initialGenerationStage = !regenerating
    ? (isNovelTask ? "novel_analysis" : isReviewTask ? "foreign_review" : isTranslateTask ? "dialogue_translate" : isHumanizeTask ? "humanizer_zh" : null)
    : null;
  const initialGenerationCreditCost = initialGenerationStage
    ? creditPrices?.find((item) => item.stage === initialGenerationStage)?.credits ?? null
    : null;
  const creditInsufficient = Boolean(creditsManaged && initialGenerationCreditCost !== null && creditBalance !== null && creditBalance !== undefined && creditBalance < initialGenerationCreditCost);
  const concurrencyReached = Boolean(initialGenerationStage && concurrency?.reached);
  const canSubmit = hasRequiredInput && !creditInsufficient;
  const taskRequirementLabel = isReviewTask
    ? "说明本次审核重点"
    : isNovelTask
      ? "补充小说改编要求（可选）"
    : isReplicationTask
      ? "补充新剧本的创作要求（可选）"
    : isTranslateTask
      ? "补充翻译要求（可选）"
      : isHumanizeTask
        ? "补充润色要求（可选）"
        : "补充改写要求";
  const sourceLabel = isNovelTask ? "原始小说" : isReplicationTask ? "爆款分析报告" : isReviewTask ? "待审剧本" : isTranslateTask ? "待翻译剧本" : isHumanizeTask ? "待润色剧本" : "原始剧本";
  const sourceUploadLabel = `上传${sourceLabel}`;
  const sourceUploadHint = isReviewTask
    ? "拖拽完整剧本到这里，或点击图标/文字选择文件"
    : isNovelTask ? "拖拽完整小说到这里，或点击图标/文字选择文件"
    : isReplicationTask ? "拖拽爆款分析报告到这里，或点击图标/文字选择文件"
    : isTranslateTask ? "拖拽待翻译剧本到这里，或点击图标/文字选择文件"
      : isHumanizeTask ? "拖拽待润色剧本到这里，或点击图标/文字选择文件"
      : "拖拽原始剧本到这里，或点击图标/文字选择文件";

  useEffect(() => {
    if (!regions.length) return;
    if (!regions.some((region) => region.key === regionKey)) {
      setRegionKey(initialRegion?.key ?? regions[0].key);
    }
  }, [initialRegion, regionKey, regions]);

  useEffect(() => {
    if (scenarioOptions.some((scenario) => scenario.key === taskType)) return;
    if (scenarioOptions[0]) setTaskType(scenarioOptions[0].key);
  }, [scenarioOptions, taskType]);

  useEffect(() => {
    if (!advancedOpen || !hasScriptProfile) setOpenTagPicker(null);
  }, [advancedOpen, hasScriptProfile]);

  function updateReleaseBrief(field: ProductionBriefField, value: string) {
    setReleaseBrief((current) => ({ ...current, [field]: value }));
  }

  function toggleScriptTag(field: ScriptProfileField, value: string) {
    setReleaseBrief((current) => {
      const selected = current[field];
      if (value === AUTO_ADAPT) return { ...current, [field]: [AUTO_ADAPT] };
      const withoutAuto = selected.filter((item) => item !== AUTO_ADAPT);
      const exists = withoutAuto.includes(value);
      let next = exists ? withoutAuto.filter((item) => item !== value) : [...withoutAuto, value];
      if (field === "audience" && !exists) next = [value];
      if (!next.length) next = [AUTO_ADAPT];
      return { ...current, [field]: next.slice(0, field === "audience" ? 1 : 4) };
    });
  }

  function handleRegionChange(nextRegionKey: string) {
    setRegionKey(nextRegionKey);
  }

  function pickFile(files: FileList | File[]) {
    const nextFile = Array.from(files)[0];
    if (nextFile) setSourceFile(nextFile);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    pickFile(event.target.files ?? []);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (regenerating) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (regenerating) return;
    event.preventDefault();
    setDragActive(false);
    pickFile(event.dataTransfer.files);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || !selectedRegion) return;
    const formData = new FormData(event.currentTarget);
    formData.set("project_name", projectName);
    formData.set("task_type", taskType);
    formData.set("target_region", selectedRegion.key);
    for (const field of [
      "episode_duration",
      "target_episode_count",
      "maturity_target"
    ]) {
      const value = String(formData.get(field) || "").trim();
      if (value) formData.set(field, value);
      else formData.delete(field);
    }
    if (hasScriptProfile) {
      SCRIPT_PROFILE_FIELDS.forEach((field) => formData.set(field, releaseBrief[field].join(",")));
    } else {
      SCRIPT_PROFILE_FIELDS.forEach((field) => formData.delete(field));
    }
    const requirements = extraRequirements.trim();
    if (requirements) formData.set("extra_requirements", requirements);
    else formData.delete("extra_requirements");
    if (sourceFile) formData.set("source_file", sourceFile);
    onSubmit(formData);
  }

  if (!scenarioOptions.length) {
    return (
      <section className="glass-panel document-panel new-project-panel" aria-label="新建任务">
        <div className="new-project-title-row"><h1 className="new-project-title">暂无可用创作场景</h1></div>
        <div className="new-project-composer"><p>请联系管理员为你的角色授予所需场景后再创建任务。</p></div>
      </section>
    );
  }

  return (
    <section
      className={regenerating
        ? "document-panel new-project-panel regenerate-project-panel"
        : "glass-panel document-panel new-project-panel"}
      role={regenerating ? "dialog" : undefined}
      aria-modal={regenerating ? true : undefined}
      aria-label={regenerating ? `重新处理${sourceLabel}` : "新建任务"}
    >
      {!regenerating ? (
        <div className="new-project-motion" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : null}
      <form className="new-project-form" onSubmit={handleSubmit}>
        <input type="hidden" name="project_name" value={projectName} />
        <input type="hidden" name="task_type" value={taskType} />
        <div className="new-project-title-row">
          <h1 className="new-project-title">{regenerating ? `重新处理${sourceLabel}` : "虎鲸漫剧｜剧本出海工作台"}</h1>
          {regenerating ? (
            <button type="button" className="icon-button" onClick={onCancel} aria-label="关闭重新生成" title="关闭">
              <X size={17} />
            </button>
          ) : null}
        </div>
        <div className="new-project-composer">
          <textarea
            name="extra_requirements"
            value={extraRequirements}
            onChange={(event) => setExtraRequirements(event.target.value)}
            placeholder={taskRequirementLabel}
            aria-label={taskRequirementLabel}
          />
          {initialGenerationCreditCost !== null ? (
            <div className={`new-project-credit-status${creditInsufficient ? " insufficient" : concurrencyReached ? " capacity-full" : ""}`}>
              <Coins size={14} />
              <span>{creditInsufficient
                ? `首次处理需要 ${initialGenerationCreditCost} 额度，当前可用 ${creditBalance ?? 0} 额度。请联系管理员补充后再提交。`
                : concurrencyReached
                  ? `当前已有 ${concurrency?.active ?? 0} / ${concurrency?.limit ?? 0} 个任务正在运行。请等待其中一个任务完成或取消后再提交。`
                : `提交后将直接开始处理，本次消耗 ${initialGenerationCreditCost} 额度；失败或取消会自动退还。`}</span>
            </div>
          ) : null}
          <div className="new-project-composer-footer">
            <div className="new-project-select-group">
              <ScenarioSelect
                ariaLabel="选择处理场景"
                listId="new-project-scenario-options"
                options={scenarioOptions}
                value={taskType}
                disabled={busy || regenerating}
                onChange={setTaskType}
                variant="task"
              />
              <ScenarioSelect
                ariaLabel="选择目标地区"
                listId="new-project-region-options"
                options={regionOptions}
                value={regionKey}
                disabled={busy}
                onChange={handleRegionChange}
                showIcons={false}
                variant="region"
              />
            </div>
            <button className="new-project-send-button" type="submit" disabled={!canSubmit} title={creditInsufficient ? `额度不足，当前可用 ${creditBalance ?? 0} 额度` : !hasRequiredInput ? "请先完成必要输入" : concurrencyReached ? "当前运行名额已满，点击后可查看提示" : regenerating ? "确认重新生成" : initialGenerationCreditCost !== null ? `发送要求，首次处理消耗 ${initialGenerationCreditCost} 额度` : "发送要求"}>
              <Send size={18} />
              <span>{busy ? "处理中" : creditInsufficient ? "额度不足" : concurrencyReached ? "运行名额已满" : regenerating ? "确认生成" : initialGenerationCreditCost !== null ? `发送要求 · ${initialGenerationCreditCost}额度` : "发送要求"}</span>
            </button>
          </div>
        </div>

        <div className={`new-project-advanced${advancedOpen ? " open" : ""}`}>
          <button
            className="new-project-advanced-toggle"
            type="button"
            aria-expanded={advancedOpen}
            aria-controls="new-project-advanced-fields"
            onClick={() => {
              setOpenTagPicker(null);
              setAdvancedOpen((open) => !open);
            }}
          >
            <SlidersHorizontal size={16} />
            <span>发行配置</span>
            <small>可按项目补充</small>
            <ChevronDown size={16} />
          </button>
          <fieldset id="new-project-advanced-fields" className="new-project-distribution" hidden={!advancedOpen}>
            <label>
              <span>单集规格</span>
              <input name="episode_duration" value={releaseBrief.episode_duration} onChange={(event) => updateReleaseBrief("episode_duration", event.target.value)} placeholder="90 秒" disabled={busy} />
            </label>
            <label>
              <span>目标集数</span>
              <input name="target_episode_count" type="number" min="1" step="1" value={releaseBrief.target_episode_count} onChange={(event) => updateReleaseBrief("target_episode_count", event.target.value)} placeholder="35" disabled={busy} />
            </label>
            <label>
              <span>目标分级</span>
              <select name="maturity_target" value={releaseBrief.maturity_target} onChange={(event) => updateReleaseBrief("maturity_target", event.target.value)} disabled={busy}>
                {MATURITY_TARGET_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            {hasScriptProfile ? (
              <>
                <ScriptTagPicker field="audience" label="受众" options={scriptTagTaxonomy.audience} selected={releaseBrief.audience} disabled={busy} open={openTagPicker === "audience"} single onOpenChange={(open) => setOpenTagPicker(open ? "audience" : null)} onToggle={(value) => toggleScriptTag("audience", value)} />
                <ScriptTagPicker field="theme" label="主题" options={scriptTagTaxonomy.theme} selected={releaseBrief.theme} disabled={busy} open={openTagPicker === "theme"} onOpenChange={(open) => setOpenTagPicker(open ? "theme" : null)} onToggle={(value) => toggleScriptTag("theme", value)} />
                <ScriptTagPicker field="background" label="背景" options={scriptTagTaxonomy.background} selected={releaseBrief.background} disabled={busy} open={openTagPicker === "background"} onOpenChange={(open) => setOpenTagPicker(open ? "background" : null)} onToggle={(value) => toggleScriptTag("background", value)} />
                <ScriptTagPicker field="setting" label="设定" options={scriptTagTaxonomy.setting} selected={releaseBrief.setting} disabled={busy} open={openTagPicker === "setting"} onOpenChange={(open) => setOpenTagPicker(open ? "setting" : null)} onToggle={(value) => toggleScriptTag("setting", value)} />
              </>
            ) : null}
          </fieldset>
        </div>

        <div
          className={[
            "new-project-upload",
            dragActive ? "drag-active" : "",
            sourceFile || existingSourceName ? "has-file" : "",
            regenerating ? "locked-source" : ""
          ].filter(Boolean).join(" ")}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {regenerating ? (
            <div className="new-project-upload-target" role="group" aria-label={`当前${sourceLabel}文件`}>
              <span className="new-project-upload-icon" aria-hidden="true"><LockKeyhole size={28} /></span>
              <span className="new-project-upload-copy">
                <strong>{existingSourceName}</strong>
                <span>{projectName}</span>
                <small>已保留当前原件</small>
              </span>
            </div>
          ) : (
            <label className="new-project-upload-target">
              <input
                className="new-project-source-input"
                name="source_file"
                type="file"
                accept=".pdf,.docx,.epub,.txt,.md,.markdown"
                disabled={busy}
                onChange={handleFileChange}
              />
              <span className="new-project-upload-icon" aria-hidden="true">
                {sourceFile ? <FileCheck2 size={30} /> : <UploadCloud size={30} />}
              </span>
              <span className="new-project-upload-copy">
                <strong>{sourceFile ? sourceFile.name : sourceUploadLabel}</strong>
                <span>{sourceFile ? `${fileSizeLabel(sourceFile)} · ${projectName}` : sourceUploadHint}</span>
                <small>支持 EPUB、PDF、DOCX、Markdown、TXT</small>
              </span>
            </label>
          )}
        </div>

        {error ? <p className="error-text">{error}</p> : null}
        <button type="button" className="new-project-cancel" onClick={onCancel} disabled={busy}>取消</button>
      </form>
    </section>
  );
}
