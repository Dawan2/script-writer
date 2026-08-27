from __future__ import annotations

import json
from typing import Any

from app.db.session import get_connection, init_db


PRINCIPLES: dict[str, dict[str, Any]] = {
    "principle-14358c59db54f314ebe2": {
        "title": "关键世界规则必须明确边界并保持一致",
        "stage": "world_view",
        "statement": "当世界规则或特殊机制会决定人物能否行动或改变结果时，应明确它的触发条件、可见作用、不能解决的问题、失效范围和使用代价，并让后续运用与已建立的边界保持一致。",
        "rationale": "明确的作用与边界让规则成为人物可以据此决策的事实，也能保留对手威胁和后续冲突，避免关键时刻临时增加例外或无条件解法。",
        "applies_when": [
            "规则会影响人物的生存、任务、资源、权限或关系判断",
            "特殊能力、身份、道具或制度将多次参与主线",
            "人物需要依据已知规则预测风险或选择行动",
        ],
        "fails_or_changes_when": [
            "设定只承担一次性氛围、笑点或象征功能",
            "作品明确采用无规则的荒诞、寓言或神秘主义表达",
            "规则的未知部分不会影响当前人物的任何选择",
        ],
        "review_criteria": [
            "每条关键规则都写明触发条件、可见作用和失效范围",
            "会改变结果的机制至少有一项不能解决的问题或使用代价",
            "已证实的效果与仍未确定的原因被清楚区分",
            "如果规则发生变化，文本给出了可追溯的原因和新边界",
        ],
    },
    "principle-c06be923f105dbdefe89": {
        "title": "改变故事状态的选择必须有动机并承担后果",
        "stage": "outline_rewrite",
        "statement": "当人物的选择会使其介入核心冲突，或改变关系、职位、阵营、安全与生存状态时，应用人物已有的目标、压力、信息、资源或承诺解释这项选择，并让选择产生可追责的行动与后果。",
        "rationale": "动机保护人物选择的可信度，行动和后果则证明故事已经进入新状态，而不是由巧合或口头表态完成跳转。",
        "applies_when": [
            "人物从旁观者进入核心冲突或承担新主线",
            "选择会改变关系、职位、阵营、安全或生存状态",
            "故事后续将依据这项选择重新分配责任、资源或权限",
        ],
        "fails_or_changes_when": [
            "选择只是一次短期试探且不改变任何状态",
            "人物已有明确任务或制度职责足以解释当下行动",
            "故事有意表现冲动选择，且后续会完整承担冲动后果",
        ],
        "review_criteria": [
            "选择前能说清人物想要什么、知道什么和担心什么",
            "当下选择与人物已有行为、信息和压力存在直接因果",
            "选择由人物通过行动、公开站队、签署或资源交付固定",
            "选择造成的责任、限制、损失或新权限进入后续节点",
        ],
    },
    "principle-ee1b4a4afd931aeff3f5": {
        "title": "大纲阶段结果必须改变后续行动条件",
        "stage": "outline_rewrite",
        "statement": "当一个阶段目标得出成功、失败或部分完成的结果，且故事仍需继续时，应写清该结果改变的资源、关系、信息、权限或责任，并让下一阶段继承这个新状态。",
        "rationale": "后续可以是新机会、责任、反制、休整或收束，不必每次都升级为更大危机。但新状态必须被后续继承，否则阶段结果没有因果价值。",
        "applies_when": [
            "阶段目标已经出现可判定的成功、失败或部分完成结果",
            "结果会改变人物的可用资源、关系位置、信息范围或责任",
            "大纲在该节点之后仍有后续阶段或并行目标需要收束",
        ],
        "fails_or_changes_when": [
            "当前目标尚未得出可判定的结果",
            "该结果就是全剧终局，后续只需交代它的最终影响",
            "作品有意进入独立插曲，且之后会回收原有状态",
        ],
        "review_criteria": [
            "阶段结果可以被明确判定而不是抽象总结",
            "大纲写清了结果造成的具体状态变化",
            "后一阶段的目标、资源或选择实际继承了该变化",
            "并行目标需要分别收束时，每个结果都有对应的事实或人物行动",
        ],
    },
    "principle-2117c4e35ac37401549d": {
        "title": "人物与关系变化必须由选择证明并持续生效",
        "stage": "character_rewrite",
        "statement": "当人物的立场、自我定位或关系状态需要发生稳定变化时，应用与旧行为可比较的新选择证明优先级已经变化，并写清新状态如何持续影响后续行为、合作方式、风险分配或退出边界。",
        "rationale": "人物和关系变化必须能被事实证明，也必须进入后续选择。否则一次救援、表白、决裂或口头宣言只是瞬时情绪，没有真正改变人物因果。",
        "applies_when": [
            "人物需要从敌对、怀疑、疏离或被动承受转向新立场",
            "关键事件改变了双方的信任、边界、依赖、敌我或责任关系",
            "这项变化会继续影响任务、关系、资源或权力位置",
        ],
        "fails_or_changes_when": [
            "当前只是短期试探、伪装站队或单向悬念",
            "关系在当前事件后已经永久终止，不再影响后续行动",
            "作品明确采用寓言式突变或夸张喜剧表达",
        ],
        "review_criteria": [
            "人物小传可以对照变化前后的行为基准、信任、边界和优先级",
            "变化节点包含可观察且与旧行为可比较的新选择",
            "新选择会承担责任、改变现实条件或放弃原有退路",
            "后续选择和风险分配继续受新状态影响，不会无解释地回到旧基准",
        ],
    },
    "principle-e45a5b9d7b48d6755e22": {
        "title": "关系修复必须回应具体伤害与主体边界",
        "stage": "character_rewrite",
        "statement": "当剧情计划修复一段已经造成具体伤害的关系时，修复设计应回应实际损失，保留受伤方拒绝、离开和决定关系距离的权利，并用新的可观察事实支撑关系改善。",
        "rationale": "道歉、礼物、表白或一次救援不能自动抹掉旧伤。回应具体损失并保留受伤方主体性，才能让修复结果具有人物可信度。",
        "applies_when": [
            "关系中已经出现强迫、控制、背叛、误判或重大隐瞒",
            "故事仍计划让双方和解、复合或重建信任",
            "受伤方理论上仍有拒绝、离开或保持距离的空间",
        ],
        "fails_or_changes_when": [
            "合理结局应当是长期分离或彻底决裂",
            "所谓伤害并没有造成实际损失或关系后果",
            "当前只需建立暂时停火，不宣告关系已经修复",
        ],
        "review_criteria": [
            "人物小传明确记录受伤方失去了什么",
            "修复方的行动对应处理该损失而不只是表达后悔",
            "受伤方的拒绝、退出和边界不会被包装成需要攻克的障碍",
            "最终关系距离由受伤方在新事实基础上作出选择",
        ],
    },
    "principle-6b26bc544fd120cccc04": {
        "title": "能力与身份必须有可回查证据和状态后果",
        "stage": "character_rewrite",
        "statement": "当人物的专业能力、隐藏身份或真实立场会改变剧情时，人物设计应同时写明可回查的前置证据、之后用什么行动或外部结果完成验证，以及验证将改变的权限、关系或责任。",
        "rationale": "能力和身份不能只存在于人设标签或自我宣告中。证据和状态后果能证明它确实参与了人物因果，也能避免揭示只改变称呼。",
        "applies_when": [
            "人物的隐藏身份、能力或立场会改变主线",
            "人物长期被误认、低估或污名化",
            "揭示后理应改变资源、资格、信任或任务分配",
        ],
        "fails_or_changes_when": [
            "能力或身份只承担一次性反差笑点或象征功能",
            "当前故事不需要其他人相信或验证该信息",
            "人物刻意保持无法核验的暧昧身份，且这不影响现实权限",
        ],
        "review_criteria": [
            "人物小传列出了至少一项可在前文回查的能力或身份证据",
            "设计中有能够证明能力、身份或立场的行动或外部结果",
            "验证后的权限、关系、资源或责任变化被明确写出",
            "能力和身份仍保留范围、暴露、失败或使用代价",
        ],
    },
    "principle-7bc3ebcb5720380e7852": {
        "title": "开篇必须建立可行动的未解状态",
        "stage": "trial_generate",
        "statement": "当开篇承担主线启动任务时，应通过可观察的事件建立一个会产生实际后果的未解状态，并让观众理解主角此刻必须处理的目标或压力。",
        "rationale": "短剧开篇可以延迟设定解释，但不能只展示身份、奇观或背景。可行动的未解状态能同时给出当下因果和追看方向。",
        "applies_when": [
            "试稿需要从第一场戏启动主线",
            "开篇需要同时交代人物处境和核心冲突",
            "特殊身份或设定将在开场直接改变主角处境",
        ],
        "fails_or_changes_when": [
            "当前是紧接上一集未完行动的续写",
            "故事有意使用无主角的冷开场建立威胁",
            "开篇事件只承担氛围或主题象征，不承担主线启动",
        ],
        "review_criteria": [
            "开篇存在可直接定位的事件、选择或威胁",
            "该事件会产生安全、身份、关系、资源或期限后果",
            "主角的当下目标或不得不行动的原因可以被理解",
            "场景结束时仍有明确的未解对象或下一步行动",
        ],
    },
    "principle-f2230bf4eb4c24f7a2e4": {
        "title": "关键能力展示必须同时兑现作用与限制",
        "stage": "trial_generate",
        "statement": "当试稿首次或关键地展示特殊能力、隐藏身份或稀缺资源时，应让它解决一个可见的现场问题，并在同一次使用或直接后果中使至少一项使用条件、范围、失效可能或代价可以被观众理解。",
        "rationale": "现场作用证明设定真正参与主线，同时展示限制则保护后续危机和人物选择，避免观众把能力理解为随时可用的万能解法。",
        "applies_when": [
            "试稿首次兑现特殊能力、身份或资源",
            "该机制会直接改变当前危机的结果",
            "后续仍需保留失败可能和对手威胁",
        ],
        "fails_or_changes_when": [
            "该设定只承担一次性视觉或笑点功能",
            "限制在世界观中已经清楚，当前场景只需回收而不需重新说明",
            "当前展示不会改变任何现场问题或后续选择",
        ],
        "review_criteria": [
            "能力或资源通过动作和外部结果改变了一项现场阻力",
            "观众能定位至少一项触发条件、范围或失效可能",
            "使用后的损耗、暴露、误差或新风险会影响下一步行动",
            "下一个问题不能被同一能力在无条件下直接复制解决",
        ],
    },
    "principle-14f73b004cc7adb05e85": {
        "title": "完稿中的关键结果必须完整落地并被后文承接",
        "stage": "full_generate",
        "statement": "当前文承诺的救援、揭露、反击、清算、关系变化或其他关键结果开始兑现时，应通过行动、选择和可见后果完成兑现，并让后续场景承认这个新状态。",
        "rationale": "关键结果不必采用固定方法，终局也可以直接收束，但必须进入人物选择和现实因果。否则前文铺垫只会被一次惊讶或一句总结代替。",
        "applies_when": [
            "前文已经建立可识别的阶段目标、关键秘密或观众等待",
            "当前场景承担揭示、救援、反击、清算或关系确认的兑现任务",
            "兑现结果会改变人物的判断、安全、关系、资源、身份或责任",
        ],
        "fails_or_changes_when": [
            "当前只是早期线索投放，尚未进入正式结果兑现",
            "当前场景只承担短促点题、氛围或观众优越视角功能",
            "核心结果必须延迟确认以保留当前悬念",
        ],
        "review_criteria": [
            "兑现之前能定位对应的线索、准备、资源来源或行动承诺",
            "兑现过程包含人物行动、选择或实际阻力，不只是结果播报",
            "兑现结果具体改变了至少一项判断、安全、关系、资源、身份或责任",
            "后续场景不会无解释地忽略、撤销或跳过这项新状态",
        ],
    },
}


