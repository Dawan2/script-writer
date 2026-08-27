"""错误码注册表校验。

把"错误文案只有一个出处"变成可执行的门槛：注册表条目本身合规、前端常量与
注册表一致、抛错点不再新增裸字符串文案。任何一项不通过就非零退出。

用法：
    python -m app.scripts.check_error_registry            # 校验
    python -m app.scripts.check_error_registry --write     # 校验并重新生成前端常量
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = APP_ROOT.parents[2]
REGISTRY_PATH = APP_ROOT / "core" / "error_codes.json"
GENERATED_TS_PATH = REPO_ROOT / "apps" / "web" / "src" / "lib" / "error-codes.ts"

LATIN_RUN = re.compile(r"[A-Za-z]{2,}")
CJK = re.compile(r"[\u4e00-\u9fff]")

GENERATED_HEADER = (
    "// 由 apps/api/app/scripts/check_error_registry.py 从 "
    "apps/api/app/core/error_codes.json 生成，请勿手改。\n"
    "// 修改错误码请改注册表，再运行 npm run check:errors。\n"
)


def load_registry() -> dict:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def render_error_codes_ts(registry: dict) -> str:
    def block(name: str, codes: list[str]) -> str:
        body = "".join(f'  {code}: "{code}",\n' for code in codes)
        return f"export const {name} = {{\n{body}}} as const;\n"

    http_codes = sorted(registry["http_codes"])
    client_codes = sorted(registry["client_codes"])
    agent_codes = sorted(registry["agent_codes"])
    return (
        GENERATED_HEADER
        + "\n"
        + block("HTTP_ERROR_CODES", http_codes)
        + "\n"
        + block("CLIENT_ERROR_CODES", client_codes)
        + "\n"
        + block("AGENT_ERROR_CODES", agent_codes)
        + "\n"
        + "export type HttpErrorCode = keyof typeof HTTP_ERROR_CODES;\n"
        + "export type ClientErrorCode = keyof typeof CLIENT_ERROR_CODES;\n"
        + "export type AgentErrorCode = keyof typeof AGENT_ERROR_CODES;\n"
        + "export type ErrorCode = HttpErrorCode | ClientErrorCode | AgentErrorCode;\n"
    )


def disallowed_latin(text: str, allowed: set[str]) -> list[str]:
    return [run.group(0) for run in LATIN_RUN.finditer(text) if run.group(0).lower() not in allowed]


def check_user_facing_entries(registry: dict, failures: list[str]) -> None:
    """判定 1 与判定 2：面向用户的条目都有中文 message 与 hint，且没有未声明的英文词。"""
    allowed = {word.lower() for word in registry["allowed_latin_words"]}
    for section in ("http_codes", "client_codes"):
        for code, entry in registry[section].items():
            for field in ("message", "hint"):
                value = str(entry.get(field) or "").strip()
                if not value:
                    failures.append(f"{section}.{code}.{field} 为空：面向用户的错误码必须同时给出发生了什么与下一步怎么办")
                    continue
                if not CJK.search(value):
                    failures.append(f"{section}.{code}.{field} 不是中文文案：{value}")
                leaked = disallowed_latin(value, allowed)
                if leaked:
                    failures.append(
                        f"{section}.{code}.{field} 含未声明的英文词 {leaked}："
                        "确需给用户看的词请写进 allowed_latin_words"
                    )


def check_categories(registry: dict, failures: list[str]) -> None:
    """判定 3：category 只能取注册表声明的 8 个值。"""
    allowed = set(registry["categories"])
    for section in ("http_codes", "client_codes"):
        for code, entry in registry[section].items():
            if entry.get("category") not in allowed:
                failures.append(f"{section}.{code}.category 不在允许取值内：{entry.get('category')}")
    for code, entry in registry["agent_codes"].items():
        unknown = [value for value in entry.get("categories", []) if value not in allowed]
        if unknown:
            failures.append(f"agent_codes.{code}.categories 不在允许取值内：{unknown}")


def _literal(node: ast.AST) -> object:
    return node.value if isinstance(node, ast.Constant) else None


def _is_propagated_code(node: ast.AST) -> bool:
    """`exc.code` 这类写法是把已有失败码原样上抛，不引入新码。"""
    return isinstance(node, ast.Attribute) and node.attr == "code"


CODE_NAME = re.compile(r"^[A-Z][A-Z0-9_]{2,}$")


def _nested_code_literals(node: ast.AST) -> list[str]:
    """从 `payload.get("code") or "TOOL_FAILED"` 这类表达式里取出兜底码。"""
    return [
        child.value
        for child in ast.walk(node)
        if isinstance(child, ast.Constant) and isinstance(child.value, str) and CODE_NAME.match(child.value)
    ]


def collect_agent_error_sites() -> list[dict]:
    sites: list[dict] = []
    for path in sorted(APP_ROOT.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
                continue
            if node.func.id != "AgentExecutionError":
                continue
            keywords = {keyword.arg: keyword.value for keyword in node.keywords}
            code_node = node.args[0] if node.args else keywords.get("code")
            category_node = node.args[1] if len(node.args) > 1 else keywords.get("category")
            retryable_node = node.args[2] if len(node.args) > 2 else keywords.get("retryable")
            sites.append({
                "file": str(path.relative_to(REPO_ROOT)),
                "line": node.lineno,
                "code_node": code_node,
                "category": _literal(category_node) if category_node is not None else None,
                "retryable": _literal(retryable_node) if retryable_node is not None else None,
            })
    return sites


def check_agent_codes(registry: dict, failures: list[str]) -> None:
    """判定 4：Agent 侧失败码不得存在第二份注册表。"""
    registered = registry["agent_codes"]
    for site in collect_agent_error_sites():
        location = f"{site['file']}:{site['line']}"
        code_node = site["code_node"]
        if code_node is None:
            failures.append(f"{location} 没有给出失败码")
            continue
        if _is_propagated_code(code_node):
            continue
        literal = _literal(code_node)
        codes = [literal] if isinstance(literal, str) else _nested_code_literals(code_node)
        if not codes:
            failures.append(f"{location} 的失败码没有可登记的字面量，注册表无法覆盖这条失败路径")
            continue
        for code in codes:
            entry = registered.get(code)
            if entry is None:
                failures.append(f"{location} 使用了未登记的失败码 {code}：请先写进 error_codes.json 的 agent_codes")
                continue
            if isinstance(site["category"], str) and site["category"] not in entry["categories"]:
                failures.append(f"{location} 的 {code} 用了未登记的 category {site['category']}")
            if isinstance(site["retryable"], bool) and site["retryable"] not in entry["retryable"]:
                failures.append(f"{location} 的 {code} 用了未登记的 retryable {site['retryable']}")


def check_generated_frontend_constants(registry: dict, failures: list[str], *, write: bool) -> None:
    """判定 5：前端错误码常量必须与注册表一致。"""
    expected = render_error_codes_ts(registry)
    if write:
        GENERATED_TS_PATH.write_text(expected, encoding="utf-8")
        return
    if not GENERATED_TS_PATH.is_file():
        failures.append(f"{GENERATED_TS_PATH.relative_to(REPO_ROOT)} 缺失：运行 npm run check:errors -- --write 重新生成")
        return
    if GENERATED_TS_PATH.read_text(encoding="utf-8") != expected:
        failures.append(
            f"{GENERATED_TS_PATH.relative_to(REPO_ROOT)} 与注册表不一致："
            "运行 npm run check:errors -- --write 重新生成"
        )


def _is_literal_text(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return True
    return isinstance(node, ast.JoinedStr)


def collect_literal_detail_sites() -> list[dict]:
    """找出把错误文案写死在抛错点、绕开注册表的 HTTPException。"""
    sites: list[dict] = []
    for path in sorted(APP_ROOT.rglob("*.py")):
        source = path.read_text(encoding="utf-8")
        lines = source.splitlines()
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
            if name != "HTTPException":
                continue
            for keyword in node.keywords:
                if keyword.arg == "detail" and _is_literal_text(keyword.value):
                    text = lines[keyword.value.lineno - 1].strip()
                    sites.append({
                        "file": str(path.relative_to(REPO_ROOT)),
                        "line": keyword.value.lineno,
                        "text": text,
                        "chinese": bool(CJK.search(text)),
                    })
    return sites


def check_literal_error_text(registry: dict, failures: list[str], notes: list[str]) -> None:
    """判定 6：抛错点不出现裸字符串错误文案。

    英文文案零容忍；已有的中文字面量按文件记账，只能减不能增——新增一处就拦下。
    """
    budget: dict[str, int] = registry["legacy_literal_detail_budget"]
    counted: dict[str, int] = {}
    for site in collect_literal_detail_sites():
        if not site["chinese"]:
            failures.append(f"{site['file']}:{site['line']} 抛出了英文裸字符串文案：{site['text']}")
            continue
        counted[site["file"]] = counted.get(site["file"], 0) + 1
    for file_path, count in sorted(counted.items()):
        allowance = budget.get(file_path, 0)
        if count > allowance:
            failures.append(
                f"{file_path} 新增了 {count - allowance} 处裸字符串错误文案（记账 {allowance} 处，现有 {count} 处）："
                "请改用 error_codes.json 里的错误码"
            )
        elif count < allowance:
            notes.append(f"{file_path} 的裸字符串文案已降到 {count} 处（记账 {allowance} 处），可下调记账数")
    for file_path in sorted(set(budget) - set(counted)):
        notes.append(f"{file_path} 已无裸字符串文案，可从记账中移除")


def rebuild_budget() -> dict[str, int]:
    counted: dict[str, int] = {}
    for site in collect_literal_detail_sites():
        if site["chinese"]:
            counted[site["file"]] = counted.get(site["file"], 0) + 1
    return dict(sorted(counted.items()))


def main() -> int:
    parser = argparse.ArgumentParser(description="校验错误码注册表")
    parser.add_argument("--write", action="store_true", help="重新生成前端错误码常量")
    parser.add_argument("--rebuild-budget", action="store_true", help="按当前代码重写裸字符串文案记账")
    arguments = parser.parse_args()

    registry = load_registry()
    if arguments.rebuild_budget:
        registry["legacy_literal_detail_budget"] = rebuild_budget()
        REGISTRY_PATH.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("已按当前代码重写裸字符串文案记账")
        return 0

    failures: list[str] = []
    notes: list[str] = []
    check_user_facing_entries(registry, failures)
    check_categories(registry, failures)
    check_agent_codes(registry, failures)
    check_generated_frontend_constants(registry, failures, write=arguments.write)
    check_literal_error_text(registry, failures, notes)

    for note in notes:
        print(f"提示：{note}")
    if failures:
        print(f"错误码注册表校验未通过，共 {len(failures)} 项：")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print(
        "错误码注册表校验通过："
        f"{len(registry['http_codes'])} 个接口错误码、"
        f"{len(registry['client_codes'])} 个客户端错误码、"
        f"{len(registry['agent_codes'])} 个创作失败码"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
