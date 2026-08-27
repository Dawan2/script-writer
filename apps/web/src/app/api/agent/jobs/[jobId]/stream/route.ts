import { backendFetch } from "@/lib/server/backend";

type Params = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, context: Params) {
  const { jobId } = await context.params;
  const url = new URL(request.url);
  const afterId = url.searchParams.get("after_id");
  // 进展流不设总超时：EventSource 发不出预算请求头，长任务的进展也不该被总超时掐断。
  const response = await backendFetch(
    `/agent/jobs/${jobId}/stream${afterId ? `?after_id=${encodeURIComponent(afterId)}` : ""}`,
    {},
    { noTimeout: true }
  );
  return new Response(response.body, {
    status: response.status,
    headers: {
      "cache-control": "no-store",
      "content-type": response.headers.get("content-type") ?? "text/event-stream"
    }
  });
}
