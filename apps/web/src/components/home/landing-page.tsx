"use client";

import Link from "next/link";
import {
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  ChevronDown,
  ChevronsLeftRight,
  Clapperboard,
  FileCheck2,
  FileText,
  GitBranch,
  Globe2,
  Languages,
  LogOut,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Target,
  UserRound,
  UsersRound,
  Workflow,
  X
} from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { InteractiveDifferenceCursor } from "@/components/ui/interactive-difference-cursor";
import { getSessionUser, login, logout } from "@/lib/api-client";
import { hasErrorCode } from "@/lib/api-error";
import { OPERATION_MANUAL_URL } from "@/lib/constants";
import { HTTP_ERROR_CODES } from "@/lib/error-codes";
import type { User } from "@/lib/types";

const navigation = [
  { index: "01", label: "剧本出海", href: "#adaptation" },
  { index: "02", label: "海外审稿", href: "#review" },
  { index: "03", label: "产品优势", href: "#advantages" },
  { index: "04", label: "关于我们", href: "#about" }
];

const reviewDimensions = [
  { name: "题材吸引力", grade: "A" },
  { name: "故事完整度", grade: "A" },
  { name: "人物吸引力", grade: "A" },
  { name: "追剧节奏", grade: "S" },
  { name: "对白与可拍性", grade: "A" },
  { name: "本土适配", grade: "A" }
];

const productAdvantages = [
  {
    category: "内容优势",
    title: "爽点还在，故事不乱",
    summary: "出海改的是表达，不是故事的灵魂。",
    icon: Languages,
    signals: ["原剧爽点", "当地表达", "长篇一致"],
    details: [
      { title: "保住原剧爽点，不做生硬直译", description: "复仇、成长、逆袭和情感拉扯都会保留，再换成当地观众熟悉的设定和对白。" },
      { title: "人物和伏笔不会越改越乱", description: "持续核对人物关系、关键道具、隐藏身份和前后伏笔，守住长篇一致。" }
    ]
  },
  {
    category: "专业方法",
    title: "虎鲸跑通的出海方法",
    summary: "不是通用 AI，而是一套来自专业实战的六步 SOP。",
    icon: Workflow,
    signals: ["6 步 SOP", "专家共调", "6 维审核"],
    details: [
      { title: "六步剧本出海 SOP", description: "从原稿梳理到海外审稿，每一步都有明确产物和确认点。" },
      { title: "专家共调的关键能力", description: "大纲、人物、试稿、全稿与审稿等关键环节，由对应领域专家参与打磨。" },
      { title: "六维审核标准", description: "围绕题材、故事、人物、节奏、对白与可拍性、本土适配，输出可执行的优化方案。" }
    ]
  },
  {
    category: "创作体验",
    title: "像纸笔一样轻盈",
    summary: "过程看得见、随时改得动，主动权始终在你手里。",
    icon: FileText,
    signals: ["看得见", "改得动", "记得住"],
    details: [
      { title: "过程全透明", description: "每份关键文档、每一步进展和每次调整都清晰可见。" },
      { title: "随时接手调整", description: "可以直接修改文档，也可以通过对话说明想法，修改会成为后续创作的依据。" },
      { title: "长剧情记忆不断线", description: "持续记住人物关系、关键伏笔、你的确认与叮咛。" }
    ]
  },
  {
    category: "成长进化",
    title: "每写一部，都更懂你",
    summary: "你的对话、修改与偏好，会沉淀成下一次的创作默契。",
    icon: Sparkles,
    signals: ["主动复盘", "由你确认", "沉淀偏好"],
    details: [
      { title: "创作结束后主动复盘", description: "从对话、修改与审稿反馈中整理值得沉淀的习惯，经你确认后用于下一次创作。" },
      { title: "偏好由你主动定义", description: "可以为梗概、人物、试稿、全稿、审稿单独设定，也能用全局创作观贯穿每个项目。" }
    ]
  }
];

function Brand() {
  return (
    <Link className="landing-brand" href="#top" aria-label="返回页面顶部">
      <span className="landing-logo-box" aria-hidden="true">
        <img src="/logo.png" alt="" />
      </span>
      <span className="landing-brand-copy">
        <small>虎鲸漫剧出品</small>
        <strong>出海剧作家</strong>
      </span>
    </Link>
  );
}

