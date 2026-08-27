import "server-only";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  VerticalAlign,
  WidthType,
  type IRunStylePropertiesOptions,
  type ParagraphChild
} from "docx";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { normalizeReviewMarkdown, remarkReviewFocusRows } from "@/lib/review-markdown";

type HastNode = HastRoot | HastElement | HastText;
type HastRoot = { type: "root"; children: HastNode[] };
type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
};
type HastText = { type: "text"; value: string };

type BlockContext = {
  listDepth?: number;
  listInstance?: number;
  listReference?: "markdown-bullets" | "markdown-numbers";
  quote?: boolean;
  quotePriorityNote?: boolean;
  tableCell?: boolean;
  tableHeader?: boolean;
  tableFirstColumn?: boolean;
  variant?: MarkdownDocxVariant;
};

export type MarkdownDocxVariant = "default" | "review-report";

const COLORS = {
  body: "1F211F",
  muted: "6F716F",
  ocean: "1A344A",
  border: "C8C8C5",
  surface: "EFEFEB",
  stripe: "F7F7F5",
  red: "B54434",
  orange: "A25F16",
  green: "2F7552",
  blue: "286C90",
  purple: "76518D"
} as const;

const REVIEW_COLORS = {
  navy: "17364D",
  teal: "147C76",
  tealLight: "EAF5F3",
  red: "B54A42",
  redLight: "FCEFED",
  border: "CCD7DC",
  stripe: "F3F6F7",
  white: "FFFFFF"
} as const;

const BODY_FONT = "Arial Unicode MS";
const CODE_FONT = "Arial Unicode MS";
const TABLE_WIDTH_DXA = 9360;

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

function classNames(element: HastElement) {
  const value = element.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? value.split(/\s+/) : [];
}

function inlineStyleFor(element: HastElement, inherited: IRunStylePropertiesOptions) {
  let style: IRunStylePropertiesOptions = { ...inherited };
  const tag = element.tagName;
  if (tag === "strong" || tag === "b") style = { ...style, bold: true };
  if (tag === "em" || tag === "i") style = { ...style, italics: true };
  if (tag === "del" || tag === "s" || tag === "strike") style = { ...style, strike: true };
  if (tag === "u") style = { ...style, underline: { type: UnderlineType.SINGLE } };
  if (tag === "code") {
    style = {
      ...style,
      font: CODE_FONT,
      size: 20,
      color: COLORS.ocean,
      shading: { type: ShadingType.CLEAR, fill: COLORS.surface }
    };
  }

  for (const className of classNames(element)) {
    const colorName = className.replace(/^md-color-/, "") as keyof Pick<typeof COLORS, "red" | "orange" | "green" | "blue" | "purple">;
    if (className.startsWith("md-color-") && COLORS[colorName]) style = { ...style, color: COLORS[colorName] };
  }
  return style;
}

function normalizeInlineText(value: string) {
  return value.replace(/\s+/g, " ");
}

function inlineChildren(nodes: HastNode[], inherited: IRunStylePropertiesOptions = {}): ParagraphChild[] {
  return nodes.flatMap((node): ParagraphChild[] => {
    if (node.type === "text") {
      const text = normalizeInlineText(node.value);
      return text ? [new TextRun({ text, ...inherited })] : [];
    }
    if (node.type === "root") return inlineChildren(node.children, inherited);

    if (node.tagName === "br") return [new TextRun({ break: 1, ...inherited })];
    if (node.tagName === "input" && node.properties?.type === "checkbox") {
      return [new TextRun({ text: node.properties.checked ? "☒ " : "☐ ", ...inherited })];
    }
    if (node.tagName === "a") {
      const link = typeof node.properties?.href === "string" ? node.properties.href : "";
      const children = inlineChildren(node.children, {
        ...inherited,
        color: COLORS.ocean,
        bold: true,
        underline: { type: UnderlineType.SINGLE, color: COLORS.ocean }
      }).filter((child): child is TextRun => child instanceof TextRun);
      return link && children.length ? [new ExternalHyperlink({ link, children })] : children;
    }
    return inlineChildren(node.children, inlineStyleFor(node, inherited));
  });
}

function directInlineNodes(element: HastElement) {
  return element.children.filter((child) => (
    child.type === "text" || (isElement(child) && !["ul", "ol", "table", "blockquote", "pre"].includes(child.tagName))
  ));
}

