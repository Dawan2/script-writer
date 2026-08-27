import { BadgeCheck, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ReviewScorecard } from "@/lib/types";

export function ReviewScorecard({ scorecard }: { scorecard: ReviewScorecard }) {
  const reviewRequired = scorecard.verdict.human_review_required || scorecard.verdict.legal_review_required;
  const coverTags = [
    scorecard.basic_info.target_region,
    scorecard.basic_info.target_language,
    ...scorecard.basic_info.genre_tags
  ].filter(Boolean);

  return (
    <section className="review-scorecard" aria-label="剧本审稿概览" data-verdict={scorecard.verdict.code}>
      <header className="review-cover-heading">
        <span>海外剧本审稿 / SCRIPT REVIEW</span>
        <h1>{scorecard.basic_info.script_name || "审稿报告"}</h1>
        <p>审稿报告</p>
        <div className="review-cover-tags" aria-label="剧本标签">
          {coverTags.map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}
        </div>
      </header>
      <div className="review-scorecard-top">
        <div className="review-grade-block">
          <span className="review-kicker"><BadgeCheck size={14} />内容潜力评级</span>
          <strong>{scorecard.overall.grade ?? "--"}</strong>
        </div>
        <div className="review-verdict-block">
          <div className="review-verdict-meta">
            <span className={`review-verdict review-verdict-${scorecard.verdict.code}`}>{scorecard.verdict.label}</span>
          </div>
          <p>{scorecard.verdict.summary}</p>
        </div>
      </div>

      <div className="review-scorecard-main">
        <div className="review-dimension-table-scroll">
          <table className="review-dimension-table">
            <thead>
              <tr>
                <th>维度</th>
                <th>评级</th>
                <th>一句话点评</th>
              </tr>
            </thead>
            <tbody>
              {scorecard.dimensions.map((dimension) => (
                <tr key={dimension.key}>
                  <th scope="row"><strong>{dimension.name}</strong></th>
                  <td><strong className="review-dimension-grade">{dimension.grade ?? "--"}</strong></td>
                  <td>{dimension.one_line_comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={scorecard.critical_risks.length ? "review-risk-strip warning" : "review-risk-strip clear"}>
        {scorecard.critical_risks.length ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}
        <strong>{scorecard.critical_risks.length ? `${scorecard.critical_risks.length} 项关键风险` : "未发现阻断级风险"}</strong>
        <span>{reviewRequired ? "需要人工或法务复核" : "按当前证据可进入下一判断环节"}</span>
      </div>
    </section>
  );
}
