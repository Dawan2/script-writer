import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { normalizeReviewMarkdown, remarkReviewFocusRows } from "@/lib/review-markdown";

export const MARKDOWN_TEXT_COLORS = [
  { id: "red", label: "红色", value: "#b54434" },
  { id: "orange", label: "橙色", value: "#a25f16" },
  { id: "green", label: "绿色", value: "#2f7552" },
  { id: "blue", label: "蓝色", value: "#286c90" },
  { id: "purple", label: "紫色", value: "#76518d" }
] as const;

export type MarkdownTextColor = (typeof MARKDOWN_TEXT_COLORS)[number];

const markdownSanitizeSchema: NonNullable<Parameters<typeof rehypeSanitize>[0]> = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [["className", ...MARKDOWN_TEXT_COLORS.map((color) => `md-color-${color.id}`)]],
    // 评分细则中的重点行由 remarkReviewFocusRows 添加，仅允许这一受控类名。
    tr: [["className", "review-focus-row"]]
  },
  tagNames: [...(defaultSchema.tagNames ?? []), "u"]
};

export type MarkdownHeading = {
  id: string;
  level: 1 | 2 | 3;
  text: string;
  line: number;
};

type MarkdownAstNode = {
  children?: MarkdownAstNode[];
  type: string;
  value?: string;
};

type RenderMarkdownOptions = {
  preserveLineBreaks?: boolean;
  reviewReport?: boolean;
};

function nodeText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = "value" in node && typeof node.value === "string" ? node.value : "";
  const children = "children" in node && Array.isArray(node.children) ? node.children : [];
  return `${value}${children.map(nodeText).join("")}`;
}

function reviewTableClass(node: unknown, reviewReport: boolean) {
  if (!reviewReport) return "";
  const content = nodeText(node);
  if (content.includes("检查项") && content.includes("问题说明") && content.includes("原稿证据")) return "review-detail-table";
  if (content.includes("分析维度") && content.includes("一句话判断")) return "review-dimension-summary-table";
  return "review-generic-table";
}

function remarkSoftLineBreaks() {
  return (tree: MarkdownAstNode) => {
    function replaceSoftLineBreaks(node: MarkdownAstNode) {
      if (!node.children) return;

      node.children = node.children.flatMap((child) => {
        replaceSoftLineBreaks(child);
        if (child.type !== "text" || !child.value?.includes("\n")) return [child];

        return child.value.split(/\r?\n/).flatMap((value, index) => (
          index === 0 ? [{ ...child, value }] : [{ type: "break" }, { ...child, value }]
        ));
      });
    }

    replaceSoftLineBreaks(tree);
  };
}

function headingId(text: string, line: number) {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `md-${line}-${normalized || "heading"}`;
}

export function getMarkdownHeadings(markdown: string): MarkdownHeading[] {
  return markdown.split(/\r?\n/).flatMap((line, index) => {
    const match = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (!match) return [];
    const level = match[1].length as 1 | 2 | 3;
    const text = match[2].trim();
    return [{ id: headingId(text, index + 1), level, text, line: index + 1 }];
  });
}

export function renderMarkdown(
  markdown: string,
  headings: MarkdownHeading[] = [],
  { preserveLineBreaks = false, reviewReport = false }: RenderMarkdownOptions = {}
): ReactNode {
  const normalizedMarkdown = reviewReport ? normalizeReviewMarkdown(markdown) : markdown;
  const headingByLine = new Map(headings.map((heading) => [heading.line, heading]));
  const headingIdForNode = (node: { position?: { start?: { line?: number } } } | undefined) => {
    const line = node?.position?.start?.line;
    return typeof line === "number" ? headingByLine.get(line)?.id : undefined;
  };

  const components: Components = {
    h1({ node, children, ...props }) {
      return <h1 {...props} id={headingIdForNode(node)}>{children}</h1>;
    },
    h2({ node, children, ...props }) {
      return <h2 {...props} id={headingIdForNode(node)}>{children}</h2>;
    },
    h3({ node, children, ...props }) {
      return <h3 {...props} id={headingIdForNode(node)}>{children}</h3>;
    },
    blockquote({ node, children, ...props }) {
      const priorityNote = reviewReport && /^(?:P0|P1)：/u.test(nodeText(node).trim());
      return (
        <blockquote
          {...props}
          className={[props.className, priorityNote ? "review-priority-note" : ""].filter(Boolean).join(" ") || undefined}
        >
          {children}
        </blockquote>
      );
    },
    table({ node, ...props }) {
      const reviewClass = reviewTableClass(node, reviewReport);
      return (
        <div className="markdown-table-scroll">
          <table {...props} className={[props.className, reviewClass].filter(Boolean).join(" ") || undefined} />
        </div>
      );
    }
  };

  return (
    <ReactMarkdown
      components={components}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema]]}
      remarkPlugins={[
        remarkGfm,
        ...(preserveLineBreaks || reviewReport ? [remarkSoftLineBreaks] : []),
        ...(reviewReport ? [remarkReviewFocusRows] : [])
      ]}
    >
      {normalizedMarkdown}
    </ReactMarkdown>
  );
}
