import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type IRunOptions,
  type ParagraphChild
} from "docx";

export type CurrentDeliveryCharacter = {
  name: string;
  english_name: string;
  gender: string;
  nationality: string;
  age: string;
  identity: string;
  appearance: string;
  attire: string;
  personality: string;
};

export type LegacyDeliveryCharacter = {
  name: string;
  appearance: string;
  voice: string;
  core_need: string;
  challenge: string;
  relationship_arc: string;
};

export type DeliveryCharacter = CurrentDeliveryCharacter | LegacyDeliveryCharacter;

export type ScriptDelivery = {
  title: string;
  english_title?: string;
  script_info: {
    target_region: string;
    target_countries: string[];
    episode_duration: string;
    target_episode_count: number | null;
    maturity_target: string;
  };
  world_view: string;
  synopsis: string;
  translated_synopsis?: string;
  characters: DeliveryCharacter[];
  script: {
    file_name: string;
    content: string;
    content_hash: string;
    episode_titles?: Record<string, string>;
  };
};

export type FullScriptDelivery = ScriptDelivery;
export type ScriptDeliveryKind = "full" | "trial" | "dialogue" | "dialogue_trial";

const A4_WIDTH_DXA = 11906;
const A4_HEIGHT_DXA = 16838;
const PAGE_MARGIN_X_DXA = 1800;
const PAGE_MARGIN_Y_DXA = 1440;
const TABLE_WIDTH_DXA = 8186;
const TABLE_LABEL_WIDTH_DXA = 2120;
const TABLE_VALUE_WIDTH_DXA = TABLE_WIDTH_DXA - TABLE_LABEL_WIDTH_DXA;
const BODY_FONT = "宋体";
const BODY_FONT_SIZE = 24;
const BODY_LINE_SPACING = 360;
const BODY_FIRST_LINE_INDENT = { firstLine: 480 };
const COLORS = {
  ink: "000000",
  paleBlue: "E8F1F8",
  paleGray: "F3F5F7",
  border: "B7C4CE"
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function run(value: string, options: Omit<IRunOptions, "text" | "children"> = {}) {
  return new TextRun({
    text: value,
    ...options,
    font: BODY_FONT,
    size: BODY_FONT_SIZE,
    color: COLORS.ink,
    italics: false
  });
}

function sectionHeading(value: string, pageBreakBefore = false) {
  return new Paragraph({
    children: [run(value, { bold: true })],
    heading: HeadingLevel.HEADING_1,
    pageBreakBefore,
    spacing: { before: pageBreakBefore ? 0 : 220, after: 180, line: BODY_LINE_SPACING },
    keepNext: true
  });
}

function subsectionHeading(value: string) {
  return new Paragraph({
    children: [run(value, { bold: true })],
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 180, after: 100, line: BODY_LINE_SPACING },
    keepNext: true
  });
}

function bodyParagraph(value: string, options: { after?: number; before?: number; indent?: number } = {}) {
  return new Paragraph({
    children: [run(value)],
    indent: { ...BODY_FIRST_LINE_INDENT, ...(options.indent ? { left: options.indent } : {}) },
    spacing: { before: options.before ?? 0, after: options.after ?? 120, line: BODY_LINE_SPACING }
  });
}

function labelledParagraph(label: string, value: string, options: { indent?: number } = {}) {
  return new Paragraph({
    children: [
      run(`${label}：`, { bold: true }),
      run(value)
    ],
    indent: { ...BODY_FIRST_LINE_INDENT, ...(options.indent ? { left: options.indent } : {}) },
    spacing: { after: 100, line: BODY_LINE_SPACING }
  });
}

function characterProfileBullet(children: ParagraphChild[]) {
  return new Paragraph({
    children,
    bullet: { level: 0 },
    indent: { left: 720, hanging: 360 },
    spacing: { after: 100, line: BODY_LINE_SPACING }
  });
}

function isCurrentDeliveryCharacter(character: DeliveryCharacter): character is CurrentDeliveryCharacter {
  return "gender" in character;
}

function metadataRows(delivery: ScriptDelivery, title: string) {
  const info = delivery.script_info;
  const rows: Array<[string, string]> = [["剧本中文名", title]];
  const englishTitle = text(delivery.english_title);
  if (englishTitle) rows.push(["剧本英文名", englishTitle]);
  rows.push(
    ["剧本集数", typeof info.target_episode_count === "number" ? `${info.target_episode_count} 集` : "未填写"],
    ["单集时长", text(info.episode_duration) || "未填写"],
    ["内容分级", text(info.maturity_target) || "未填写"]
  );
  return rows;
}

