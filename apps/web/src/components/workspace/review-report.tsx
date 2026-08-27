import { getMarkdownHeadings, renderMarkdown } from "@/lib/markdown";

type ReviewReportProps = {
  content: string;
  printMode?: boolean;
};

export function ReviewReport({ content, printMode = false }: ReviewReportProps) {
  const headings = getMarkdownHeadings(content);
  const className = ["review-report", printMode ? "print-report" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={className} data-review-report-ready="true">
      <section className="review-report-markdown markdown-preview" aria-label="审稿报告详细内容">
        {renderMarkdown(content, headings, { reviewReport: true })}
      </section>
    </article>
  );
}
