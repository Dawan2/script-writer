"use client";

import { Clapperboard, Download, FileText, Globe2, MessageSquareText, X } from "lucide-react";
import type { DistributionBriefSnapshot } from "@/lib/types";

type DistributionBriefDialogProps = {
  snapshot: DistributionBriefSnapshot;
  projectId?: number;
  onCancel: () => void;
};

function displayValue(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "未设置" : String(value);
}

function tagValue(value: string[] | undefined) {
  return value?.join("、") || "未设置";
}

function RequirementField({ label, value }: { label: string; value: string | number | null | undefined }) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div>
      <dt>{label}</dt>
      <dd className={empty ? "empty" : undefined}>{displayValue(value)}</dd>
    </div>
  );
}

export function DistributionBriefDialog({ snapshot, projectId, onCancel }: DistributionBriefDialogProps) {
  const initial = snapshot.brief;
  const market = initial.target_countries.join("、") || snapshot.target_region || "未指定地区";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="distribution-brief-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="distribution-brief-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="task-requirements-header">
          <div>
            <span className="task-requirements-eyebrow">项目设定</span>
            <h2 id="distribution-brief-title">任务需求</h2>
            <div className="task-requirements-market" aria-label={`适配市场：${market} ${initial.target_locale}`}>
              <Globe2 size={15} aria-hidden="true" />
              <strong>{market}</strong>
              <span>{initial.target_locale || "未指定语言"}</span>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onCancel} aria-label="关闭任务需求" title="关闭">
            <X size={17} />
          </button>
        </header>

        <div className="task-requirements-content">
          {snapshot.source && projectId ? (
            <section className="task-requirements-source" aria-labelledby="task-requirements-source">
              <span className="task-requirements-source-icon"><FileText size={17} aria-hidden="true" /></span>
              <div>
                <h3 id="task-requirements-source">原始文件</h3>
                <p title={snapshot.source.display_name}>{snapshot.source.display_name}</p>
              </div>
              <a href={`/api/projects/${projectId}/source/download`} download={snapshot.source.display_name}>
                <Download size={15} aria-hidden="true" />下载原文件
              </a>
            </section>
          ) : null}
          <section className="task-requirements-section" aria-labelledby="task-requirements-production">
            <div className="task-requirements-section-heading">
              <Clapperboard size={16} aria-hidden="true" />
              <h3 id="task-requirements-production">制作设定</h3>
            </div>
            <dl className="task-requirements-fields">
              <RequirementField label="单集时长" value={initial.episode_duration} />
              <RequirementField label="目标集数" value={initial.target_episode_count} />
              <RequirementField label="内容分级" value={initial.maturity_target} />
              {initial.audience ? <RequirementField label="受众" value={tagValue(initial.audience)} /> : null}
              {initial.theme ? <RequirementField label="主题" value={tagValue(initial.theme)} /> : null}
              {initial.background ? <RequirementField label="背景" value={tagValue(initial.background)} /> : null}
              {initial.setting ? <RequirementField label="设定" value={tagValue(initial.setting)} /> : null}
            </dl>
          </section>

          <section className="task-requirements-section task-requirements-note" aria-labelledby="task-requirements-note">
            <div className="task-requirements-section-heading">
              <MessageSquareText size={16} aria-hidden="true" />
              <h3 id="task-requirements-note">创作说明</h3>
            </div>
            <p className={snapshot.extra_requirements.trim() ? undefined : "empty"}>
              {snapshot.extra_requirements.trim() || "暂无额外说明"}
            </p>
          </section>
        </div>
      </section>
    </div>
  );
}