function metadataTable(rows: Array<[string, string]>) {
  const border = { style: BorderStyle.SINGLE, color: COLORS.border, size: 4 } as const;
  return new Table({
    width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA },
    indent: { size: 120, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [TABLE_LABEL_WIDTH_DXA, TABLE_VALUE_WIDTH_DXA],
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: rows.map(([label, value], index) => new TableRow({
      cantSplit: true,
      children: [
        new TableCell({
          width: { size: TABLE_LABEL_WIDTH_DXA, type: WidthType.DXA },
          verticalAlign: VerticalAlign.CENTER,
          shading: { type: ShadingType.CLEAR, fill: index % 2 === 0 ? COLORS.paleBlue : COLORS.paleGray },
          margins: { top: 100, bottom: 100, left: 120, right: 120 },
          children: [new Paragraph({ children: [run(label, { bold: true })], spacing: { after: 0, line: BODY_LINE_SPACING } })]
        }),
        new TableCell({
          width: { size: TABLE_VALUE_WIDTH_DXA, type: WidthType.DXA },
          verticalAlign: VerticalAlign.CENTER,
          margins: { top: 100, bottom: 100, left: 140, right: 140 },
          children: [new Paragraph({ children: [run(value)], spacing: { after: 0, line: BODY_LINE_SPACING } })]
        })
      ]
    }))
  });
}

function scriptDirection(value: string) {
  return new Paragraph({
    children: [run("△ ", { bold: true }), run(value)],
    indent: BODY_FIRST_LINE_INDENT,
    spacing: { before: 40, after: 100, line: BODY_LINE_SPACING }
  });
}

function scriptScene(value: string) {
  return new Paragraph({
    children: [run(value, { bold: true })],
    spacing: { before: 150, after: 100, line: BODY_LINE_SPACING },
    keepNext: true
  });
}

function scriptCast(value: string) {
  return labelledParagraph("人物", value);
}

function scriptDialogue(name: string, state: string, dialogue: string, translation?: string) {
  const speaker = state ? `${name}（${state}）` : name;
  const children: Paragraph[] = [
    new Paragraph({
      children: [run(`${speaker}：`, { bold: true }), run(dialogue)],
      indent: BODY_FIRST_LINE_INDENT,
      spacing: { before: 100, after: translation ? 20 : 100, line: BODY_LINE_SPACING },
      keepNext: Boolean(translation)
    })
  ];
  if (translation) {
    children.push(new Paragraph({
      children: [run(translation)],
      indent: BODY_FIRST_LINE_INDENT,
      spacing: { after: 100, line: BODY_LINE_SPACING }
    }));
  }
  return children;
}

function isTranslation(line: string) {
  return /^(?:\(.+\)|（.+）)$/.test(line.trim());
}

function dialogueLine(line: string) {
  const match = /^([^：:]{1,40}?)(?:（([^）]{1,80})）)?[：:]\s*(.+)$/.exec(line.trim());
  if (!match) return null;
  const name = match[1].trim();
  if (["人物", "字幕", "场景", "动作", "音效", "SFX", "镜头", "特写"].includes(name)) return null;
  return { name, state: (match[2] ?? "").trim(), dialogue: match[3].trim() };
}

function episodeHeadingWithTitle(value: string, episodeTitles: Record<string, string>) {
  const match = /^第\s*(\d+)\s*集(?:\s*[：:]\s*(.*))?$/.exec(value.trim());
  if (!match || match[2] !== undefined) return value;
  const title = text(episodeTitles[match[1]]);
  return title ? `第${match[1]}集：${title}` : value;
}

// The full-script contract is line-based, so this parser preserves every source line
// while promoting its known screenplay markers into Word-native screenplay elements.
function screenplayChildren(content: string, episodeTitles: Record<string, string> = {}) {
  const children: Array<Paragraph | Table> = [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index] ?? "";
    const line = source.trim();
    if (!line) continue;

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const headingText = episodeHeadingWithTitle(heading[2].trim(), episodeTitles);
      if (level === 1) {
        children.push(new Paragraph({
          children: [run(headingText, { bold: true })],
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 180, line: BODY_LINE_SPACING },
          keepNext: true
        }));
      } else if (level === 2) {
        children.push(new Paragraph({
          children: [run(headingText, { bold: true })],
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 180, after: 160, line: BODY_LINE_SPACING },
          keepNext: true
        }));
      } else if (level === 3) {
        children.push(scriptScene(headingText));
      } else {
        children.push(subsectionHeading(headingText));
      }
      continue;
    }

    const cast = /^人物[：:]\s*(.+)$/.exec(line);
    if (cast) {
      children.push(scriptCast(cast[1].trim()));
      continue;
    }

    if (line.startsWith("△")) {
      children.push(scriptDirection(line.slice(1).trim()));
      continue;
    }

    const dialogue = dialogueLine(line);
    if (dialogue) {
      const candidate = (lines[index + 1] ?? "").trim();
      const translation = isTranslation(candidate) ? candidate : undefined;
      children.push(...scriptDialogue(dialogue.name, dialogue.state, dialogue.dialogue, translation));
      if (translation) index += 1;
      continue;
    }

    children.push(bodyParagraph(line, { after: 100 }));
  }
  return children;
}

