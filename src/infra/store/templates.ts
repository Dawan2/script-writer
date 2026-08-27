/**
 * 基础设施·模板库读取与渲染（SPEC-01："模板 = templates/<id>/ 下的文件树 + 变量占位"）。
 *
 * - 占位语法：`{{key}}`，仅替换已提供的变量，未知占位原样保留（便于人工排查）。
 * - 文件名规约：模板内名为 `gitignore` 的文件渲染为 `.gitignore`
 *   （避免真正的 .gitignore 影响本仓库自身的忽略规则，且 npm 打包会剥除 .gitignore）。
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface TemplateFile {
  relPath: string;
  content: string;
}

/** templates/ 根目录（src/ 与 dist/ 相对仓库根深度一致，同一相对路径两态可用）。 */
export function templatesRoot(): string {
  return fileURLToPath(new URL('../../../templates/', import.meta.url));
}

/** 已内置的模板 id 列表（templates/ 下的子目录名）。 */
export async function listTemplates(): Promise<string[]> {
  const entries = await readdir(templatesRoot(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function collectFiles(dir: string, base: string): Promise<TemplateFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: TemplateFile[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(abs, path.posix.join(base, entry.name))));
    } else {
      const name = entry.name === 'gitignore' ? '.gitignore' : entry.name;
      files.push({
        relPath: path.posix.join(base, name),
        content: await readFile(abs, 'utf8'),
      });
    }
  }
  return files;
}

/** 读取一个模板的完整文件树（调用方需先用 listTemplates 校验 id 存在）。 */
export async function loadTemplate(id: string): Promise<TemplateFile[]> {
  return collectFiles(path.join(templatesRoot(), id), '');
}

/** 变量替换：`{{key}}` → vars[key]；未提供的占位保持原样。 */
export function renderTemplateFiles(
  files: TemplateFile[],
  vars: Record<string, string>,
): TemplateFile[] {
  return files.map((file) => ({
    relPath: file.relPath,
    content: file.content.replace(/\{\{(\w+)\}\}/g, (raw, key: string) => vars[key] ?? raw),
  }));
}