function PipelineGraphic() {
  return (
    <figure className="landing-pipeline" aria-label="出海剧作家从判断项目、跨文化改编到海外审稿的完整服务路径">
      <div className="landing-pipeline-meta" aria-hidden="true">
        <span>[ 出海剧作家｜剧本出海路径 ]</span>
        <span className="landing-live-signal">全程可观测、可编辑</span>
      </div>
      <svg className="landing-pipeline-svg" viewBox="0 0 960 480" role="img" aria-label="先判断剧本是否值得出海，再分阶段完成改编，经过海外审稿后交付可拍摄剧本">
        <defs>
          <pattern id="pipeline-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M24 0H0V24" fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="0.6" />
          </pattern>
          <filter id="pipeline-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <clipPath id="adaptation-scan-clip">
            <rect x="332" y="87" width="340" height="265" />
          </clipPath>
        </defs>

        <rect className="pipeline-grid" x="0.5" y="0.5" width="959" height="479" fill="url(#pipeline-grid)" />
        <path className="editorial-guide" d="M24 62H936M24 365H936M103 24V456M895 24V456" />
        <g className="editorial-signal-strip" aria-hidden="true">
          <text x="34" y="46">先判断值不值得改</text>
          <text x="388" y="46">再改成当地观众爱看的故事</text>
          <text x="786" y="46">最后交付可拍、可审的剧本</text>
          <rect x="24" y="57" width="184" height="2" />
          <rect x="386" y="57" width="188" height="2" />
          <rect x="784" y="57" width="152" height="2" />
        </g>

        <path className="editorial-knowledge-link" d="M207 382V352M502 382V352M791 382V352" />
        <circle className="editorial-knowledge-port" cx="207" cy="366" r="3" />
        <circle className="editorial-knowledge-port" cx="502" cy="366" r="3" />
        <circle className="editorial-knowledge-port" cx="791" cy="366" r="3" />

        <path id="hero-pipeline-route" className="editorial-route" d="M89 232H924" />
        <path className="editorial-route-active" d="M89 232H924" />

        <g className="pipeline-particle" filter="url(#pipeline-glow)">
          <circle r="4">
            <animateMotion dur="6.4s" repeatCount="indefinite">
              <mpath href="#hero-pipeline-route" />
            </animateMotion>
          </circle>
        </g>
        <g className="pipeline-particle pipeline-particle-coral" filter="url(#pipeline-glow)">
          <circle r="3.5">
            <animateMotion dur="6.4s" begin="-3.2s" repeatCount="indefinite">
              <mpath href="#hero-pipeline-route" />
            </animateMotion>
          </circle>
        </g>

        <g className="editorial-source" transform="translate(32 190)">
          <path className="editorial-document" d="M0 0H39L55 16V84H0Z" />
          <path d="M39 0V16H55M12 37H43M12 49H39M12 61H43" />
          <circle className="editorial-port" cx="55" cy="42" r="4" />
          <text x="27" y="105" textAnchor="middle">原始剧本</text>
          <text className="editorial-micro" x="27" y="119" textAnchor="middle">你的原稿</text>
        </g>

        <g className="editorial-panel editorial-screen-panel" transform="translate(118 112)">
          <rect className="editorial-panel-shell" width="180" height="240" />
          <circle className="editorial-port" cx="0" cy="120" r="4" />
          <circle className="editorial-port" cx="180" cy="120" r="4" />
          <text className="editorial-panel-kicker" x="14" y="22">第一步 / 看项目</text>
          <text className="editorial-panel-title" x="14" y="50">剧本筛选</text>
          <path className="editorial-funnel" d="M146 23H166L158 33V43L153 46V33Z" />
          <path className="editorial-panel-rule" d="M14 65H166" />
          <g className="editorial-check-row" transform="translate(14 86)">
            <circle className="editorial-status-live" cx="4" cy="4" r="4" />
            <text x="16" y="8">题材吸引力</text>
            <text className="editorial-row-code" x="152" y="8" textAnchor="end">看市场</text>
          </g>
          <g className="editorial-check-row" transform="translate(14 119)">
            <circle cx="4" cy="4" r="4" />
            <text x="16" y="8">目标观众匹配</text>
            <text className="editorial-row-code" x="152" y="8" textAnchor="end">看人群</text>
          </g>
          <g className="editorial-check-row" transform="translate(14 152)">
            <circle cx="4" cy="4" r="4" />
            <text x="16" y="8">改编难度</text>
            <text className="editorial-row-code" x="152" y="8" textAnchor="end">看投入</text>
          </g>
          <g className="editorial-decision" transform="translate(14 190)">
            <rect width="152" height="32" />
            <circle cx="13" cy="16" r="4" />
            <text x="25" y="20">值得继续改</text>
            <path d="M132 12L137 16L132 20" />
          </g>
        </g>

        <g className="editorial-panel editorial-adaptation-panel" transform="translate(332 87)">
          <rect className="editorial-panel-shell" width="340" height="265" />
          <circle className="editorial-port" cx="0" cy="145" r="4" />
          <circle className="editorial-port" cx="340" cy="145" r="4" />
          <text className="editorial-panel-kicker" x="16" y="22">第二步 / 分阶段改编</text>
          <text className="editorial-panel-title" x="16" y="50">按地区文化重写</text>
          <text className="editorial-panel-state" x="324" y="25" textAnchor="end">每步可确认</text>
          <path className="editorial-panel-rule" d="M16 65H324" />

          <g className="editorial-stage-cell" transform="translate(16 78)">
            <rect width="148" height="68" />
            <text className="editorial-stage-index" x="12" y="18">第一稿 / 故事大纲</text>
            <text className="editorial-stage-title" x="12" y="40">重写故事结构</text>
            <text className="editorial-stage-note" x="12" y="57">冲突 · 钩子 · 每集推进</text>
          </g>
          <g className="editorial-stage-cell" transform="translate(176 78)">
            <rect width="148" height="68" />
            <text className="editorial-stage-index" x="12" y="18">第二稿 / 人物设定</text>
            <text className="editorial-stage-title" x="12" y="40">重塑人物关系</text>
            <text className="editorial-stage-note" x="12" y="57">动机 · 关系 · 说话方式</text>
          </g>
          <g className="editorial-stage-cell" transform="translate(16 158)">
            <rect width="148" height="68" />
            <text className="editorial-stage-index" x="12" y="18">第三稿 / 前 10 集</text>
            <text className="editorial-stage-title" x="12" y="40">先看试稿效果</text>
            <text className="editorial-stage-note" x="12" y="57">口语 · 节奏 · 拍摄难度</text>
          </g>
          <g className="editorial-stage-cell editorial-stage-final" transform="translate(176 158)">
            <rect width="148" height="68" />
            <text className="editorial-stage-index" x="12" y="18">第四稿 / 完整剧本</text>
            <text className="editorial-stage-title" x="12" y="40">完成全稿改编</text>
            <text className="editorial-stage-note" x="12" y="57">风格 · 人设 · 伏笔一致</text>
          </g>
        </g>
        <rect className="editorial-scan-line" x="348" y="158" width="1.5" height="176" clipPath="url(#adaptation-scan-clip)" />

        <g className="editorial-panel editorial-review-panel" transform="translate(706 112)">
          <rect className="editorial-panel-shell" width="170" height="240" />
          <circle className="editorial-port" cx="0" cy="120" r="4" />
          <circle className="editorial-port" cx="170" cy="120" r="4" />
          <text className="editorial-panel-kicker" x="14" y="22">第三步 / 海外主编审稿</text>
          <text className="editorial-panel-title" x="14" y="50">海外审稿</text>
          <path className="editorial-shield" d="M145 22L157 26V36C157 43 152 48 145 51C138 48 133 43 133 36V26Z" />
          <path className="editorial-shield-check" d="M139 36L143 40L151 31" />
          <path className="editorial-panel-rule" d="M14 65H156" />
          <g className="editorial-review-row" transform="translate(14 88)">
            <text x="0" y="8">观众会不会追</text>
            <rect x="88" y="1" width="54" height="7" />
            <rect className="editorial-review-level level-mint" x="88" y="1" width="45" height="7" />
          </g>
          <g className="editorial-review-row" transform="translate(14 121)">
            <text x="0" y="8">能不能顺利发行</text>
            <rect x="88" y="1" width="54" height="7" />
            <rect className="editorial-review-level level-coral" x="88" y="1" width="19" height="7" />
          </g>
          <g className="editorial-review-row" transform="translate(14 154)">
            <text x="0" y="8">应该先改哪里</text>
            <rect x="88" y="1" width="54" height="7" />
            <rect className="editorial-review-level level-gold" x="88" y="1" width="34" height="7" />
          </g>
          <g className="editorial-verdicts" transform="translate(14 193)">
            <rect width="43" height="28" />
            <rect x="49" width="43" height="28" />
            <rect x="98" width="43" height="28" />
            <text x="21.5" y="18" textAnchor="middle">通过</text>
            <text x="70.5" y="18" textAnchor="middle">返修</text>
            <text x="119.5" y="18" textAnchor="middle">重选</text>
          </g>
        </g>

        <g className="editorial-output" transform="translate(902 190)">
          <circle className="editorial-port" cx="0" cy="42" r="4" />
          <path className="editorial-document" d="M0 0H31L44 13V84H0Z" />
          <path d="M31 0V13H44M11 34H33M11 46H33M11 58H28" />
          <path className="editorial-output-check" d="M12 70L17 75L27 65" />
          <text x="22" y="105" textAnchor="middle">可交付稿</text>
          <text className="editorial-micro" x="22" y="119" textAnchor="middle">可提交</text>
        </g>

        <g className="editorial-knowledge" transform="translate(190 382)">
          <rect className="editorial-knowledge-shell" width="596" height="66" />
          <text className="editorial-knowledge-kicker" x="14" y="21">改编时一并参考</text>
          <text className="editorial-knowledge-title" x="14" y="45">目标市场规则</text>
          <path d="M142 0V66M255 0V66M368 0V66M481 0V66" />
          <g className="editorial-knowledge-item" transform="translate(156 0)">
            <circle cx="7" cy="24" r="4" />
            <text x="18" y="28">当地文化</text>
            <text className="editorial-micro" x="18" y="45">生活常识</text>
          </g>
          <g className="editorial-knowledge-item" transform="translate(269 0)">
            <circle cx="7" cy="24" r="4" />
            <text x="18" y="28">平台分级</text>
            <text className="editorial-micro" x="18" y="45">发行要求</text>
          </g>
          <g className="editorial-knowledge-item" transform="translate(382 0)">
            <circle cx="7" cy="24" r="4" />
            <text x="18" y="28">热门题材</text>
            <text className="editorial-micro" x="18" y="45">观众偏好</text>
          </g>
          <g className="editorial-knowledge-item" transform="translate(495 0)">
            <circle cx="7" cy="24" r="4" />
            <text x="18" y="28">拍摄条件</text>
            <text className="editorial-micro" x="18" y="45">制作现实</text>
          </g>
        </g>
      </svg>
    </figure>
  );
}