function documentHeader(title: string) {
  return new Header({
    children: [new Paragraph({
      children: [run(title)],
      alignment: AlignmentType.RIGHT,
      spacing: { after: 0, line: BODY_LINE_SPACING }
    })]
  });
}

function documentFooter() {
  const children: ParagraphChild[] = [
    run("第 "),
    new TextRun({ children: [PageNumber.CURRENT], font: BODY_FONT, size: BODY_FONT_SIZE, color: COLORS.ink, italics: false }),
    run(" 页 / 共 "),
    new TextRun({ children: [PageNumber.TOTAL_PAGES], font: BODY_FONT, size: BODY_FONT_SIZE, color: COLORS.ink, italics: false }),
    run(" 页")
  ];
  return new Footer({
    children: [new Paragraph({ children, alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0, line: BODY_LINE_SPACING } })]
  });
}

export function deliveryDocumentName(kind: ScriptDeliveryKind) {
  if (kind === "trial") return "剧本试稿";
  if (kind === "dialogue_trial") return "剧本试稿-台词翻译";
  if (kind === "dialogue") return "完整剧本-台词翻译";
  return "完整剧本";
}

function deliveryPresentation(kind: ScriptDeliveryKind) {
  if (kind === "trial") return { documentName: deliveryDocumentName(kind), sourceLabel: "试稿" };
  if (kind === "dialogue_trial") return { documentName: deliveryDocumentName(kind), sourceLabel: "试稿译稿" };
  if (kind === "dialogue") return { documentName: deliveryDocumentName(kind), sourceLabel: "台词译稿" };
  return { documentName: deliveryDocumentName(kind), sourceLabel: "全稿" };
}

function chineseSectionNumber(value: number) {
  const numerals = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  return numerals[value] ?? String(value);
}