MERGES = {
    "principle-4157a8eecaabb3a37dc6": "principle-14358c59db54f314ebe2",
    "principle-4baa2d5083f2097d0d34": "principle-c06be923f105dbdefe89",
    "principle-0e0a3c903008c68126eb": "principle-2117c4e35ac37401549d",
    "principle-bc2141240fe6a1bd3483": "principle-14f73b004cc7adb05e85",
    "principle-5fe9d001fe42b30c99a2": "principle-ee1b4a4afd931aeff3f5",
}

RETIRED_CANDIDATES = {
    "principle-902297ce8ea4a63b7c50",
    "principle-94c47030206900fc45f6",
    "principle-0c86eabac66971aeea89",
}

ADDITIONAL_FORMULA_SUPPORT = {
    "principle-f2230bf4eb4c24f7a2e4": {"formula-af3ef28f5806aaf750a6"},
}


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def load_json(value: str | None, fallback: Any) -> Any:
    try:
        return json.loads(value or "")
    except (TypeError, ValueError):
        return fallback


def active_formula_lineage(conn) -> tuple[set[str], dict[str, set[str]]]:
    active_ids = {
        str(row["id"])
        for row in conn.execute("SELECT id FROM script_library_formulas WHERE status='active'")
    }
    lineage: dict[str, set[str]] = {formula_id: {formula_id} for formula_id in active_ids}
    for row in conn.execute(
        """
        SELECT source.formula_id, source.contribution_json
        FROM script_library_formula_sources AS source
        JOIN script_library_formulas AS formula ON formula.id=source.formula_id
        WHERE formula.status='active'
        """
    ):
        contribution = load_json(row["contribution_json"], {})
        old_id = str(contribution.get("old_formula_id") or "").strip()
        if old_id:
            lineage.setdefault(old_id, set()).add(str(row["formula_id"]))
    return active_ids, lineage


