import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, context: Params) {
  const { jobId } = await context.params;
  return proxyJson(`/agent/jobs/${jobId}`);
}
