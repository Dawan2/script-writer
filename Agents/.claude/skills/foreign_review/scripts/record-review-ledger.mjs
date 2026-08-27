#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPlainObject, isText, readJson, writeJson } from "./foreign-review-utils.mjs";

const REQUIRED_FIELDS = Object.freeze(["id", "剧情功能", "冲突", "选择", "结果", "卡点", "证据"]);

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--records") throw new Error("请使用 --workspace <项目目录> --records <审读记录JSON路径>");
  return { workspace: path.resolve(argv[1]), recordsPath: path.resolve(argv[3]) };
}

function assertRecord(record, unit) {
  if (!isPlainObject(record)) throw new Error("审读记录必须是对象");
  for (const field of REQUIRED_FIELDS) {
    if (field === "证据") continue;
    if (!isText(record[field])) throw new Error(`审读记录 ${unit.label} 缺少${field}`);
  }
  if (!Array.isArray(record["证据"]) || !record["证据"].length) throw new Error(`审读记录 ${unit.label} 至少需要一条正文证据`);
  record["证据"].forEach((evidence) => {
    if (!isPlainObject(evidence) || !Number.isInteger(evidence["起始行"]) || !Number.isInteger(evidence["结束行"]) || !isText(evidence["说明"])) {
      throw new Error(`审读记录 ${unit.label} 的证据格式无效`);
    }
    if (evidence["起始行"] < unit.start_line || evidence["结束行"] > unit.end_line || evidence["结束行"] < evidence["起始行"]) {
      throw new Error(`审读记录 ${unit.label} 的证据必须位于本审读单元内`);
    }
  });
}

export async function recordReviewLedger(workspace, recordsPath) {
  const ledgerPath = path.join(workspace, "runtime", "review-ledger.json");
  const [ledger, records] = await Promise.all([readJson(ledgerPath), fs.readFile(recordsPath, "utf8").then(JSON.parse)]);
  if (!Array.isArray(records) || !Array.isArray(ledger.units)) throw new Error("审读台账或审读记录格式无效");
  const recordById = new Map(records.map((record) => [record?.id, record]));
  if (recordById.size !== ledger.units.length || ledger.units.some((unit) => !recordById.has(unit.id))) {
    throw new Error("审读记录必须与当前索引的全部审读单元一一对应");
  }
  ledger.units.forEach((unit) => {
    const record = recordById.get(unit.id);
    assertRecord(record, unit);
    Object.assign(unit, {
      status: "已审读",
      "剧情功能": record["剧情功能"],
      "冲突": record["冲突"],
      "选择": record["选择"],
      "结果": record["结果"],
      "卡点": record["卡点"],
      "人物动机": Array.isArray(record["人物动机"]) ? record["人物动机"] : [],
      "规则变化": Array.isArray(record["规则变化"]) ? record["规则变化"] : [],
      "矛盾点": Array.isArray(record["矛盾点"]) ? record["矛盾点"] : [],
      "证据": record["证据"]
    });
  });
  await writeJson(ledgerPath, ledger);
  return { units: ledger.units.length, ledgerPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await recordReviewLedger(args.workspace, args.recordsPath);
    process.stdout.write(`${JSON.stringify({ ok: true, message: "全文审读台账已写入。", next_action: "记录完整审读覆盖后，完成评分卡和审稿报告。", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, tool: "写入审读台账", message: error.message, next_action: "补齐每个审读单元的剧情结论和本单元正文证据后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
