import { AgentLoadingMessage } from "@/components/ui/agent-loading-message";

type PageLoadingProps = {
  label?: string;
  detail?: string;
  variant?: "compact" | "workspace";
  agentStage?: string;
};

export function PageLoading({
  label = "正在加载",
  detail = "Loading",
  variant = "compact",
  agentStage
}: PageLoadingProps) {
  const variantClass = variant === "workspace" ? "workspace-loading" : "compact-loading";

  return (
    <div className={`page-loading ${variantClass}`} role="status" aria-live="polite" aria-busy="true">
      <span className="document-lock-loader" aria-hidden="true" />
      {!agentStage ? <strong>{label}</strong> : null}
      {agentStage ? <AgentLoadingMessage stage={agentStage} /> : <span>{detail}</span>}
    </div>
  );
}
