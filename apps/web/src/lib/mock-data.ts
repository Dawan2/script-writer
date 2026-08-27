import {
  BookOpenText,
  FileCheck2,
  FilePenLine,
  FileText,
  ScrollText,
  ShieldCheck
} from "lucide-react";

export type ScriptProject = {
  id: string;
  name: string;
  stage: string;
  time: string;
  pinned?: boolean;
  status: "active" | "ready" | "idle";
};

export type StageFile = {
  index: number;
  name: string;
  status: "done" | "current" | "locked";
  icon: typeof FileText;
};

export const projects: ScriptProject[] = [
  { id: "1", name: "十八岁太奶奶", stage: "故事梗概", time: "今天 14:32", pinned: true, status: "active" },
  { id: "2", name: "归来的继承人", stage: "人物小传", time: "昨天 18:07", pinned: true, status: "ready" },
  { id: "3", name: "午夜契约", stage: "剧本试稿", time: "昨天 11:24", pinned: false, status: "ready" },
  { id: "4", name: "重生之逆流而上", stage: "完整剧本", time: "05-18 22:10", pinned: false, status: "idle" },
  { id: "5", name: "致命偏爱", stage: "原始剧本", time: "05-18 16:45", pinned: false, status: "idle" },
  { id: "6", name: "她的复仇日记", stage: "剧本试稿", time: "05-17 09:31", pinned: false, status: "idle" }
];

export const stageFiles: StageFile[] = [
  { index: 1, name: "原始剧本", status: "done", icon: FileText },
  { index: 2, name: "故事梗概", status: "current", icon: BookOpenText },
  { index: 3, name: "人物小传", status: "locked", icon: FilePenLine },
  { index: 4, name: "剧本试稿", status: "locked", icon: ScrollText },
  { index: 5, name: "完整剧本", status: "locked", icon: FileCheck2 },
  { index: 6, name: "AI审稿", status: "locked", icon: ShieldCheck }
];

export const agentLogs = [
  { time: "14:30", text: "已读取原始剧本，识别 90 集短剧结构。", state: "done" },
  { time: "14:31", text: "正在整理核心冲突、爽点和阶段钩子。", state: "done" },
  { time: "14:32", text: "准备生成海外版人物小传草稿。", state: "running" }
] as const;
