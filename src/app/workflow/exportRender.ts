/**
 * 应用层·markdown 导出聚合纯函数（SPEC-06 §5.2，W3-DRAFT-T02）。
 * 零 IO：输入 = 大纲原文 + 场文件内容（按文件名升序注入），输出 = 产物全文。
 * 确定性五裁定：不含导出时间戳——同输入重复渲染字节级相同（验收 ② 可断言）。
 * v1 已知限制（§5.2-4）：原文拼接，不做标题降级 / 注释剥离 / 台词格式化。
 */

export interface ExportScene {
  /** 场文件名（仅用于调用方排序，渲染不消费）。 */
  fileName: string;
  /** 场文件原文。 */
  content: string;
}

export interface MarkdownExportInput {
  title: string;
  /** 项目脚本类型（project.yaml 的 format 字段，原样进头部注释行）。 */
  format: string;
  created: string;
  /** 大纲原文（首尾空白已修剪）；null = 「## 大纲」节整体省略（§5.2-2）。 */
  outlineText: string | null;
  /** 场文件（已按文件名升序）；空数组 = 「## 场景」节整体省略。 */
  scenes: readonly ExportScene[];
}

/** 渲染 markdown v1 产物（空节省略规则见 §5.2-2；调用方保证大纲与场景不同时为空）。 */
export function renderMarkdownExport(input: MarkdownExportInput): string {
  const parts: string[] = [
    `# ${input.title}`,
    '',
    `> script-writer 导出 · 格式 markdown v1 · format: ${input.format} · created: ${input.created}`,
  ];
  if (input.outlineText !== null) {
    parts.push('', '## 大纲', '', input.outlineText);
  }
  if (input.scenes.length > 0) {
    parts.push('', '## 场景', '');
    // 场间以单行 --- 分隔；场原文去尾部空白以保证字节级确定性。
    parts.push(input.scenes.map((scene) => scene.content.trimEnd()).join('\n\n---\n\n'));
  }
  return `${parts.join('\n')}\n`;
}
