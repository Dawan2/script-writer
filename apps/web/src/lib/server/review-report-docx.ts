import "server-only";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  TextRun,
  type ParagraphChild
} from "docx";
import { markdownToDocxElements } from "@/lib/server/markdown-docx";
import type { ReviewScorecard } from "@/lib/types";

// macOS 与常见 Office 环境都可用的中英文覆盖字体；缺失时由 Word 回退至系统中文字体。
const FONT = "Arial Unicode MS";
const COLORS = {
  body: "20282E",
  muted: "66757F",
  navy: "17364D",
  teal: "147C76",
  tealLight: "EAF5F3",
  red: "B54A42",
  redLight: "FCEFED",
  border: "CCD7DC",
  white: "FFFFFF"
} as const;

const A4_WIDTH_DXA = 11906;
const A4_HEIGHT_DXA = 16838;
const PAGE_MARGIN_X_DXA = 1134;
const PAGE_MARGIN_Y_DXA = 1134;

function run(text: string, options: { size?: number; color?: string; bold?: boolean; break?: number } = {}) {
  return new TextRun({
    text,
    font: FONT,
    size: options.size ?? 25,
    color: options.color ?? COLORS.body,
    bold: options.bold,
    break: options.break
  });
}

function coverMetadata(label: string, value: string) {
  return new Paragraph({
    children: [run(`${label}  `, { size: 23, color: COLORS.navy, bold: true }), run(value || "未提供", { size: 23, color: COLORS.muted })],
    spacing: { before: 0, after: 90, line: 320 }
  });
}

function reportHeader(scriptName: string) {
  return new Header({
    children: [new Paragraph({
      children: [run("审稿报告", { size: 18, color: COLORS.navy, bold: true }), run(`  ·  ${scriptName}`, { size: 18, color: COLORS.muted })],
      border: { bottom: { style: BorderStyle.SINGLE, color: COLORS.teal, size: 8, space: 6 } },
      spacing: { after: 0, line: 240 }
    })]
  });
}

function reportFooter() {
  const children: ParagraphChild[] = [
    run("仅针对当前提交版本  ·  ", { size: 18, color: COLORS.muted }),
    new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18, color: COLORS.muted }),
    run(" / ", { size: 18, color: COLORS.muted }),
    new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: 18, color: COLORS.muted })
  ];
  return new Footer({
    children: [new Paragraph({ children, alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0, line: 240 } })]
  });
}

function cover(scorecard: ReviewScorecard) {
  const scriptName = scorecard.basic_info.script_name.trim() || "未命名剧本";
  const grade = scorecard.overall.grade ?? "--";
  const tags = scorecard.basic_info.genre_tags.filter(Boolean).join("  ·  ") || "未提供题材标签";

  return [
    new Paragraph({ spacing: { before: 460, after: 0 } }),
    new Paragraph({
      children: [run("漫剧出海  /  SCRIPT REVIEW", { size: 19, color: COLORS.teal, bold: true })],
      spacing: { before: 0, after: 360, line: 240 }
    }),
    new Paragraph({
      children: [run(scriptName, { size: 56, color: COLORS.navy, bold: true })],
      border: { bottom: { style: BorderStyle.SINGLE, color: COLORS.teal, size: 12, space: 8 } },
      spacing: { before: 0, after: 120, line: 620 },
      keepNext: true
    }),
    new Paragraph({
      children: [run("审稿报告", { size: 28, color: COLORS.muted, bold: true })],
      spacing: { before: 0, after: 340, line: 360 }
    }),
    new Paragraph({
      children: [run(`审核结论：${scorecard.verdict.label}`, { size: 31, color: COLORS.red, bold: true })],
      border: { left: { style: BorderStyle.SINGLE, color: COLORS.red, size: 28, space: 10 } },
      shading: { type: ShadingType.CLEAR, fill: COLORS.redLight },
      indent: { left: 280, right: 240 },
      spacing: { before: 0, after: 0, line: 380 },
      keepNext: true
    }),
    new Paragraph({
      children: [run(scorecard.verdict.summary, { size: 25, color: COLORS.body, bold: true })],
      border: { left: { style: BorderStyle.SINGLE, color: COLORS.red, size: 28, space: 10 } },
      shading: { type: ShadingType.CLEAR, fill: COLORS.redLight },
      indent: { left: 280, right: 240 },
      spacing: { before: 0, after: 260, line: 360 }
    }),
    new Paragraph({
      children: [run("内容潜力评级  ", { size: 30, color: COLORS.navy, bold: true }), run(grade, { size: 42, color: COLORS.teal, bold: true })],
      spacing: { before: 0, after: 100, line: 460 },
      keepNext: true
    }),
    new Paragraph({
      children: [run(tags, { size: 22, color: COLORS.teal, bold: true })],
      shading: { type: ShadingType.CLEAR, fill: COLORS.tealLight },
      indent: { left: 200, right: 200 },
      spacing: { before: 0, after: 220, line: 320 }
    }),
    coverMetadata("目标市场", scorecard.basic_info.target_region),
    coverMetadata("目标语言", scorecard.basic_info.target_language),
    coverMetadata("审核性质", "当前版本初审"),
    new Paragraph({
      children: [run("本报告仅评估当前提交版本及其可生产性，不对创作者个人作价值判断。", { size: 20, color: COLORS.muted })],
      spacing: { before: 220, after: 0, line: 280 }
    }),
    new Paragraph({ children: [new PageBreak()] })
  ];
}

