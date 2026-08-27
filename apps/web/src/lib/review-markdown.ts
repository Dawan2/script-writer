type MarkdownNode = {
  type?: string;
  value?: string;
  children?: MarkdownNode[];
  data?: Record<string, unknown>;
};

const REVIEW_FOCUS_MARKER = "[[重点]]";

function addFocusedRowMarkers(markdown: string) {
  const detailsStart = markdown.indexOf("## 四、评分细则");
  const detailsEnd = detailsStart < 0 ? -1 : markdown.indexOf("\n## 五、修改建议", detailsStart);
  if (detailsStart < 0) return markdown;

  const before = markdown.slice(0, detailsStart);
  const details = markdown.slice(detailsStart, detailsEnd < 0 ? markdown.length : detailsEnd);
  const after = detailsEnd < 0 ? "" : markdown.slice(detailsEnd);
  const firstDimension = details.search(/^###\s+1\.\s+/mu);
  if (firstDimension < 0) return markdown;

  const intro = details.slice(0, firstDimension);
  const focusedChecks = new Set(
    [...intro.matchAll(/\*\*([^*\r\n]+?)\*\*/gu)]
      .map((match) => match[1].trim())
      .filter(Boolean)
  );
  if (!focusedChecks.size) return markdown;

  const markedDetails = details.split("\n").map((line) => {
    const row = /^(\|\s*)([^|]+?)(\s*\|.*)$/u.exec(line);
    if (!row || row[2].includes(REVIEW_FOCUS_MARKER)) return line;
    const checkName = row[2].replace(/\*\*/gu, "").trim();
    return focusedChecks.has(checkName)
      ? `${row[1]}${REVIEW_FOCUS_MARKER} ${row[2].trim()}${row[3]}`
      : line;
  }).join("\n");

  return `${before}${markedDetails}${after}`;
}

function removeFocusMarker(node: MarkdownNode): boolean {
  if (node.type === "text" && typeof node.value === "string" && node.value.includes(REVIEW_FOCUS_MARKER)) {
    node.value = node.value.replaceAll(REVIEW_FOCUS_MARKER, "").replace(/^\s+/u, "");
    return true;
  }
  return node.children?.some(removeFocusMarker) ?? false;
}

/** Add a semantic class to score-detail rows named in the score-detail lead. */
export function remarkReviewFocusRows() {
  return (tree: any) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === "tableRow" && node.children?.[0] && removeFocusMarker(node.children[0])) {
        const data = node.data ?? {};
        const properties = (data.hProperties && typeof data.hProperties === "object")
          ? data.hProperties as Record<string, unknown>
          : {};
        node.data = {
          ...data,
          hProperties: {
            ...properties,
            className: "review-focus-row"
          }
        };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/** Normalize report typography and expose semantic emphasis for every renderer. */
export function normalizeReviewMarkdown(markdown: string) {
  let fence: "`" | "~" | null = null;

  const normalized = markdown.split(/\r?\n/).map((line) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      fence = fence === marker ? null : fence ?? marker;
      return line;
    }
    if (fence) return line;

    return line
      .replace(/\\\*\\\*([^\n]*?)\\\*\\\*/g, "**$1**")
      // Markdown cannot close emphasis directly before a CJK word character.
      .replace(/(?<![\p{L}\p{N}])\*\*([^*\r\n]+?)\*\*(?=[\p{L}\p{N}])/gu, "**$1** ")
      .replace(/。；|；。/gu, "；");
  }).join("\n");

  return addFocusedRowMarkers(normalized);
}
