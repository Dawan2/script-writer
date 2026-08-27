import { notFound } from "next/navigation";
import { ReviewReport } from "@/components/workspace/review-report";
import { backendFetch } from "@/lib/server/backend";
import type { StageDocument } from "@/lib/types";

type PageProps = {
  params: Promise<{ projectId: string }>;
};

export const dynamic = "force-dynamic";

export default async function ReviewReportPage({ params }: PageProps) {
  const { projectId } = await params;
  const response = await backendFetch(`/projects/${projectId}/files/foreign_review`);
  if (response.status === 404) notFound();
  if (!response.ok) {
    throw new Error(`审稿报告加载失败：${response.status}`);
  }

  const payload = await response.json() as { file: StageDocument };

  return (
    <main className="review-print-page">
      <ReviewReport
        content={payload.file.content}
        printMode
      />
    </main>
  );
}