export async function reviewReportToDocxBuffer(markdown: string, scorecard: ReviewScorecard) {
  const scriptName = scorecard.basic_info.script_name.trim() || "海外审稿";
  const reportBody = markdown.replace(/^\uFEFF?#\s+[^\n]+\n+/u, "");
  const children = [...cover(scorecard), ...markdownToDocxElements(reportBody, "review-report")];
  const document = new Document({
    title: `${scriptName}-审稿报告`,
    subject: "审稿报告",
    creator: "虎鲸剧本出海工作台",
    description: "主编审稿、选稿判断与返修建议",
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 25, color: COLORS.body },
          paragraph: { spacing: { before: 0, after: 170, line: 360 } }
        },
        heading1: {
          run: { font: FONT, size: 42, bold: true, color: COLORS.navy },
          paragraph: { spacing: { before: 360, after: 180, line: 460 }, keepNext: true, outlineLevel: 0 }
        },
        heading2: {
          run: { font: FONT, size: 34, bold: true, color: COLORS.navy },
          paragraph: { spacing: { before: 340, after: 170, line: 420 }, keepNext: true, outlineLevel: 1 }
        },
        heading3: {
          run: { font: FONT, size: 29, bold: true, color: COLORS.teal },
          paragraph: { spacing: { before: 260, after: 130, line: 360 }, keepNext: true, outlineLevel: 2 }
        },
        heading4: {
          run: { font: FONT, size: 26, bold: true, color: COLORS.teal },
          paragraph: { spacing: { before: 220, after: 110, line: 340 }, keepNext: true, outlineLevel: 3 }
        },
        hyperlink: {
          run: { color: COLORS.teal, underline: { color: COLORS.teal } }
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
                indent: { left: 600 + level * 360, hanging: 300 },
                spacing: { before: 0, after: 90, line: 350 }
              },
              run: { font: FONT, size: 24, color: COLORS.body }
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
                indent: { left: 600 + level * 360, hanging: 300 },
                spacing: { before: 0, after: 90, line: 350 }
              },
              run: { font: FONT, size: 24, color: COLORS.teal, bold: true }
            }
          }))
        }
      ]
    },
    sections: [{
      properties: {
        page: {
          size: { width: A4_WIDTH_DXA, height: A4_HEIGHT_DXA },
          margin: {
            top: PAGE_MARGIN_Y_DXA,
            right: PAGE_MARGIN_X_DXA,
            bottom: PAGE_MARGIN_Y_DXA,
            left: PAGE_MARGIN_X_DXA,
            header: 620,
            footer: 620
          }
        }
      },
      headers: { default: reportHeader(scriptName) },
      footers: { default: reportFooter() },
      children
    }]
  });

  return Packer.toBuffer(document);
}