export async function scriptDeliveryToDocxBuffer(delivery: ScriptDelivery, kind: ScriptDeliveryKind = "full") {
  const presentation = deliveryPresentation(kind);
  const isDialogueDelivery = kind === "dialogue" || kind === "dialogue_trial";
  const title = text(delivery.title) || (kind === "trial" ? "剧本试稿" : isDialogueDelivery ? "台词译稿" : "完整剧本");
  const englishTitle = text(delivery.english_title);
  const children: Array<Paragraph | Table> = [
    new Paragraph({ spacing: { before: 1080, after: 140, line: BODY_LINE_SPACING } }),
    new Paragraph({
      children: [run(title, { bold: true })],
      alignment: AlignmentType.CENTER,
      spacing: { after: englishTitle ? 100 : BODY_LINE_SPACING * 2, line: BODY_LINE_SPACING }
    }),
    ...(englishTitle ? [new Paragraph({
      children: [run(englishTitle, { bold: true })],
      alignment: AlignmentType.CENTER,
      spacing: { after: BODY_LINE_SPACING * 2, line: BODY_LINE_SPACING }
    })] : []),
    ...(() => {
      const rows = metadataRows(delivery, title);
      return rows.length ? [metadataTable(rows)] : [bodyParagraph("暂无可展示的剧本信息。")];
    })()
  ];

  let sectionNumber = 1;
  if (text(delivery.world_view) || text(delivery.synopsis) || (isDialogueDelivery && text(delivery.translated_synopsis))) {
    children.push(sectionHeading(`${chineseSectionNumber(sectionNumber)}、世界观及故事梗概`, true));
    sectionNumber += 1;
    let subsectionNumber = 1;
    if (text(delivery.world_view)) {
      children.push(subsectionHeading(`${subsectionNumber}. 世界观描述`), bodyParagraph(text(delivery.world_view), { after: 180 }));
      subsectionNumber += 1;
    }
    if (text(delivery.synopsis)) {
      const synopsisLabel = isDialogueDelivery ? "中文简介" : "故事梗概";
      children.push(subsectionHeading(`${subsectionNumber}. ${synopsisLabel}`), bodyParagraph(text(delivery.synopsis), { after: 180 }));
      subsectionNumber += 1;
    }
    if (isDialogueDelivery && text(delivery.translated_synopsis)) {
      children.push(subsectionHeading(`${subsectionNumber}. 英文简介`), bodyParagraph(text(delivery.translated_synopsis), { after: 180 }));
    }
  }

  if (delivery.characters.length) {
    children.push(sectionHeading(`${chineseSectionNumber(sectionNumber)}、人物设定`, true));
    sectionNumber += 1;
  }

  let characterNumber = 1;
  for (const character of delivery.characters) {
    if (!isCurrentDeliveryCharacter(character)) {
      children.push(new Paragraph({
        children: [run(`${characterNumber}. ${text(character.name)}`, { bold: true })],
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 180, after: 140, line: BODY_LINE_SPACING },
        keepNext: true
      }));

      const fields: Array<[string, string]> = [
        ["形象", text(character.appearance)],
        ["口吻", text(character.voice)],
        ["核心诉求", text(character.core_need)],
        ["人物难题", text(character.challenge)],
        ["关系与弧光", text(character.relationship_arc)]
      ];
      for (const [label, value] of fields) {
        if (value) children.push(labelledParagraph(label, value));
      }
      characterNumber += 1;
      continue;
    }

    const name = text(character.name);
    const englishName = text(character.english_name);
    children.push(new Paragraph({
      children: [run(`${characterNumber}. ${englishName ? `${name} (${englishName})` : name}`, { bold: true })],
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 180, after: 140, line: BODY_LINE_SPACING },
      keepNext: true
    }));

    children.push(
      characterProfileBullet([
        run("性别：", { bold: true }), run(text(character.gender)),
        run(" ｜ 国籍：", { bold: true }), run(text(character.nationality)),
        run(" ｜ 年龄：", { bold: true }), run(text(character.age))
      ]),
      characterProfileBullet([run("身份：", { bold: true }), run(text(character.identity))]),
      characterProfileBullet([run("外貌：", { bold: true }), run(text(character.appearance))]),
      characterProfileBullet([run("穿着：", { bold: true }), run(text(character.attire))]),
      characterProfileBullet([run("性格：", { bold: true }), run(text(character.personality))])
    );
    characterNumber += 1;
  }

  children.push(
    sectionHeading(`${chineseSectionNumber(sectionNumber)}、剧本正文`, true),
    ...screenplayChildren(delivery.script.content, delivery.script.episode_titles)
  );

  const document = new Document({
    title,
    subject: presentation.documentName,
    creator: "虎鲸剧本出海工作台",
    description: `由当前${presentation.sourceLabel}及项目资料生成`,
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: BODY_FONT_SIZE, color: COLORS.ink },
          paragraph: { spacing: { before: 0, after: 120, line: BODY_LINE_SPACING } }
        },
        heading1: {
          run: { font: BODY_FONT, size: BODY_FONT_SIZE, bold: true, color: COLORS.ink },
          paragraph: { spacing: { before: 220, after: 180, line: BODY_LINE_SPACING }, keepNext: true, outlineLevel: 0 }
        },
        heading2: {
          run: { font: BODY_FONT, size: BODY_FONT_SIZE, bold: true, color: COLORS.ink },
          paragraph: { spacing: { before: 180, after: 100, line: BODY_LINE_SPACING }, keepNext: true, outlineLevel: 1 }
        },
        heading3: {
          run: { font: BODY_FONT, size: BODY_FONT_SIZE, bold: true, color: COLORS.ink },
          paragraph: { spacing: { before: 140, after: 80, line: BODY_LINE_SPACING }, keepNext: true, outlineLevel: 2, indent: { left: 180 } }
        }
      }
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
            header: 720,
            footer: 720
          }
        }
      },
      headers: { default: documentHeader(title) },
      footers: { default: documentFooter() },
      children
    }]
  });

  return Packer.toBuffer(document);
}

export function fullScriptDeliveryToDocxBuffer(delivery: FullScriptDelivery) {
  return scriptDeliveryToDocxBuffer(delivery, "full");
}

export function trialScriptDeliveryToDocxBuffer(delivery: ScriptDelivery) {
  return scriptDeliveryToDocxBuffer(delivery, "trial");
}

export function dialogueScriptDeliveryToDocxBuffer(delivery: ScriptDelivery) {
  return scriptDeliveryToDocxBuffer(delivery, "dialogue");
}

export function dialogueTrialScriptDeliveryToDocxBuffer(delivery: ScriptDelivery) {
  return scriptDeliveryToDocxBuffer(delivery, "dialogue_trial");
}