def remap_formula_relations(conn, principle_ids: set[str]) -> None:
    active_ids, lineage = active_formula_lineage(conn)
    placeholders = ",".join("?" for _ in principle_ids)
    rows = conn.execute(
        f"""
        SELECT id, principle_id, related_formula_ids_json
        FROM script_library_principle_observations
        WHERE principle_id IN ({placeholders})
        ORDER BY principle_id, id
        """,
        sorted(principle_ids),
    ).fetchall()
    added_to_principle: set[str] = set()
    for row in rows:
        principle_id = str(row["principle_id"])
        current_ids: set[str] = set()
        for old_id in load_json(row["related_formula_ids_json"], []):
            formula_id = str(old_id).strip()
            if formula_id in active_ids:
                current_ids.add(formula_id)
            current_ids.update(lineage.get(formula_id, set()))
        if principle_id not in added_to_principle:
            current_ids.update(ADDITIONAL_FORMULA_SUPPORT.get(principle_id, set()).intersection(active_ids))
            added_to_principle.add(principle_id)
        conn.execute(
            "UPDATE script_library_principle_observations SET related_formula_ids_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (encode(sorted(current_ids)), str(row["id"])),
        )


def update_principle(conn, principle_id: str, content: dict[str, Any]) -> None:
    row = conn.execute("SELECT * FROM script_library_principles WHERE id=?", (principle_id,)).fetchone()
    if row is None:
        raise RuntimeError(f"缺少待整理的创作原则：{principle_id}")
    values = {
        "title": content["title"],
        "stages_json": encode([content["stage"]]),
        "statement": content["statement"],
        "rationale": content["rationale"],
        "applies_when_json": encode(content["applies_when"]),
        "fails_or_changes_when_json": encode(content["fails_or_changes_when"]),
        "review_criteria_json": encode(content["review_criteria"]),
        "skill_keys_json": encode([f"stage:{content['stage']}"]),
        "status": "active",
        "origin": "manual-review",
    }
    changed = any(str(row[key]) != str(value) for key, value in values.items())
    if not changed:
        return
    conn.execute(
        """
        UPDATE script_library_principles
        SET title=?, stages_json=?, statement=?, rationale=?, applies_when_json=?,
            fails_or_changes_when_json=?, review_criteria_json=?, skill_keys_json=?,
            status='active', origin='manual-review', version=version+1,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=?
        """,
        (
            values["title"], values["stages_json"], values["statement"], values["rationale"],
            values["applies_when_json"], values["fails_or_changes_when_json"],
            values["review_criteria_json"], values["skill_keys_json"], principle_id,
        ),
    )


