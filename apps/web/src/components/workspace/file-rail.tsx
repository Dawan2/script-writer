import { Archive, ArrowRight, ChevronLeft, ChevronRight, Coins, Download, RefreshCcw, RotateCcw, Settings2, WandSparkles } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { NovelAnalysisSection, Project, StageFile } from "@/lib/types";

type FileRailAction = {
  disabled: boolean;
  tooltip: string;
};

type FileRailProps = {
  projectId?: number;
  projectTaskType?: Project["task_type"];
  files: StageFile[];
  selectedStage?: string;
  novelAnalysisSection?: NovelAnalysisSection;
  collapsed: boolean;
  regenerateAction: FileRailAction;
  briefDisabled?: boolean;
  primaryStageAction: FileRailAction;
  primaryAction?: "next" | "archive" | "reopen" | "optimize-p0";
  regenerateCreditCost?: number | null;
  primaryCreditCost?: number | null;
  creditBalance?: number | null;
  creditsManaged?: boolean;
  onToggleCollapsed: () => void;
  onSelect: (file: StageFile) => void;
  onSelectNovelAnalysisSection?: (section: NovelAnalysisSection) => void;
  onRegenerate: () => void;
  onViewBrief: () => void;
  onNextStage: () => void;
  onDownloadRequest: (url: string) => void;
};

type FileActionButtonProps = {
  className?: string;
  disabled: boolean;
  label: string;
  tooltip: string;
  tooltipId: string;
  onClick: () => void;
  children: ReactNode;
};

const TRIAL_MERGED_TOOLTIP = "剧本试稿已合并到完整剧本中。";

function FileActionButton({
  className,
  disabled,
  label,
  tooltip,
  tooltipId,
  onClick,
  children
}: FileActionButtonProps) {
  return (
    <span
      className="file-action-tooltip"
      tabIndex={disabled ? 0 : undefined}
      aria-label={disabled ? label : undefined}
      aria-describedby={disabled ? tooltipId : undefined}
    >
      <button
        type="button"
        className={className}
        disabled={disabled}
        aria-label={label}
        aria-describedby={disabled ? undefined : tooltipId}
        onClick={onClick}
      >
        {children}
      </button>
      <span id={tooltipId} className="file-action-tooltip-content" role="tooltip">
        {tooltip}
      </span>
    </span>
  );
}

function canSelectStageFile(file: StageFile) {
  if (file.merged_into_full_script) return false;
  return file.clickable || ["in_progress", "queued", "running"].includes(file.status);
}

function stageStateLabel(file: StageFile, selectedStage?: string) {
  if (file.merged_into_full_script) return "已合并";
  if (file.status === "in_progress" || file.status === "queued" || file.status === "running") return "生成中";
  if (file.document_sync_pending) return "已保存 · 待更新";
  if (file.stage === "foreign_review" && file.review_decision?.outcome === "revision_requested") return "审稿建议调整";
  if (file.status === "approved") return file.stage === selectedStage ? "已确认 · 当前" : "已确认";
  if (file.status === "completed") return file.stage === selectedStage ? "已完成 · 当前" : "已完成";
  if (file.status === "awaiting_approval") return file.stage === selectedStage ? "待确认 · 当前" : "待确认";
  if (file.status === "needs_revision") {
    const count = file.quality_warnings?.length ?? 0;
    return count > 0 ? `${count} 项待处理` : "需要处理";
  }
  if (file.status === "stale") return "上游已变更";
  if (file.stage === selectedStage) return "当前查看";
  return file.clickable ? "可查看" : "未开始";
}

function stageStateClass(file: StageFile, selectedStage?: string) {
  if (file.merged_into_full_script) return "merged";
  if (file.stage === selectedStage) return "current";
  if (file.status === "stale" || file.status === "needs_revision") return "attention";
  if (["approved", "completed", "awaiting_approval"].includes(file.status) || file.clickable) return "done";
  return "locked";
}