function ScriptComparison() {
  const [position, setPosition] = useState(52);
  const comparisonStyle = { "--comparison-position": `${position}%` } as CSSProperties;

  return (
    <div className="landing-comparison" style={comparisonStyle}>
      <div className="landing-script-layer landing-script-original" aria-hidden="true">
        <div className="landing-script-toolbar">
          <span>国内原始剧本</span>
          <span>中文原稿</span>
        </div>
        <div className="landing-script-copy">
          <p className="script-kicker">第 01 集 · 顾家宴会厅 · 夜</p>
          <p className="script-action">[苏晚推门而入，将婚书摔在桌上。满堂宾客瞬间安静。]</p>
          <p className="script-character">苏晚</p>
          <p className="script-dialogue">顾承川，三年前你们顾家逼死我爸。今天，我要你们十倍奉还。</p>
          <p className="script-action">[她亮出股权证明，顾老夫人脸色骤变。]</p>
          <p className="script-note">// 宗族 · 伦理 · 婚书设定</p>
        </div>

      </div>

      <div className="landing-script-layer landing-script-overseas" aria-hidden="true">
        <div className="landing-script-toolbar">
          <span>美国本土化剧本</span>
          <span>出海改编剧本</span>
        </div>
        <div className="landing-script-copy">
          <p className="script-kicker">1-1 夜 内卡特基金会宴会厅</p>
          <p className="script-action">△ 萝丝穿过闪光灯，把一份紧急股东决议推到艾登面前。大屏幕上，卡特集团的投票权已经易主。</p>
          <p className="script-character">萝丝</p>
          <p className="script-dialogue">三年前，你们夺走了我父亲的公司。今晚，我要亲手拿回来。</p>
          <p className="script-translation">（Three years ago, you stole my father's company. Tonight, I'm taking it back.）</p>
          <p className="script-action">△ 艾登伸手去拿决议，萝丝先一步按住签名页。</p>
          <p className="script-note">// 家族 · 企业 · 股东会议 · 英语口语节奏</p>
        </div>

      </div>

      <span className="landing-comparison-label label-original">原剧本</span>
      <span className="landing-comparison-label label-overseas">出海剧本</span>
      <div className="landing-comparison-divider" aria-hidden="true">
        <span><ChevronsLeftRight size={17} /></span>
      </div>
      <input
        className="landing-comparison-range"
        type="range"
        min="18"
        max="82"
        value={position}
        onChange={(event) => setPosition(Number(event.target.value))}
        aria-label="调整原剧本和出海剧本的对比范围"
      />
    </div>
  );
}