// WPS can distribute CJK text before a manual Word line break. Screenplay
// source uses one line per beat, so preserve both Markdown and source breaks.
function inlineLines(nodes: HastNode[]) {
  const lines: HastNode[][] = [[]];
  const currentLine = () => lines[lines.length - 1]!;
  const startNextLine = () => {
    if (currentLine().length) lines.push([]);
  };

  for (const node of nodes) {
    if (isElement(node) && node.tagName === "br") {
      startNextLine();
      continue;
    }

    if (node.type === "text") {
      const segments = node.value.split(/\r\n?|\n/);
      segments.forEach((segment, index) => {
        if (segment) currentLine().push({ ...node, value: segment });
        if (index < segments.length - 1) startNextLine();
      });
      continue;
    }

    currentLine().push(node);
  }

  return lines.filter((line) => line.length);
}

function paragraphsFromElement(element: HastElement, context: BlockContext = {}) {
  const heading = {
    h1: HeadingLevel.HEADING_1,
    h2: HeadingLevel.HEADING_2,
    h3: HeadingLevel.HEADING_3,
    h4: HeadingLevel.HEADING_4,
    h5: HeadingLevel.HEADING_5,
    h6: HeadingLevel.HEADING_6
  }[element.tagName];
  const reviewVariant = context.variant === "review-report";
  const quoteBorder = context.quote ? {
    left: {
      style: BorderStyle.SINGLE,
      color: reviewVariant ? (context.quotePriorityNote ? REVIEW_COLORS.teal : REVIEW_COLORS.red) : COLORS.border,
      size: reviewVariant ? (context.quotePriorityNote ? 12 : 24) : 14,
      space: 8
    }
  } : undefined;
  const headingBorder = reviewVariant && element.tagName === "h2" ? {
    bottom: { style: BorderStyle.SINGLE, color: REVIEW_COLORS.teal, size: 8, space: 8 }
  } : undefined;
  const cellSpacing = context.tableCell
    ? { before: 0, after: 0, line: reviewVariant ? 320 : 280 }
    : undefined;

  const inlineStyle = context.tableHeader
    ? { bold: true, color: reviewVariant ? REVIEW_COLORS.white : COLORS.ocean, size: reviewVariant ? 22 : undefined }
    : reviewVariant && context.tableFirstColumn
      ? { bold: true, color: REVIEW_COLORS.navy, size: 22 }
    : context.quote
      ? { color: reviewVariant ? COLORS.body : COLORS.muted }
      : {};
  const lines = inlineLines(directInlineNodes(element));
  return lines.map((line, lineIndex) => new Paragraph({
    children: inlineChildren(line, inlineStyle),
    heading,
    border: quoteBorder ?? headingBorder,
    shading: context.quote && reviewVariant && !context.quotePriorityNote
      ? { type: ShadingType.CLEAR, fill: REVIEW_COLORS.redLight }
      : undefined,
    indent: context.quote ? { left: reviewVariant ? (context.quotePriorityNote ? 220 : 300) : 240, right: reviewVariant ? 180 : undefined } : undefined,
    numbering: context.listReference ? {
      reference: context.listReference,
      level: Math.min(context.listDepth ?? 0, 2),
      instance: context.listInstance
    } : undefined,
    spacing: lineIndex < lines.length - 1 && !context.tableCell
      ? { after: 0 }
      : context.quote && reviewVariant
        ? { before: 0, after: context.quotePriorityNote ? 40 : 80, line: context.quotePriorityNote ? 320 : 340 }
        : cellSpacing,
    keepNext: Boolean(heading)
  }));
}

function codeBlock(element: HastElement) {
  const text = element.children.map((child) => child.type === "text"
    ? child.value
    : isElement(child)
      ? child.children.map((item) => item.type === "text" ? item.value : "").join("")
      : "").join("").replace(/\n$/, "");
  const lines = text.split("\n");
  return new Paragraph({
    children: lines.map((line, index) => new TextRun({
      text: line || " ",
      break: index ? 1 : 0,
      font: CODE_FONT,
      size: 20,
      color: COLORS.body
    })),
    border: {
      top: { style: BorderStyle.SINGLE, color: COLORS.border, size: 4 },
      bottom: { style: BorderStyle.SINGLE, color: COLORS.border, size: 4 },
      left: { style: BorderStyle.SINGLE, color: COLORS.border, size: 4 },
      right: { style: BorderStyle.SINGLE, color: COLORS.border, size: 4 }
    },
    shading: { type: ShadingType.CLEAR, fill: COLORS.surface },
    indent: { left: 180, right: 180 },
    spacing: { before: 160, after: 160, line: 280 }
  });
}

