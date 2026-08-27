"use client";

import { useEffect, useState } from "react";
import loadingEstimates from "@/config/agent-loading-estimates.json";

const LOADING_MESSAGES = [
  "小编正在调整台灯亮度",
  "小编正在调整坐姿",
  "小编正在通读全文",
  "小编正在理解世界",
  "小编正在伸懒腰",
  "小编喝了杯咖啡",
  "小编正在提笔踟蹰",
  "小编正在翻找灵感便签",
  "小编正在给故事排练开场",
  "小编正在把散落的线索串起来",
  "小编正在为角色留一盏灯",
  "小编正在琢磨下一次心跳",
  "小编正在整理脑海里的分镜",
  "小编正在把情绪放进字里行间",
  "小编正在给转折多留一点悬念",
  "小编正在和角色聊聊天",
  "小编正在确认每一句话的分量",
  "小编正在把故事线轻轻理顺",
  "小编正在让场景慢慢亮起来",
  "小编正在给人物补一笔神采",
  "小编正在检查伏笔有没有藏好",
  "小编正在把灵感从窗边请进来",
  "小编正在为故事配一段心跳",
  "小编正在把节奏调到刚刚好",
  "小编正在认真听角色怎么说",
  "小编正在给文字泡一会儿茶",
  "小编正在让故事自己讲下去",
  "小编正在把想象力擦得亮一点",
  "小编正在给下一幕预留惊喜",
  "小编正在挑选恰到好处的词",
  "小编正在把细节一一安放"
];

type AgentLoadingStage = keyof typeof loadingEstimates;

const STAGE_LOADING_MESSAGES: Partial<Record<AgentLoadingStage, readonly string[]>> = {
  novel_analysis: [
    "小编正在按章节通读小说",
    "小编正在梳理人物欲望与关系变化",
    "小编正在把主线因果串起来",
    "小编正在标记值得保留的高光时刻",
    "小编正在划分连续的剧情单元",
    "小编正在从结局向前复核线索"
  ],
  humanizer_zh: [
    "小编正在通读剧本，标记需要打磨的表达",
    "小编正在保留人物关系与关键情节",
    "小编正在让台词更贴近人物当下的处境",
    "小编正在把概括性的表达落回动作和反应",
    "小编正在调整场景节奏与对白分量",
    "小编正在逐集核对人物声线和集尾承接",
    "小编正在整理润色后的剧本"
  ]
};

type AgentLoadingMessageProps = {
  stage: string;
  className?: string;
};

function isAgentLoadingStage(stage: string): stage is AgentLoadingStage {
  return stage in loadingEstimates;
}

export function AgentLoadingMessage({ stage, className }: AgentLoadingMessageProps) {
  const [messageIndex, setMessageIndex] = useState(0);
  const estimate = isAgentLoadingStage(stage) ? loadingEstimates[stage] : null;
  const messages = isAgentLoadingStage(stage) ? (STAGE_LOADING_MESSAGES[stage] ?? LOADING_MESSAGES) : LOADING_MESSAGES;

  useEffect(() => {
    setMessageIndex(0);
    const timer = window.setInterval(() => {
      setMessageIndex((current) => {
        let next = Math.floor(Math.random() * messages.length);
        if (messages.length > 1 && next === current) {
          next = (next + 1) % messages.length;
        }
        return next;
      });
    }, 3000);

    return () => window.clearInterval(timer);
  }, [messages, stage]);

  if (!estimate) return null;

  return (
    <span className={["agent-loading-message", className].filter(Boolean).join(" ")}>
      <span className="agent-loading-summary">
        {estimate.label}预计 {estimate.estimatedMinutes} 分钟，您可休息一会再来看看。
      </span>
      <span className="agent-loading-dynamic">{messages[messageIndex]}</span>
    </span>
  );
}