def refresh_source_count(conn, principle_id: str) -> None:
    count = int(conn.execute(
        """
        SELECT COUNT(DISTINCT script_id)
        FROM script_library_principle_observations
        WHERE principle_id=? AND status!='rejected'
        """,
        (principle_id,),
    ).fetchone()[0])
    conn.execute(
        "UPDATE script_library_principles SET source_count=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        (count, principle_id),
    )


def refine_principles() -> dict[str, Any]:
    with get_connection() as conn:
        existing_ids = {
            str(row["id"])
            for row in conn.execute("SELECT id FROM script_library_principles")
        }
        required_ids = set(PRINCIPLES) | set(MERGES) | RETIRED_CANDIDATES
        missing = sorted(required_ids.difference(existing_ids))
        if missing:
            raise RuntimeError(f"创作原则数据不完整，缺少：{'、'.join(missing)}")

        for source_id, target_id in MERGES.items():
            conn.execute(
                "UPDATE script_library_principle_observations SET principle_id=?, updated_at=CURRENT_TIMESTAMP WHERE principle_id=?",
                (target_id, source_id),
            )
            conn.execute(
                "UPDATE script_library_principles SET status='retired', source_count=0, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                (source_id,),
            )

        for principle_id in RETIRED_CANDIDATES:
            conn.execute(
                "UPDATE script_library_principle_observations SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE principle_id=?",
                (principle_id,),
            )
            conn.execute(
                "UPDATE script_library_principles SET status='retired', source_count=0, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                (principle_id,),
            )

        remap_formula_relations(conn, set(PRINCIPLES))
        for principle_id, content in PRINCIPLES.items():
            update_principle(conn, principle_id, content)
            refresh_source_count(conn, principle_id)

        active_rows = conn.execute(
            "SELECT id, stages_json FROM script_library_principles WHERE status='active' ORDER BY id"
        ).fetchall()
        candidates = int(conn.execute(
            "SELECT COUNT(*) FROM script_library_principles WHERE status='candidate'"
        ).fetchone()[0])
        if len(active_rows) != len(PRINCIPLES) or candidates:
            raise RuntimeError(
                f"创作原则整理结果异常：已启用 {len(active_rows)} 条，待验证 {candidates} 条"
            )
        if any(len(load_json(row["stages_json"], [])) != 1 for row in active_rows):
            raise RuntimeError("存在跨多个创作阶段的已启用原则")

        formula_counts = {
            str(row["principle_id"]): int(row["formula_count"] or 0)
            for row in conn.execute(
                """
                SELECT principle_id, COUNT(DISTINCT formula_id) AS formula_count
                FROM (
                    SELECT observation.principle_id, value AS formula_id
                    FROM script_library_principle_observations AS observation,
                         json_each(observation.related_formula_ids_json)
                    JOIN script_library_formulas AS formula ON formula.id=value
                    WHERE observation.principle_id IN (
                        SELECT id FROM script_library_principles WHERE status='active'
                    ) AND formula.status='active'
                )
                GROUP BY principle_id
                """
            )
        }
        conn.commit()
        return {
            "active_principles": len(active_rows),
            "candidate_principles": candidates,
            "formula_support": formula_counts,
        }


def main() -> int:
    init_db()
    print(json.dumps(refine_principles(), ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