function tableRows(element: HastElement) {
  const rows: HastElement[] = [];
  const visit = (node: HastNode) => {
    if (!isElement(node)) return;
    if (node.tagName === "tr") rows.push(node);
    else node.children.forEach(visit);
  };
  element.children.forEach(visit);
  return rows;
}

function elementText(element: HastElement): string {
  return element.children.map((child) => child.type === "text"
    ? child.value
    : isElement(child)
      ? elementText(child)
      : "").join("").trim();
}

function reviewColumnWidths(rows: HastElement[], columnCount: number) {
  if (columnCount !== 4) return null;
  const headerCells = rows[0]?.children.filter((child): child is HastElement => isElement(child) && ["th", "td"].includes(child.tagName)) ?? [];
  const headers = headerCells.map(elementText).join("|");
  if (headers === "分析维度|评级|结论|一句话判断") return [1560, 720, 960, 6120];
  if (headers === "检查项|评级|问题说明|原稿证据") return [1500, 960, 3000, 3900];
  return [1800, 900, 3000, 3660];
}

function tableFromElement(element: HastElement, nextListInstance: () => number, context: BlockContext) {
  const rows = tableRows(element);
  const columnCount = Math.max(1, ...rows.map((row) => row.children.filter((child) => isElement(child) && ["th", "td"].includes(child.tagName)).length));
  const baseWidth = Math.floor(TABLE_WIDTH_DXA / columnCount);
  const defaultWidths = Array.from({ length: columnCount }, (_, index) => (
    index === columnCount - 1 ? TABLE_WIDTH_DXA - baseWidth * (columnCount - 1) : baseWidth
  ));
  const reviewVariant = context.variant === "review-report";
  const columnWidths = reviewVariant ? reviewColumnWidths(rows, columnCount) ?? defaultWidths : defaultWidths;
  const border = {
    style: BorderStyle.SINGLE,
    color: reviewVariant ? REVIEW_COLORS.border : COLORS.border,
    size: reviewVariant ? 6 : 4
  } as const;

  return new Table({
    width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA },
    indent: { size: 120, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths,
    margins: reviewVariant
      ? { top: 150, bottom: 150, left: 170, right: 170 }
      : { top: 120, bottom: 120, left: 150, right: 150 },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: rows.map((row, rowIndex) => {
      const cells = row.children.filter((child): child is HastElement => isElement(child) && ["th", "td"].includes(child.tagName));
      const isHeader = cells.some((cell) => cell.tagName === "th");
      const focusRow = reviewVariant && classNames(row).includes("review-focus-row");
      return new TableRow({
        tableHeader: isHeader,
        cantSplit: true,
        children: Array.from({ length: columnCount }, (_, columnIndex) => {
          const cell = cells[columnIndex];
          const cellContext = {
            ...context,
            tableCell: true,
            tableHeader: isHeader,
            tableFirstColumn: !isHeader && columnIndex === 0
          };
          const containsBlocks = cell?.children.some((child) => isElement(child) && [
            "p", "ul", "ol", "blockquote", "pre", "table"
          ].includes(child.tagName));
          const children = cell
            ? containsBlocks
              ? blockChildren(cell.children, nextListInstance, cellContext)
              : paragraphsFromElement(cell, cellContext)
            : [];
          return new TableCell({
            width: { size: columnWidths[columnIndex], type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            shading: isHeader
              ? { type: ShadingType.CLEAR, fill: reviewVariant ? REVIEW_COLORS.navy : COLORS.surface }
              : focusRow
                ? { type: ShadingType.CLEAR, fill: REVIEW_COLORS.redLight }
              : rowIndex % 2 === 0
                ? { type: ShadingType.CLEAR, fill: reviewVariant ? REVIEW_COLORS.stripe : COLORS.stripe }
                : undefined,
            margins: reviewVariant
              ? { top: 150, bottom: 150, left: 170, right: 170 }
              : { top: 120, bottom: 120, left: 150, right: 150 },
            children: children.length ? children : [new Paragraph("")]
          });
        })
      });
    })
  });
}

function listChildren(element: HastElement, nextListInstance: () => number, context: BlockContext) {
  const reference = element.tagName === "ol" ? "markdown-numbers" : "markdown-bullets";
  const instance = nextListInstance();
  const level = context.listDepth ?? 0;
  return element.children.flatMap((child): Array<Paragraph | Table> => {
    if (!isElement(child) || child.tagName !== "li") return [];
    const lead = directInlineNodes(child).length
      ? paragraphsFromElement(child, { ...context, listReference: reference, listInstance: instance, listDepth: level })
      : [];
    const nested = child.children.flatMap((item): Array<Paragraph | Table> => {
      if (!isElement(item)) return [];
      if (item.tagName === "p" && !lead.length) {
        return paragraphsFromElement(item, { ...context, listReference: reference, listInstance: instance, listDepth: level });
      }
      if (item.tagName === "ul" || item.tagName === "ol") {
        return listChildren(item, nextListInstance, { ...context, listDepth: level + 1 });
      }
      return [];
    });
    return [...lead, ...nested];
  });
}

function blockChildren(nodes: HastNode[], nextListInstance: () => number, context: BlockContext = {}): Array<Paragraph | Table> {
  return nodes.flatMap((node): Array<Paragraph | Table> => {
    if (node.type === "text") return node.value.trim() ? [new Paragraph({ children: inlineChildren([node]) })] : [];
    if (node.type === "root") return blockChildren(node.children, nextListInstance, context);

    if (/^h[1-6]$/.test(node.tagName) || node.tagName === "p") return paragraphsFromElement(node, context);
    if (node.tagName === "ul" || node.tagName === "ol") return listChildren(node, nextListInstance, context);
    if (node.tagName === "blockquote") {
      const quotePriorityNote = context.variant === "review-report" && /^(?:P0|P1)：/u.test(elementText(node));
      return blockChildren(node.children, nextListInstance, { ...context, quote: true, quotePriorityNote });
    }
    if (node.tagName === "table") return [tableFromElement(node, nextListInstance, context)];
    if (node.tagName === "pre") return [codeBlock(node)];
    if (node.tagName === "hr") return [new Paragraph({ thematicBreak: true, spacing: { before: 160, after: 160 } })];
    return blockChildren(node.children, nextListInstance, context);
  });
}

function parseMarkdown(markdown: string, variant: MarkdownDocxVariant) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm);
  if (variant === "review-report") processor.use(remarkReviewFocusRows);
  processor
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw);
  return processor.runSync(processor.parse(markdown)) as HastRoot;
}

