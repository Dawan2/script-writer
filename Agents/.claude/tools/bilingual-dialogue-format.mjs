const DIALOGUE_LINE_RE = /^.+：.+$/u;
const TRANSLATION_LINE_RE = /^[（(].+[）)]$/u;
const NON_DIALOGUE_LINE_RE = /^(?:#|△|人物：)/u;

function isBlankLine(line) {
  return /^\s*$/u.test(line);
}

function isDialogueLine(line) {
  const trimmed = line.trim();
  return Boolean(trimmed) && !NON_DIALOGUE_LINE_RE.test(trimmed) && DIALOGUE_LINE_RE.test(trimmed);
}

function isTranslationLine(line) {
  return TRANSLATION_LINE_RE.test(line.trim());
}

/**
 * Normalize only an already-present, unambiguous Chinese/target-locale pair.
 * It never creates, removes, or rewrites dialogue or translation text.
 */
export function normalizeBilingualDialogueFormat(text) {
  const source = String(text || "");
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/u);
  const repairs = {
    repaired_pairs: 0,
    normalized_dialogue_lines: 0,
    normalized_translation_lines: 0,
    removed_blank_lines: 0
  };

  for (let index = 0; index < lines.length; index += 1) {
    if (!isDialogueLine(lines[index])) continue;

    let translationIndex = index + 1;
    while (translationIndex < lines.length && isBlankLine(lines[translationIndex])) translationIndex += 1;
    if (!isTranslationLine(lines[translationIndex] || "")) continue;

    const normalizedDialogue = `${lines[index].replace(/\s+$/u, "")}  `;
    const normalizedTranslation = lines[translationIndex].trim();
    const blankLineCount = translationIndex - index - 1;
    const changedDialogue = normalizedDialogue !== lines[index];
    const changedTranslation = normalizedTranslation !== lines[translationIndex];
    if (!changedDialogue && !changedTranslation && !blankLineCount) continue;

    lines[index] = normalizedDialogue;
    lines[translationIndex] = normalizedTranslation;
    if (blankLineCount) lines.splice(index + 1, blankLineCount);
    repairs.repaired_pairs += 1;
    if (changedDialogue) repairs.normalized_dialogue_lines += 1;
    if (changedTranslation) repairs.normalized_translation_lines += 1;
    repairs.removed_blank_lines += blankLineCount;
  }

  return {
    content: lines.join(lineEnding),
    changed: repairs.repaired_pairs > 0,
    repairs
  };
}