export function FileRail({
  projectId,
  projectTaskType,
  files,
  selectedStage,
  novelAnalysisSection = "basic",
  collapsed,
  regenerateAction,
  briefDisabled,
  primaryStageAction,
  primaryAction = "next",
  regenerateCreditCost,
  primaryCreditCost,
  creditBalance,
  creditsManaged = false,
  onToggleCollapsed,
  onSelect,
  onSelectNovelAnalysisSection,
  onRegenerate,
  onViewBrief,
  onNextStage,
  onDownloadRequest
}: FileRailProps) {
  function requestDownload(event: ReactMouseEvent<HTMLAnchorElement>, url: string) {
    event.preventDefault();
    const menu = event.currentTarget.closest("details");
    onDownloadRequest(url);
    if (menu instanceof HTMLDetailsElement) menu.open = false;
  }

  const selectedFile = files.find((file) => file.stage === selectedStage);
  const primaryLabel = primaryAction === "archive"
    ? "归档"
    : primaryAction === "reopen"
      ? "重新开启"
      : primaryAction === "optimize-p0"
        ? "一键优化"
      : selectedFile?.status === "awaiting_approval"
        ? "确认并继续"
        : "下一步";
  const regenerateLabel = regenerateCreditCost !== null && regenerateCreditCost !== undefined
    ? `重新生成，消耗 ${regenerateCreditCost} 额度`
    : "重新生成";
  const primaryActionLabel = primaryCreditCost !== null && primaryCreditCost !== undefined
    ? `${primaryLabel}，消耗 ${primaryCreditCost} 额度`
    : primaryLabel;
  const regenerateCreditInsufficient = Boolean(creditsManaged && regenerateCreditCost !== null && regenerateCreditCost !== undefined && creditBalance !== null && creditBalance !== undefined && creditBalance < regenerateCreditCost);
  const primaryCreditInsufficient = Boolean(creditsManaged && primaryCreditCost !== null && primaryCreditCost !== undefined && creditBalance !== null && creditBalance !== undefined && creditBalance < primaryCreditCost);
  const regenerateTooltip = regenerateCreditInsufficient
    ? `额度不足：本次需要 ${regenerateCreditCost} 额度，当前可用 ${creditBalance ?? 0} 额度。`
    : regenerateAction.tooltip;
  const primaryTooltip = primaryCreditInsufficient
    ? `额度不足：本次需要 ${primaryCreditCost} 额度，当前可用 ${creditBalance ?? 0} 额度。`
    : primaryStageAction.tooltip;
  const creditNotice = primaryCreditInsufficient
    ? { insufficient: true, text: `${primaryLabel}需要 ${primaryCreditCost} 额度，当前可用 ${creditBalance ?? 0} 额度` }
    : regenerateCreditInsufficient
      ? { insufficient: true, text: `重新生成需要 ${regenerateCreditCost} 额度，当前可用 ${creditBalance ?? 0} 额度` }
      : primaryCreditCost !== null && primaryCreditCost !== undefined
        ? { insufficient: false, text: `${primaryLabel}将消耗 ${primaryCreditCost} 额度` }
        : regenerateCreditCost !== null && regenerateCreditCost !== undefined
          ? { insufficient: false, text: `重新生成将消耗 ${regenerateCreditCost} 额度` }
          : null;
  const PrimaryIcon = primaryAction === "archive"
    ? Archive
    : primaryAction === "reopen"
      ? RotateCcw
      : primaryAction === "optimize-p0"
        ? WandSparkles
        : ArrowRight;
  if (collapsed) {
    return (
      <aside className="glass-panel file-panel collapsed" aria-label="项目文件栏">
        <div className="collapsed-rail">
          <button
            className="rail-icon-button"
            aria-label="展开项目文件"
            title="展开项目文件"
            onClick={onToggleCollapsed}
          >
            <ChevronLeft size={16} />
          </button>
          <span className="rail-separator" />
          <div className="file-rail-list">
            {files.map((file) => {
              const state = stageStateClass(file, selectedStage);
              const mergedTooltip = file.merged_into_full_script ? TRIAL_MERGED_TOOLTIP : undefined;
              return (
                <span
                  key={file.index}
                  className="rail-stage-entry"
                  title={mergedTooltip}
                >
                  <button
                    className={`rail-stage-button ${state}`}
                    aria-label={mergedTooltip ?? `${file.name}，${stageStateLabel(file, selectedStage)}`}
                    title={mergedTooltip ? undefined : file.name}
                    disabled={!canSelectStageFile(file)}
                    onClick={() => onSelect(file)}
                  >
                    {file.index}
                  </button>
                </span>
              );
            })}
          </div>
          <span className="rail-separator" />
          <div className="file-rail-actions">
            <button
              className="rail-icon-button"
              aria-label="查看任务需求"
              title="任务需求"
              disabled={briefDisabled}
              onClick={onViewBrief}
            >
              <Settings2 size={15} />
            </button>
            <button
              className="rail-icon-button"
              aria-label={regenerateLabel}
              title={regenerateCreditInsufficient ? regenerateTooltip : regenerateCreditCost !== null && regenerateCreditCost !== undefined ? `${regenerateAction.tooltip} 本次消耗 ${regenerateCreditCost} 额度。` : regenerateAction.tooltip}
              disabled={regenerateAction.disabled || regenerateCreditInsufficient}
              onClick={onRegenerate}
            >
              <RefreshCcw size={15} />
            </button>
            <button
              className="rail-icon-button rail-primary"
              aria-label={primaryActionLabel}
              title={primaryCreditInsufficient ? primaryTooltip : primaryCreditCost !== null && primaryCreditCost !== undefined ? `${primaryStageAction.tooltip} 本次消耗 ${primaryCreditCost} 额度。` : primaryStageAction.tooltip}
              disabled={primaryStageAction.disabled || primaryCreditInsufficient}
              onClick={onNextStage}
            >
              <PrimaryIcon size={15} />
            </button>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="glass-panel file-panel">
      <div className="file-heading">
        <h2>项目文件</h2>
        <div className="file-heading-actions">
          <button className="icon-button" aria-label="查看任务需求" title="任务需求" disabled={briefDisabled} onClick={onViewBrief}>
            <Settings2 size={16} />
          </button>
          <button className="icon-button" aria-label="折叠项目文件" onClick={onToggleCollapsed}>
            <ChevronRight size={17} />
          </button>
        </div>
      </div>

      <div className="stage-track">
        {files.map((file) => {
          const state = stageStateClass(file, selectedStage);
          const mergedTooltip = file.merged_into_full_script ? TRIAL_MERGED_TOOLTIP : undefined;
          const isReviewReport = file.stage === "foreign_review";
          const isTrialScript = file.stage === "trial_generate";
          const isFullScript = file.stage === "full_generate";
          const isDialogueTranslation = file.stage === "dialogue_translate";
          const isHumanizedScript = file.stage === "humanizer_zh";
          const isNovelAnalysis = projectTaskType === "novel" && file.stage === "novel_analysis";
          const isScriptDelivery = isTrialScript || isFullScript || isDialogueTranslation || isHumanizedScript;
          const deliveryName = isTrialScript ? "试稿下载" : isDialogueTranslation ? "完本译稿" : "完本下载";
          const deliveryDocumentLabel = isTrialScript ? "试稿交付" : isDialogueTranslation ? "完本译稿" : "完本交付";
          const deliveryFileSuffix = deliveryDocumentLabel;
          const deliveryTitleFallback = isTrialScript ? "剧本试稿" : isDialogueTranslation ? "台词译稿" : "完整剧本";
          const canDownloadDelivery = isTrialScript || isFullScript || isDialogueTranslation;
          const downloadFileName = file.file_name;
          const deliveryBaseName = file.file_name
            .replace(/-剧本全稿\.md$/i, "")
            .replace(/-剧本试稿\.md$/i, "")
            .replace(/剧本全稿\.md$/i, "")
            .replace(/剧本试稿\.md$/i, "")
            .replace(/-台词译稿\.md$/i, "")
            .replace(/台词译稿\.md$/i, "")
            .replace(/\.md$/i, "") || deliveryTitleFallback;
          const deliveryDownloadName = `${deliveryBaseName}-${deliveryFileSuffix}.docx`;
          const trialTranslationDownloadName = `${deliveryBaseName}-试稿译稿.docx`;
          return (
            <div
              key={file.index}
              className={`stage-item ${state}`}
              title={mergedTooltip}
            >
              <button
                className="stage-select-action"
                aria-label={mergedTooltip ?? undefined}
                disabled={!canSelectStageFile(file)}
                onClick={() => onSelect(file)}
              >
                <span className="stage-index">{file.index}</span>
                <span className="stage-copy">
                  <strong>
                    {file.name}
                  </strong>
                  <small>
                    {stageStateLabel(file, selectedStage)}
                  </small>
                </span>
              </button>
              {projectId && file.exists && !file.merged_into_full_script && (isScriptDelivery || isReviewReport) ? (
                <details className="stage-download-menu">
                  <summary
                    className="stage-download-action"
                    aria-label={`导出${file.name}`}
                    title={`导出${file.name}`}
                  >
                    <Download size={16} />
                  </summary>
                  <div className="stage-download-options">
                    {isReviewReport ? (
                      <a
                        className="stage-download-option"
                        href={`/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download`}
                        download={`${file.file_name.replace(/\.md$/i, "")}.docx`}
                        onClick={(event) => requestDownload(
                          event,
                          `/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download`
                        )}
                      >
                        <span className="stage-download-option-name">Word 文档</span>
                        <small>.docx</small>
                      </a>
                    ) : (
                      <>
                        <a
                          className="stage-download-option"
                          href={`/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download`}
                          download={file.file_name}
                          onClick={(event) => requestDownload(
                            event,
                            `/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download`
                          )}
                        >
                          <span className="stage-download-option-name">Markdown 文档</span>
                          <small>.md</small>
                        </a>
                        <a
                          className="stage-download-option"
                          href={`/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download?format=docx`}
                          download={file.file_name.replace(/\.md$/i, ".docx")}
                          onClick={(event) => requestDownload(
                            event,
                            `/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download?format=docx`
                          )}
                        >
                          <span className="stage-download-option-name">Word 文档</span>
                          <small>.docx</small>
                        </a>
                      </>
                    )}
                    {canDownloadDelivery ? (
                      <>
                        <span className="stage-download-divider" aria-hidden="true" />
                        {isDialogueTranslation ? (
                          <>
                            <a
                              className="stage-download-delivery"
                              href={`/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download?format=delivery-docx`}
                              download={deliveryDownloadName}
                              aria-label="下载完本译稿 Word 文档"
                              title="下载完本译稿 Word 文档"
                              onClick={(event) => requestDownload(
                                event,
                                `/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download?format=delivery-docx`
                              )}
                            >
                              <span className="stage-download-delivery-copy">
                                <span className="stage-download-delivery-name">完本译稿</span>
                                <small className="stage-download-delivery-description">包含完整剧本正文的 Word 文档</small>
                              </span>
                              <small className="stage-download-file-extension">.docx</small>
                            </a>
                            <a
                              className="stage-download-delivery"
                              href={`/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download?format=delivery-docx&scope=trial`}
                              download={trialTranslationDownloadName}
                              aria-label="下载试稿译稿 Word 文档"
                              title="下载试稿译稿 Word 文档"
                              onClick={(event) => requestDownload(
                                event,
                                `/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download?format=delivery-docx&scope=trial`
                              )}
                            >
                              <span className="stage-download-delivery-copy">
                                <span className="stage-download-delivery-name">试稿译稿</span>
                                <small className="stage-download-delivery-description">正文仅包含前 10 集的 Word 文档</small>
                              </span>
                              <small className="stage-download-file-extension">.docx</small>
                            </a>
                          </>
                        ) : isFullScript ? (
                          <>
                            <a
                              className="stage-download-delivery"
                              href={`/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download?format=delivery-docx`}
                              download={deliveryDownloadName}
                              aria-label="下载完本 Word 文档"
                              title="下载完本 Word 文档"
                              onClick={(event) => requestDownload(
                                event,
                                `/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download?format=delivery-docx`
                              )}
                            >
                              <span className="stage-download-delivery-copy">
                                <span className="stage-download-delivery-name">完本下载</span>
                                <small className="stage-download-delivery-description">包含完整剧本正文的 Word 文档</small>
                              </span>
                              <small className="stage-download-file-extension">.docx</small>
                            </a>
                            <a
                              className="stage-download-delivery"
                              href={`/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download?format=delivery-docx&scope=trial`}
                              download={`${deliveryBaseName}-试稿交付.docx`}
                              aria-label="下载试稿 Word 文档"
                              title="下载试稿 Word 文档"
                              onClick={(event) => requestDownload(
                                event,
                                `/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download?format=delivery-docx&scope=trial`
                              )}
                            >
                              <span className="stage-download-delivery-copy">
                                <span className="stage-download-delivery-name">试稿下载</span>
                                <small className="stage-download-delivery-description">正文仅包含完整剧本前 10 集的 Word 文档</small>
                              </span>
                              <small className="stage-download-file-extension">.docx</small>
                            </a>
                          </>
                        ) : (
                          <a
                            className="stage-download-delivery"
                            href={`/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download?format=delivery-docx`}
                            download={deliveryDownloadName}
                            aria-label={`下载${deliveryDocumentLabel} Word 文档`}
                            title={`下载${deliveryDocumentLabel} Word 文档`}
                            onClick={(event) => requestDownload(
                              event,
                              `/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download?format=delivery-docx`
                            )}
                          >
                            <span className="stage-download-delivery-copy">
                              <span className="stage-download-delivery-name">{deliveryName}</span>
                              <small className="stage-download-delivery-description">符合交付要求的剧本 Word 文档</small>
                            </span>
                            <small className="stage-download-file-extension">.docx</small>
                          </a>
                        )}
                      </>
                    ) : null}
                  </div>
                </details>
              ) : projectId && file.exists && !file.merged_into_full_script ? (
                <a
                  className="stage-download-action"
                  href={`/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download`}
                  download={downloadFileName}
                  aria-label={`下载${file.name}${isReviewReport ? " PDF" : ""}`}
                  title={`下载${downloadFileName}`}
                  onClick={(event) => requestDownload(
                    event,
                    `/api/projects/${projectId}/files/${encodeURIComponent(file.stage)}/download`
                  )}
                >
                  <Download size={16} />
                </a>
              ) : null}
              {isNovelAnalysis ? (
                <div className="novel-stage-subnav" aria-label="小说解读目录">
                  {([
                    ["basic", "基础信息"],
                    ["characters", "主要角色"],
                    ["units", "剧情单元"]
                  ] as Array<[NovelAnalysisSection, string]>).map(([section, label]) => (
                    <button
                      type="button"
                      key={section}
                      className={selectedStage === "novel_analysis" && novelAnalysisSection === section ? "current" : ""}
                      disabled={!canSelectStageFile(file)}
                      onClick={() => {
                        onSelectNovelAnalysisSection?.(section);
                        onSelect(file);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="file-stage-actions">
        {creditNotice ? (
          <div className={`file-action-credit-summary${creditNotice.insufficient ? " is-insufficient" : ""}`}>
            <Coins size={14} />
            <span>{creditNotice.text}</span>
          </div>
        ) : null}
        <FileActionButton
          disabled={regenerateAction.disabled || regenerateCreditInsufficient}
          label={regenerateLabel}
          tooltip={regenerateTooltip}
          tooltipId="file-rail-regenerate-tooltip"
          onClick={onRegenerate}
        >
          <RefreshCcw size={14} />
          重新生成
        </FileActionButton>
        <FileActionButton
          className="stage-next-action"
          disabled={primaryStageAction.disabled || primaryCreditInsufficient}
          label={primaryActionLabel}
          tooltip={primaryTooltip}
          tooltipId="file-rail-primary-tooltip"
          onClick={onNextStage}
        >
          <PrimaryIcon size={14} />
          {primaryLabel}
        </FileActionButton>
      </div>
    </aside>
  );
}