export function markdownToDocxElements(markdown: string, variant: MarkdownDocxVariant = "default") {
  let listInstance = 0;
  const nextListInstance = () => ++listInstance;
  const root = parseMarkdown(variant === "review-report" ? normalizeReviewMarkdown(markdown) : markdown, variant);
  return blockChildren(root.children, nextListInstance, { variant });
}

export async function markdownToDocxBuffer(
  markdown: string,
  title: string,
  metadata: { subject?: string; description?: string } = {}
) {
  const children = markdownToDocxElements(markdown);
  const document = new Document({
    title,
    subject: metadata.subject ?? "完整剧本",
    creator: "虎鲸剧本出海工作台",
    description: metadata.description ?? "由完整剧本 Markdown 版本导出",
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: 22, color: COLORS.body },
          paragraph: { spacing: { before: 0, after: 160, line: 320 } }
        },
        heading1: {
          run: { font: BODY_FONT, size: 32, bold: true, color: COLORS.ocean },
          paragraph: { spacing: { before: 320, after: 160, line: 280 }, keepNext: true, outlineLevel: 0 }
        },
        heading2: {
          run: { font: BODY_FONT, size: 26, bold: true, color: COLORS.ocean },
          paragraph: { spacing: { before: 240, after: 120, line: 280 }, keepNext: true, outlineLevel: 1 }
        },
        heading3: {
          run: { font: BODY_FONT, size: 24, bold: true, color: COLORS.ocean },
          paragraph: { spacing: { before: 200, after: 100, line: 280 }, keepNext: true, outlineLevel: 2 }
        },
        hyperlink: {
          run: { color: COLORS.ocean, underline: { type: UnderlineType.SINGLE, color: COLORS.ocean } }
        }
      }
    },
    numbering: {
      config: [
        {
          reference: "markdown-bullets",
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.BULLET,
            text: ["•", "◦", "▪"][level],
            alignment: AlignmentType.LEFT,
            style: {
              paragraph: {
                indent: { left: 720 + level * 360, hanging: 360 },
                spacing: { before: 0, after: 60, line: 320 }
              },
              run: { font: BODY_FONT, size: 22, color: COLORS.body }
            }
          }))
        },
        {
          reference: "markdown-numbers",
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
            style: {
              paragraph: {
                indent: { left: 720 + level * 360, hanging: 360 },
                spacing: { before: 0, after: 60, line: 320 }
              },
              run: { font: BODY_FONT, size: 22, color: COLORS.body }
            }
          }))
        }
      ]
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 708, footer: 708 }
        }
      },
      children: children.length ? children : [new Paragraph("")]
    }]
  });

  return Packer.toBuffer(document);
}