function ReviewRadar() {
  return (
    <div className="landing-review-score">
      <div className="landing-review-verdict">
        <div>
          <span>本稿审稿结果</span>
          <strong>84.3</strong>
          <small>/ 100</small>
        </div>
        <span className="landing-review-grade"> A </span>
      </div>
      <div className="landing-radar-wrap">
        <svg className="landing-radar" viewBox="0 0 300 270" role="img" aria-label="本稿在题材、故事、人物、节奏、对白和本土适配方面的表现">
          <g className="radar-grid">
            <polygon points="150,108 173.4,121.5 173.4,148.5 150,162 126.6,148.5 126.6,121.5" />
            <polygon points="150,81 196.8,108 196.8,162 150,189 103.2,162 103.2,108" />
            <polygon points="150,54 220.2,94.5 220.2,175.5 150,216 79.8,175.5 79.8,94.5" />
            <polygon points="150,45 227.9,90 227.9,180 150,225 72.1,180 72.1,90" />
            <path d="M150 45V225M72.1 90L227.9 180M227.9 90L72.1 180" />
          </g>
          <polygon className="radar-value" points="150,58.5 212.4,99 216.3,173.3 150,216 87.6,171 83.8,96.8" />
          <g className="radar-points">
            <circle cx="150" cy="58.5" r="4" />
            <circle cx="212.4" cy="99" r="4" />
            <circle cx="216.3" cy="173.3" r="4" />
            <circle cx="150" cy="216" r="4" />
            <circle cx="87.6" cy="171" r="4" />
            <circle cx="83.8" cy="96.8" r="4" />
          </g>
          <g className="radar-labels">
            <text x="150" y="22" textAnchor="middle">题材吸引力</text>
            <text x="238" y="82">故事完整度</text>
            <text x="238" y="193">人物吸引力</text>
            <text x="150" y="254" textAnchor="middle">追剧节奏</text>
            <text x="62" y="193" textAnchor="end">对白与可拍性</text>
            <text x="62" y="82" textAnchor="end">本土适配</text>
          </g>
        </svg>
      </div>
      <div className="landing-dimension-list">
        {reviewDimensions.map((dimension) => (
          <div className="landing-dimension" key={dimension.name}>
            <div>
              <span>{dimension.name}</span>
              <strong>{dimension.grade}</strong>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewFlowGraphic() {
  return (
    <div className="landing-review-flow-wrap">
      <svg className="landing-review-flow" viewBox="0 0 1000 338" role="img" aria-labelledby="review-flow-title review-flow-description">
        <title id="review-flow-title">海外主编审稿路径</title>
        <desc id="review-flow-description">从明确审稿目标开始，依次检查开篇留存、核查出海风险、判断制作价值，最后给出明确的修改结论。</desc>

        <g className="review-flow-heading">
          <text x="22" y="31">海外主编审稿路径</text>
          <text className="review-flow-heading-note" x="22" y="52">你会清楚知道在看什么，以及下一步怎么改</text>
          <path d="M22 68H978" />
        </g>

        <g className="review-flow-connector" aria-hidden="true">
          <path d="M198 175H213" />
          <path d="M209 170L215 175L209 180" />
          <path d="M395 175H410" />
          <path d="M406 170L412 175L406 180" />
          <path d="M592 175H607" />
          <path d="M603 170L609 175L603 180" />
          <path d="M789 175H804" />
          <path d="M800 170L806 175L800 180" />
        </g>

        <g className="review-flow-node" transform="translate(22 88)">
          <rect className="review-flow-card" width="174" height="174" />
          <rect className="review-flow-accent" width="174" height="3" />
          <rect className="review-flow-number" x="12" y="18" width="22" height="22" />
          <text className="review-flow-number-text" x="23" y="32" textAnchor="middle">1</text>
          <text className="review-flow-stage" x="42" y="32">先定范围</text>
          <text className="review-flow-title" x="16" y="67">说清这次要审什么</text>
          <path className="review-flow-divider" d="M16 84H158" />
          <text className="review-flow-note" x="16" y="108">要去哪里 · 给谁看 · 在哪播</text>
          <text className="review-flow-note" x="16" y="132">确认版本与本次重点</text>
        </g>

        <g className="review-flow-node retention-node" transform="translate(219 88)">
          <rect className="review-flow-card" width="174" height="174" />
          <rect className="review-flow-accent" width="174" height="3" />
          <rect className="review-flow-number" x="12" y="18" width="22" height="22" />
          <text className="review-flow-number-text" x="23" y="32" textAnchor="middle">2</text>
          <text className="review-flow-stage" x="42" y="32">先看开篇</text>
          <text className="review-flow-title" x="16" y="67">看开篇能不能留人</text>
          <path className="review-flow-divider" d="M16 84H158" />
          <text className="review-flow-note" x="16" y="108">第一集是否抓人、故事背景是否清晰勾勒</text>
          <text className="review-flow-note" x="16" y="132">一卡能否持续留人</text>
        </g>

        <g className="review-flow-node risk-node" transform="translate(416 88)">
          <rect className="review-flow-card" width="174" height="174" />
          <rect className="review-flow-accent" width="174" height="3" />
          <rect className="review-flow-number" x="12" y="18" width="22" height="22" />
          <text className="review-flow-number-text" x="23" y="32" textAnchor="middle">3</text>
          <text className="review-flow-stage" x="42" y="32">再查风险</text>
          <text className="review-flow-title" x="16" y="67">核查出海风险</text>
          <path className="review-flow-divider" d="M16 84H158" />
          <text className="review-flow-note" x="16" y="108">法律与分级 · 文化禁忌</text>
          <text className="review-flow-note" x="16" y="132">平台规则 · 发行限制</text>
        </g>

        <g className="review-flow-node value-node" transform="translate(613 88)">
          <rect className="review-flow-card" width="174" height="174" />
          <rect className="review-flow-accent" width="174" height="3" />
          <rect className="review-flow-number" x="12" y="18" width="22" height="22" />
          <text className="review-flow-number-text" x="23" y="32" textAnchor="middle">4</text>
          <text className="review-flow-stage" x="42" y="32">再看成片潜力</text>
          <text className="review-flow-title" x="16" y="67">判断值不值得拍</text>
          <path className="review-flow-divider" d="M16 84H158" />
          <text className="review-flow-note" x="16" y="108">题材 · 故事 · 人物 · 节奏</text>
          <text className="review-flow-note" x="16" y="132">对白是否自然 · 拍摄是否可行</text>
        </g>

        <g className="review-flow-node output-node" transform="translate(810 88)">
          <rect className="review-flow-card" width="174" height="174" />
          <rect className="review-flow-accent" width="174" height="3" />
          <rect className="review-flow-number" x="12" y="18" width="22" height="22" />
          <text className="review-flow-number-text" x="23" y="32" textAnchor="middle">5</text>
          <text className="review-flow-stage" x="42" y="32">最后给结论</text>
          <text className="review-flow-title" x="16" y="67">给出修改结论</text>
          <path className="review-flow-divider" d="M16 84H158" />
          <text className="review-flow-note" x="16" y="106">明确下一步怎么改</text>
          <g className="review-flow-verdicts" transform="translate(16 119)">
            <rect width="42" height="24" />
            <rect x="50" width="42" height="24" />
            <rect x="100" width="42" height="24" />
            <text x="21" y="16" textAnchor="middle">通过</text>
            <text x="71" y="16" textAnchor="middle">返修</text>
            <text x="121" y="16" textAnchor="middle">重选</text>
          </g>
          <text className="review-flow-footnote" x="16" y="161">必改项 · 修改顺序 · 验收标准</text>
        </g>

        <g className="review-flow-delivery" transform="translate(22 283)">
          <rect width="956" height="38" />
          <text className="review-flow-delivery-label" x="14" y="24">你最终拿到</text>
          <circle cx="116" cy="19" r="2.5" />
          <text x="128" y="24">一句话判断</text>
          <circle cx="300" cy="19" r="2.5" />
          <text x="312" y="24">关键问题层级</text>
          <circle cx="502" cy="19" r="2.5" />
          <text x="514" y="24">可执行修改清单</text>
          <circle cx="730" cy="19" r="2.5" />
          <text x="742" y="24">需要人工或法务复核的内容</text>
        </g>
      </svg>
    </div>
  );
}

export function LandingPage() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [activeAdvantage, setActiveAdvantage] = useState(0);
  const [advantagePaused, setAdvantagePaused] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const loginDialogRef = useRef<HTMLDialogElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const loginTriggerRef = useRef<HTMLElement | null>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const openLogin = useCallback(() => {
    const dialog = loginDialogRef.current;
    if (!dialog || dialog.open) return;
    loginTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setUserMenuOpen(false);
    setLoginError(null);
    dialog.showModal();
    window.requestAnimationFrame(() => usernameRef.current?.focus());
  }, []);

  const closeLogin = useCallback(() => {
    loginDialogRef.current?.close();
  }, []);

  useEffect(() => {
    let active = true;
    getSessionUser()
      .then((nextUser) => {
        if (active) setUser(nextUser);
      })
      .catch(() => {
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setAuthChecked(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("login") !== "1") return;

    params.delete("login");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    if (user) {
      window.location.href = "/workspace";
      return;
    }
    openLogin();
  }, [authChecked, openLogin, user]);

  useEffect(() => {
    if (!userMenuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !userMenuRef.current?.contains(event.target)) {
        setUserMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setUserMenuOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [userMenuOpen]);

  useEffect(() => {
    if (advantagePaused) return;
    const timer = window.setInterval(() => {
      setActiveAdvantage((current) => (current + 1) % productAdvantages.length);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [advantagePaused]);

  useEffect(() => {
    const sections = navigation
      .map((item) => document.getElementById(item.href.slice(1)))
      .filter((section): section is HTMLElement => Boolean(section));
    let frame = 0;

    function updateActiveSection() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const headerHeight = document.querySelector<HTMLElement>(".landing-header")?.getBoundingClientRect().height ?? 62;
        const marker = headerHeight + Math.min(260, window.innerHeight * 0.28);
        let current: string | null = null;
        for (const section of sections) {
          if (section.getBoundingClientRect().top <= marker) current = section.id;
        }
        setActiveSection(current);
      });
    }

    updateActiveSection();
    window.addEventListener("scroll", updateActiveSection, { passive: true });
    window.addEventListener("resize", updateActiveSection);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", updateActiveSection);
      window.removeEventListener("resize", updateActiveSection);
    };
  }, []);

  function handlePrimaryAction() {
    if (user) {
      window.location.href = "/workspace";
      return;
    }
    openLogin();
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError(null);
    try {
      const nextUser = await login(username.trim(), password);
      setUser(nextUser);
      loginDialogRef.current?.close();
      window.location.href = "/workspace";
    } catch (error) {
      setLoginError(
        hasErrorCode(error, HTTP_ERROR_CODES.LOGIN_FAILED)
          ? "账号或密码不正确"
          : error instanceof Error ? error.message : "登录失败"
      );
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleLogout() {
    await logout();
    setUser(null);
    setUserMenuOpen(false);
  }

  return (
    <main id="top" className="landing-page">
      <InteractiveDifferenceCursor />
      <header className="landing-header">
        <div className="landing-header-inner">
          <Brand />
          <nav className="landing-nav" aria-label="首页导航">
            {navigation.map((item) => (
              <a
                className={activeSection === item.href.slice(1) ? "is-active" : undefined}
                href={item.href}
                key={item.href}
                aria-current={activeSection === item.href.slice(1) ? "location" : undefined}
              >
                <span>{item.index}.</span>
                {item.label}
              </a>
            ))}
          </nav>
          <div className="landing-user-area" ref={userMenuRef}>
            <button className="landing-header-cta" type="button" onClick={handlePrimaryAction}>
              让剧本出海
              <ArrowRight size={15} />
            </button>
            <button
              className={`landing-user-button${user ? " is-authenticated" : ""}`}
              type="button"
              onClick={() => user ? setUserMenuOpen((open) => !open) : openLogin()}
              aria-label={user ? "打开用户菜单" : "登录"}
              aria-haspopup={user ? "menu" : "dialog"}
              aria-expanded={user ? userMenuOpen : undefined}
              data-auth-ready={authChecked}
              title={user ? user.display_name : "登录"}
            >
              <UserRound size={17} />
              {user ? <span className="landing-user-initial">{user.display_name?.[0] ?? user.username[0]}</span> : null}
              {user ? <ChevronDown size={13} /> : null}
            </button>
            {user && userMenuOpen ? (
              <div className="landing-user-menu" role="menu">
                <div className="landing-user-menu-head">
                  <span>{user.display_name}</span>
                  <small>@{user.username}</small>
                </div>
                <Link href="/workspace" role="menuitem" onClick={() => setUserMenuOpen(false)}>
                  <Workflow size={15} />
                  进入工作台
                </Link>
                <button type="button" role="menuitem" onClick={handleLogout}>
                  <LogOut size={15} />
                  退出登录
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <section className="landing-hero" aria-labelledby="hero-title">
        <div className="landing-hero-grid" aria-hidden="true" />
        <div className="landing-hero-inner">
          <div className="landing-hero-copy">
            <span className="landing-status-badge"><span />虎鲸漫剧出品</span>
            <h1 id="hero-title">出海剧作家</h1>
            <p className="landing-hero-subtitle">专注「剧本出海」的Agent平台</p>
            <p className="landing-hero-note">
              将您的剧作，保留爽点，轻松改写为符合当地口味的海外剧本。
            </p>
            <button className="landing-primary-action" type="button" onClick={handlePrimaryAction}>
              让剧本出海
              <ArrowRight size={18} />
            </button>
            <div className="landing-hero-footnote" aria-label="核心能力">
              <span>保住原剧爽点</span>
              <span>改成当地表达</span>
              <span>审清发行风险</span>
            </div>
          </div>
          <PipelineGraphic />
        </div>
        <a className="landing-scroll-index" href="#adaptation" aria-label="前往出海改编介绍">
          <span>01</span>
          <span />
          继续了解
        </a>
      </section>

      <div className="landing-mosaic">
        <section id="adaptation" className="landing-section landing-adaptation" aria-labelledby="adaptation-title">
          <div className="landing-section-heading">
            <div>
              <span className="landing-section-index">01 / 改编文化而不止改编内容</span>
              <h2 id="adaptation-title">同一场戏，不是翻成英文就够了</h2>
            </div>
            <p>我们会保住原剧最抓人的冲突与反转，再把人物关系、生活常识和对白改成当地观众熟悉的表达。</p>
          </div>
          <ScriptComparison />
          <div className="landing-adaptation-principles">
            <div><span>01</span><strong>保住原剧的爽点</strong><small>复仇、成长、身份反转和关键悬念都不会丢</small></div>
            <div><span>02</span><strong>让设定在当地成立</strong><small>职业、家庭关系和社会规则符合当地人的常识</small></div>
            <div><span>03</span><strong>让演员说得自然</strong><small>对白像当地人会说的话，动作也能直接拍出来</small></div>
          </div>
        </section>

        <section id="review" className="landing-section landing-review" aria-labelledby="review-title">
          <div className="landing-section-heading">
            <div>
              <span className="landing-section-index">02 / 模拟专业海外编剧审稿</span>
              <h2 id="review-title">AI审稿报告，从结论，到修改方案</h2>
            </div>
            <p>参照真实海外主编的审稿流程，多维化进行剧本评分评级，条条有依据，精确制定优化方案。</p>
          </div>
          <div className="landing-review-grid">
            <ReviewRadar />
            <div className="landing-review-insight">
              <span className="landing-insight-kicker">本稿结论</span>
              <strong>建议修改后推进：整体表现已经达到改编要求</strong>
              <p>法律分级、平台规则或文化禁忌不由内容评级替代。一旦发现问题，我们会单独标出，并建议交由主编或法务确认。</p>
              <div className="landing-verdict-options" aria-label="审稿结论类型">
                <span><CheckCircle2 size={15} />可以推进</span>
                <span><GitBranch size={15} />修改后再审</span>
                <span><X size={15} />暂不建议</span>
              </div>
              <div className="landing-review-artifacts">
                <div><ScanSearch size={19} /><span><strong>问题定位单</strong><small>具体到集数、场景和台词</small></span></div>
                <div><FileText size={19} /><span><strong>修改建议书</strong><small>列出必改项、先后顺序和验收标准</small></span></div>
              </div>
            </div>
          </div>
          <ReviewFlowGraphic />
        </section>

        <section id="advantages" className="landing-section landing-advantages" aria-labelledby="advantages-title">
          <div className="landing-section-heading">
            <div>
              <span className="landing-section-index">03 / 产品优势</span>
              <h2 id="advantages-title">专家级Agent打磨，创作过程始终可控</h2>
            </div>
            <p>保留原剧最值钱的爽点，复用实战SOP，用可随时接手的协作方式，以及越用越合拍的创作习惯，形成清晰可控的工作流。</p>
          </div>
          <div
            className={`landing-advantage-fence${advantagePaused ? " is-paused" : ""}`}
            onMouseEnter={() => setAdvantagePaused(true)}
            onMouseLeave={() => setAdvantagePaused(false)}
            onFocusCapture={() => setAdvantagePaused(true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setAdvantagePaused(false);
              }
            }}
          >
            {productAdvantages.map((advantage, index) => {
              const Icon = advantage.icon;
              const expanded = activeAdvantage === index;
              const detailId = `advantage-detail-${index}`;
              return (
                <article
                  className={`landing-advantage-slat${expanded ? " is-active" : ""}`}
                  key={advantage.category}
                  onMouseEnter={() => setActiveAdvantage(index)}
                  onFocus={() => setActiveAdvantage(index)}
                  tabIndex={0}
                  aria-labelledby={`advantage-title-${index}`}
                  aria-describedby={`advantage-summary-${index}`}
                  aria-expanded={expanded}
                >
                  <header className="landing-advantage-slat-trigger">
                    <span className="landing-advantage-slat-meta">
                      <span>{String(index + 1).padStart(2, "0")} / 04</span>
                      <Icon size={22} aria-hidden="true" />
                    </span>
                    <span className="landing-advantage-slat-heading">
                      <small>{advantage.category}</small>
                      <strong id={`advantage-title-${index}`}>{advantage.title}</strong>
                    </span>
                    <span className="landing-advantage-slat-summary" id={`advantage-summary-${index}`}>{advantage.summary}</span>
                    <span className="landing-advantage-hover-line" aria-hidden="true" />
                  </header>
                  <div
                    className="landing-advantage-slat-detail"
                    id={detailId}
                    aria-hidden={!expanded}
                  >
                    <div className="landing-advantage-slat-signals" aria-label={`${advantage.category}的关键能力`}>
                      {advantage.signals.map((signal) => <span key={signal}>{signal}</span>)}
                    </div>
                    <ol>
                      {advantage.details.map((detail, detailIndex) => (
                        <li key={detail.title}>
                          <span>{String(detailIndex + 1).padStart(2, "0")}</span>
                          <div>
                            <strong>{detail.title}</strong>
                            <p>{detail.description}</p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="landing-advantage-story" hidden>
            <article className="landing-advantage-chapter">
              <div className="landing-advantage-chapter-stage" data-chapter="01">
                <div className="landing-advantage-chapter-inner">
                  <header className="landing-advantage-chapter-copy">
                    <div className="landing-advantage-chapter-kicker">
                      <span>01 / 04</span>
                      <strong>内容优势｜改完之后，还是原来那个好故事</strong>
                      <Languages size={24} aria-hidden="true" />
                    </div>
                    <h3>爽点还在，<br /><span>故事不乱</span></h3>
                    <p>出海改的是表达，不是故事的灵魂。我们把设定、关系与对白改成当地观众熟悉的样子，但不动原剧最值钱的情绪与冲突。</p>
                    <div className="landing-advantage-chapter-mark">
                      <strong>双保</strong>
                      <span>爽点不丢 / 长篇不乱</span>
                    </div>
                  </header>
                  <div className="landing-advantage-chapter-body">
                    <div className="landing-advantage-art landing-advantage-art-content" aria-hidden="true">
                      <span>原剧爽点</span>
                      <div>
                        <small>冲突 · 反转 · 拉扯</small>
                        <ArrowRight size={28} />
                      </div>
                      <span>当地表达</span>
                    </div>
                    <ol className="landing-advantage-evidence">
                      <li>
                        <span>01</span>
                        <div><strong>保住原剧爽点，不做生硬直译</strong><p>复仇、成长、逆袭和情感拉扯都会保留，再换成当地观众熟悉的设定和对白。</p></div>
                      </li>
                      <li>
                        <span>02</span>
                        <div><strong>人物和伏笔不会越改越乱</strong><p>持续核对人物关系、关键道具、隐藏身份和前后伏笔，守住长篇一致。</p></div>
                      </li>
                    </ol>
                  </div>
                </div>
              </div>
            </article>

            <article className="landing-advantage-chapter">
              <div className="landing-advantage-chapter-stage" data-chapter="02">
                <div className="landing-advantage-chapter-inner">
                  <header className="landing-advantage-chapter-copy">
                    <div className="landing-advantage-chapter-kicker">
                      <span>02 / 04</span>
                      <strong>专业方法｜虎鲸特调 SOP</strong>
                      <Workflow size={24} aria-hidden="true" />
                    </div>
                    <h3>不是通用 AI，<br /><span>是虎鲸跑通的出海方法</span></h3>
                    <p>每一步都从虎鲸的专业实战经验中提炼，再由对应领域专家反复调教；不靠一句提示词撑完整部剧。</p>
                    <div className="landing-advantage-chapter-mark">
                      <strong>6 步</strong>
                      <span>从原稿梳理到海外审稿</span>
                    </div>
                  </header>
                  <div className="landing-advantage-chapter-body">
                    <div className="landing-advantage-art landing-advantage-art-sop" aria-hidden="true">
                      {["原稿梳理", "故事大纲", "人物设定", "剧本试稿", "完整剧本", "海外审稿"].map((label, index) => (
                        <span key={label}><b>{String(index + 1).padStart(2, "0")}</b><small>{label}</small></span>
                      ))}
                    </div>
                    <ol className="landing-advantage-evidence landing-advantage-evidence-compact">
                      <li><span>01</span><div><strong>六步出海 SOP</strong><p>每一步都有明确产物和确认点。</p></div></li>
                      <li><span>02</span><div><strong>专家共调的关键能力</strong><p>从大纲、人物、试稿到审稿，逐环节打磨。</p></div></li>
                      <li><span>03</span><div><strong>六维审核标准</strong><p>输出靠谱的审核报告和可执行的优化方案。</p></div></li>
                    </ol>
                  </div>
                </div>
              </div>
            </article>

            <article className="landing-advantage-chapter">
              <div className="landing-advantage-chapter-stage" data-chapter="03">
                <div className="landing-advantage-chapter-inner">
                  <header className="landing-advantage-chapter-copy">
                    <div className="landing-advantage-chapter-kicker">
                      <span>03 / 04</span>
                      <strong>创作体验｜全程可见、可改、可接手</strong>
                      <FileText size={24} aria-hidden="true" />
                    </div>
                    <h3>像纸笔一样轻盈，<br /><span>主动权始终在你手里</span></h3>
                    <p>复杂流程收在背后，你只需关注文档、修改和判断。想自己改就直接改，想交给它就说清楚。</p>
                    <div className="landing-advantage-chapter-mark">
                      <strong>全程</strong>
                      <span>你看得见，也随时改得动</span>
                    </div>
                  </header>
                  <div className="landing-advantage-chapter-body">
                    <div className="landing-advantage-art landing-advantage-art-control" aria-hidden="true">
                      <span><b>看得见</b><small>文档与进度</small></span>
                      <span><b>改得动</b><small>直改或对话</small></span>
                      <span><b>记得住</b><small>确认与叮咛</small></span>
                    </div>
                    <ol className="landing-advantage-evidence landing-advantage-evidence-compact">
                      <li><span>01</span><div><strong>过程全透明</strong><p>关键文档、执行步骤和调整记录都清晰可见。</p></div></li>
                      <li><span>02</span><div><strong>随时接手调整</strong><p>可以直接改文档，也可以用对话说清想法。</p></div></li>
                      <li><span>03</span><div><strong>长剧情记忆不断线</strong><p>持续记住人物、伏笔、每次确认和叮咛。</p></div></li>
                    </ol>
                  </div>
                </div>
              </div>
            </article>

            <article className="landing-advantage-chapter">
              <div className="landing-advantage-chapter-stage" data-chapter="04">
                <div className="landing-advantage-chapter-inner">
                  <header className="landing-advantage-chapter-copy">
                    <div className="landing-advantage-chapter-kicker">
                      <span>04 / 04</span>
                      <strong>成长进化｜习惯会沉淀，偏好由你定义</strong>
                      <Sparkles size={24} aria-hidden="true" />
                    </div>
                    <h3>每写一部，<br /><span>都比上一部更懂你</span></h3>
                    <p>每次对话和修改都不白费。反复出现的选择会被整理成可确认、可管理的创作偏好，带进下一次创作。</p>
                    <div className="landing-advantage-chapter-mark">
                      <strong>2 层</strong>
                      <span>环节偏好 / 全局创作观</span>
                    </div>
                  </header>
                  <div className="landing-advantage-chapter-body">
                    <div className="landing-advantage-art landing-advantage-art-evolution" aria-hidden="true">
                      <span>对话</span><ArrowRight size={20} />
                      <span>修改</span><ArrowRight size={20} />
                      <span>复盘</span><ArrowRight size={20} />
                      <strong>下一部，更懂你</strong>
                    </div>
                    <ol className="landing-advantage-evidence">
                      <li>
                        <span>01</span>
                        <div><strong>创作结束后主动复盘</strong><p>从对话、修改与审稿反馈中整理值得沉淀的习惯，经你确认后用于下一次创作。</p></div>
                      </li>
                      <li>
                        <span>02</span>
                        <div><strong>偏好由你主动定义</strong><p>可以为梗概、人物、试稿、全稿、审稿单独设定，也能用全局创作观贯穿每个项目。</p></div>
                      </li>
                    </ol>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section id="about" className="landing-section landing-about" aria-labelledby="about-title">
          <div className="landing-about-grid">
            <div className="landing-about-copy">
              <span className="landing-section-index">04 / 关于我们</span>
              <h2 id="about-title">虎鲸漫剧</h2>
              <p>我们是一家围绕 AI 短剧产业链，组织全球 AIGC 内容产能，完成商业化交付的，内容供应链运营公司。</p>
              <p>联系我们：<a className="landing-login-contact" href="https://hcnwhfahdfc4.feishu.cn/docx/V8R3dTngXocrfAxPuRxcTQBjnAb" target="_blank">👉点击了解「虎鲸漫剧」</a></p>
              <p>操作手册：<a className="landing-login-contact" href={OPERATION_MANUAL_URL} target="_blank" rel="noreferrer">👉点击查看「帮助文档」</a></p>
            </div>
            <div className="landing-supply-chain" aria-label="出海剧作家可衔接的服务范围">
              <div className="landing-chain-stage">
                <span>内容上游 / 01</span>
                <BookOpenText size={24} />
                <strong>剧本筛选与内容标准</strong>
              </div>
              <div className="landing-chain-stage">
                <span>制作中游 / 02</span>
                <UsersRound size={24} />
                <strong>短剧制作与产能协同</strong>
              </div>
              <div className="landing-chain-stage">
                <span>发行下游 / 03</span>
                <Globe2 size={24} />
                <strong>海内外发行与分账变现</strong>
              </div>
              <div className="landing-chain-ecosystem">
                <span><Target size={16} />创作者社区</span>
                <span><FileCheck2 size={16} />人才培训认证</span>
                <span><Clapperboard size={16} />产业园协作</span>
              </div>
            </div>
          </div>
          <div className="landing-final-cta">
            <div>
              <span>[ 准备好下一部剧了吗 ]</span>
              <h2>把下一部短剧，做成当地观众愿意追的故事</h2>
            </div>
            <button className="landing-primary-action" type="button" onClick={handlePrimaryAction}>
              让剧本出海
              <ArrowRight size={18} />
            </button>
          </div>
        </section>

        <footer className="landing-footer">
          <Brand />
          <span>© 2026 虎鲸漫剧 · 出海剧作家</span>
          <span>剧本改编 / 海外审稿 / 发行准备</span>
        </footer>
      </div>

      <dialog
        className="landing-login-dialog"
        ref={loginDialogRef}
        aria-labelledby="landing-login-title"
        onClick={(event) => {
          if (event.target === event.currentTarget) closeLogin();
        }}
        onClose={() => {
          setLoginError(null);
          loginTriggerRef.current?.focus();
        }}
      >
        <section className="landing-login-panel">
          <header>
            <div className="landing-login-brand">
              <span className="landing-logo-box" aria-hidden="true"><img src="/logo.png" alt="" /></span>
              <div>
                <h2 id="landing-login-title">登录｜出海剧作家</h2>
              </div>
            </div>
            <button type="button" onClick={closeLogin} aria-label="关闭登录窗口" title="关闭">
              <X size={18} />
            </button>
          </header>
          <p>进入创作台，开始你的剧本出海之旅</p>
          <form className="landing-login-form" onSubmit={handleLogin}>
            <label>
              <span>用户名</span>
              <div className="landing-login-input">
                <UserRound size={17} />
                <input
                  ref={usernameRef}
                  name="username"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                />
              </div>
            </label>
            <label>
              <span>密码</span>
              <div className="landing-login-input">
                <ShieldCheck size={17} />
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </div>
            </label>
            <div className="landing-login-message" aria-live="polite">
              {loginError ? <span>{loginError}</span> : null}
            </div>
            <button className="landing-login-submit" type="submit" disabled={loginBusy}>
              {loginBusy ? "登录中" : "进入工作台"}
              {loginBusy ? <Sparkles size={17} className="landing-login-spinner" /> : <ArrowRight size={17} />}
            </button>
          </form>
          <footer>
            <span>账号安全保护</span>
            <span><a className="landing-login-contact" href="https://hcnwhfahdfc4.feishu.cn/docx/V8R3dTngXocrfAxPuRxcTQBjnAb" target="_blank">账号申请&商务合作</a>
            </span>
          </footer>
        </section>
      </dialog>
    </main>
  );
}
