import { BookOpenText, Clapperboard, Copy, Languages, ShieldCheck, WandSparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Project } from "@/lib/types";

export type ProjectTaskType = Project["task_type"];

export type ProjectScenario = {
  key: ProjectTaskType;
  label: string;
  icon: LucideIcon;
  color: string;
};

export const PROJECT_SCENARIOS: readonly ProjectScenario[] = [
  { key: "rewrite", label: "剧本改写", icon: Clapperboard, color: "#0f766e" },
  { key: "novel", label: "小说改编", icon: BookOpenText, color: "#2563eb" },
  { key: "replicate", label: "爆款复刻", icon: Copy, color: "#be123c" },
  { key: "review", label: "剧本审核", icon: ShieldCheck, color: "#c2410c" },
  { key: "translate", label: "台词翻译", icon: Languages, color: "#6d5bd0" },
  { key: "humanize", label: "剧本润色", icon: WandSparkles, color: "#b45309" }
];

export function getProjectScenario(taskType: ProjectTaskType): ProjectScenario {
  return PROJECT_SCENARIOS.find((scenario) => scenario.key === taskType) ?? PROJECT_SCENARIOS[0]!;
}
