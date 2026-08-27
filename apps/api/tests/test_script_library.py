from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException, UploadFile

from app.db import session
from app.scripts import curate_script_mechanisms
from app.services import script_library_service
from app.services.auth_service import create_user, get_user_by_username


class ScriptLibraryTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.settings = SimpleNamespace(
            data_dir=root / "data",
            database_path=root / "data" / "app.db",
            repo_root=root,
            agents_dir=root / "Agents",
            workspaces_dir=root / "Agents" / "workspaces",
            upload_dir=root / "data" / "uploads",
        )
        self.settings.agents_dir.mkdir(parents=True)
        self.session_patch = patch.object(session, "settings", self.settings)
        self.library_patch = patch.object(script_library_service, "settings", self.settings)
        self.session_patch.start()
        self.library_patch.start()
        session.init_db()
        self.conn = session.get_connection()
        create_user(
            self.conn,
            username="admin",
            password="admin-password",
            display_name="系统管理员",
            role="admin",
        )
        self.admin = get_user_by_username(self.conn, "admin")

    def tearDown(self):
        self.conn.close()
        self.library_patch.stop()
        self.session_patch.stop()
        self.temp_dir.cleanup()

    def valid_distillation_payload(self):
        return {
            "summary": "林夏在与顾沉的婚姻中长期被误解和排斥，她拿到离婚协议后离开顾家，重回星河集团管理层。顾沉在公司危机和旧证据曝光中逐步发现判断错误，但林夏已把目标从获得他的认可改为重建自己的事业与选择权，最终在公开股东会上完成真相清算，不再把复合当作证明价值的终点。",
            "tags": {
                "theme": ["现代言情", "女性成长"],
                "setting": ["追妻火葬场", "业界精英"],
                "background": ["现代", "都市", "职场"],
                "audience": ["女频"],
            },
            "formulas": {
                "core": "把一个在亲密关系中失去话语权的专业女性，通过离婚与回归事业完成目标切换；让旧关系的误判在每次事业升级中产生新代价，最终用她的主动选择而非男方追回作为终局改变，使情感回报服务于女主成长而不是取代成长。",
                "world": "都市婚姻与集团治理共享一套等级秩序：顾家控制名誉与婚姻叙事，股东会控制商业裁判，林夏手中的离婚协议、项目数据和股权成为可转移的权力；任何公开越界都会同时损害关系与公司利益。",
                "gratification": "先让受众目睹林夏被排斥却无法自证的压抑，再以离开顾家、项目救火、身份确认和股东会证据公开形成递增释放；每次释放都让顾沉失去一项旧有权力，最终回报是林夏公开掌握选择而不是被动接受道歉。",
            },
            "case_card": {
                "logline": "被丈夫和顾家当成利益附庸的林夏签下离婚协议，以星河集团继承人与项目负责人的身份重回商业战场，迫使顾沉在真相与失去中重新理解她。",
                "story_overview": "开篇中，林夏因一份被篡改的项目文件在顾家家宴上被当众定罪，顾沉选择相信旧友而非妻子。林夏不再辩解，当场签下离婚协议并回到星河集团。当顾氏项目遭遇供应链危机时，顾沉发现唯一能救场的人正是他刚刚放弃的林夏。随着原始邮件、会议录音和股权文件逐步出现，家庭误判升级为两家集团的公开权力争夺。顾沉尝试用道歉和资源挽回，却每次都暴露他仍把林夏当作需要安置的关系对象。终局股东会上，林夏公开完整证据链，拿回项目与个人名誉，并拒绝立即复合，将未来选择留给自己。",
                "audience_emotion": "受众先与林夏共享被亲密之人否定的懋屈，再从她不解释而直接离场的决断、事业能力被确认以及误判者持续失去中获得释放。",
                "type_promise": "伤害不会被一次道歉抹平；林夏每拿回一层事业权力，顾沉就必须为过去的一次误判支付具体代价，直到选择权完全回到女主手中。",
                "main_relationship": "林夏与顾沉从“丈夫拥有裁判权、妻子承担自证义务”的失衡婚姻，转为两个集团决策者之间的对等博弈，情感修复必须晚于权力归位。",
                "central_conflict": "顾沉想保住旧有婚姻和集团利益，却不愿立即承认自己的裁判体系错了；林夏要的不是被重新接纳，而是证明她可以不依附顾家完成事业与名誉重建。",
                "opening_pressure": "顾家家宴把私人婚姻、家族名誉和公司项目三种裁判叠在同一场公开质询中，被篡改的文件使林夏当场无法完成证据闭环，顾沉的站队则让伤害不可逆。",
                "protagonist_tool": "林夏的工具不是突然公开身份，而是离婚协议赋予的切割权、她对项目数据的专业掌控，以及原始邮件、录音与股权文件组成的递进证据链。",
                "protagonist_arc": "林夏开始时仍希望通过解释换取丈夫信任，家宴定罪让她认清问题不在证据不足，而在她没有裁判权。她先用离婚完成关系切割，再用项目成果和股权完成事业正名，最终能在顾沉真正追悔时仍保留不复合的自由。",
                "relationship_arc": "两人的关系先从隐性不对等跌入公开破裂，随后在项目合作中被迫以对手身份重新认识彼此。顾沉每次用旧权力补偿都使关系更远，只有当他在股东会公开承担错判责任，两人才获得未来对话的最低条件。",
                "plot_engine": "情节由“旧误判造成一项当下损失”与“林夏用专业能力或一层证据改写结果”交替驱动。每一轮反转既提高商业利益，又重新定义两人关系，并留下更高层级的家族或股东裁判进入下一轮。",
                "first3_model": "第一段在顾家家宴建立篡改文件和顾沉站错队的公开伤害；第二段让林夏放弃无效辩解，签下离婚协议并离开顾家；第三段立刻用顾氏供应链危机证明她的专业价值，但只暴露星河集团身份的一角，并留下原始邮件尚未公开的后续钩子。",
                "first10_model": "前十集的推进不是重复打脸：家宴定罪与离婚完成关系破裂；供应链危机让林夏以项目负责人回场；原始邮件洗掉第一层误判，却引出内部人员篡改数据的更大问题；顾沉的私下道歉被林夏拒绝；第十集以她持有星河股权的公开事实把冲突升到两家集团层面，同时让顾家股东开始阻断她对原始数据的访问，为制度对抗制造行动目标。",
                "midgame_upgrade": "中段不再围绕顾沉是否相信林夏，而是转向谁有权决定项目、公开证据和承担集团损失。篡改文件的人与顾家股东结成利益联盟，迫使林夏从个人自证升级为组建团队和改写公司规则。",
                "ending_payoff": "股东会上的完整证据链同时归还林夏的名誉、项目权和叙事权，顾沉必须在所有曾经站队的人面前承认自己的错判。林夏不用复合奖励他的成长，而是以独立决定未来合作与感情的方式完成最终回报。",
                "character_arcs": [
                    {"name": "林夏", "role": "失去婚姻话语权后重建事业与选择权的主角", "initial_state": "在顾家体系中习惯以解释和妥协换取丈夫信任。", "desire": "先是希望顾沉相信她，后转为拿回事业、名誉和未来选择。", "leverage": "离婚协议、项目能力、原始邮件和星河集团股权。", "turning_point": "顾沉在家宴当众站错队后，她放弃自证并签下离婚协议。", "final_state": "以集团决策者身份完成公开清算，并保留不复合的选择。", "evidence_references": ["C0001", "C0004", "C0006"]},
                    {"name": "顾沉", "role": "从误判者转为必须公开承担代价的旧关系掌权者", "initial_state": "相信自己可以同时裁判婚姻真相并安置林夏的未来。", "desire": "在保住顾氏项目的同时恢复林夏对他的信任和婚姻关系。", "leverage": "顾家名誉、集团资源和对旧婚姻叙事的控制。", "turning_point": "供应链危机证明林夏不但不需要他安置，还握有他无法替代的能力与资源。", "final_state": "在股东会公开承认错判并失去立即复合的权利，开始用行动承担。", "evidence_references": ["C0001", "C0003", "C0006"]},
                ],
                "key_turning_points": [
                    {"phase": "开篇", "event": "顾沉在家宴上根据篡改文件当众定罪林夏，并选择相信旧友。", "story_change": "婚姻中的隐性不对等变成公开且不可逆的关系伤害。", "evidence_references": ["C0001"]},
                    {"phase": "前段", "event": "林夏签下离婚协议离开顾家，随后以星河项目负责人身份解决顾氏供应链危机。", "story_change": "林夏从需要自证的妻子变为顾沉必须对等谈判的商业决策者。", "evidence_references": ["C0002", "C0003"]},
                    {"phase": "中段", "event": "原始邮件洗掉第一层指控，会议录音又指向顾家内部与股东的利益联盟。", "story_change": "个人婚姻误会升级为集团治理与资源控制权的系统性冲突。", "evidence_references": ["C0004"]},
                    {"phase": "终局", "event": "林夏在股东会公开完整证据链，顾沉当众承认错判，她拒绝立即复合。", "story_change": "林夏同时拿回名誉、项目和关系选择权，追悔不再自动换取情感奖励。", "evidence_references": ["C0006"]},
                ],
                "mechanisms": [
                    {"name": "离场立即反噬", "function": "让林夏的离开在下一个项目危机中立即产生可见代价，证明她不是可替代的婚姻附庸。", "trigger": "误判者做出不可逆站队，主角因此终止旧关系与旧职责。", "payoff": "原来享受主角劳动却否定她价值的人，立即面对无人可替的实际损失。", "transferable_strategy": "把关系切割与一项具体资源、职责或技能撤回绑在同一节点，让情感决定在事件层面立即生效。", "failure_boundary": "若主角离开后只有对方哭求而没有现实损失，或损失靠突然神豪身份解决，机制就会失真。", "evidence_references": ["C0001", "C0003"]},
                    {"name": "证据功能分层", "function": "原始邮件、会议录音和股权文件分别解决个人清白、幕后责任和最终裁判权，避免一份证据结束全剧。", "trigger": "每当主角洗掉一层误判时，已公开证据又暴露一个更高层级的利益问题。", "payoff": "受众持续获得小范围正名，同时保留对幕后联盟与终局股权裁判的期待。", "transferable_strategy": "先列出每层证据能改变的唯一状态，按个人、关系、资源、制度的层级递增公开，每次只完成一层回报。", "failure_boundary": "若后续证据只是重复证明主角没错，而没有改变冲突层级或行动目标，就会沦为拖延。", "evidence_references": ["C0002", "C0004", "C0006"]},
                    {"name": "追悔行动逐级失效", "function": "让顾沉从私下道歉、资源补偿到公开承责不断提高行动成本，并通过林夏的拒绝显示旧方法为何无效。", "trigger": "误判者发现真相的一部分，但仍想在不放弃旧权力的前提下恢复关系。", "payoff": "每次失败都让他更接近真正错误，也让女主的新边界变得更清晰和更具价值。", "transferable_strategy": "设计三级补偿：低成本语言、中成本资源、高成本公开责任；前两级因未触及核心伤害必须失败。", "failure_boundary": "若追悔只用痛苦表情和重复求见表现，或女主没有因每次拒绝获得新行动空间，爽点会迅速衰减。", "evidence_references": ["C0003", "C0005", "C0006"]},
                ],
                "signature_elements": ["家宴上的篡改项目文件", "离婚与供应链危机的紧邻反噬", "股东会上的完整证据链"],
                "source_specific_terms": ["林夏", "顾沉", "离婚协议", "星河集团"],
                "originality_boundary": "可迁移的是“关系切割立即撤回一项现实价值”、证据功能分层和追悔行动逐级失效的机制。不可复制林夏、顾沉等人物组合，家宴到供应链危机的连续桥段，离婚协议与三层证据的具体顺序，以及股东会公开承责的台词和动作设计。",
                "evidence_references": ["C0001", "C0002", "C0003", "C0004", "C0005", "C0006"],
            },
        }

    def test_manual_upload_creates_searchable_source_index_and_job(self):
        text = "# 离婚之后\n\n第1集\n婚礼现场，女主被当众误解。\n" + "她拿出合同反问对方。\n" * 80
        upload = UploadFile(filename="离婚之后.md", file=io.BytesIO(text.encode("utf-8")))

        result = script_library_service.create_uploaded_script(self.conn, actor=self.admin, upload=upload)

        self.assertEqual(result["script"]["status"], "queued")
        self.assertEqual(result["script"]["title"], "离婚之后")
        self.assertGreater(len(result["script"]["source_index"]), 0)
        source = script_library_service.search_source_chunks(
            self.conn, script_id=result["script"]["id"], query="合同"
        )
        self.assertIn("合同", source["chunks"][0]["content"])
        job = self.conn.execute(
            "SELECT status FROM script_distillation_jobs WHERE id = ?", (result["job_id"],)
        ).fetchone()
        self.assertEqual(job["status"], "queued")

    def test_upload_rejects_episode_packaging_variant_of_existing_title(self):
        first = UploadFile(
            filename="大山里的灯塔.md",
            file=io.BytesIO(("# 大山里的灯塔\n\n第1集\n" + "白芷和白芨在山村里寻找出路。\n" * 80).encode("utf-8")),
        )
        script_library_service.create_uploaded_script(self.conn, actor=self.admin, upload=first)
        packaged = UploadFile(
            filename="大山里的灯塔1-30集.md",
            file=io.BytesIO(("# 《大山里的灯塔》1-30集\n\n第1集\n" + "白芷回到山村后重新建立学堂。\n" * 80).encode("utf-8")),
        )

        with self.assertRaises(HTTPException) as raised:
            script_library_service.create_uploaded_script(self.conn, actor=self.admin, upload=packaged)

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("大山里的灯塔", str(raised.exception.detail))

    def test_distillation_contract_requires_four_tag_dimensions_and_evidence(self):
        payload = self.valid_distillation_payload()

        result = script_library_service._validate_distillation(
            payload,
            {f"C{index:04d}" for index in range(1, 7)},
            source_text="林夏、顾沉、离婚协议、星河集团",
        )

        self.assertEqual(result["tags"]["theme"], ["现代言情", "女性成长"])
        self.assertEqual(result["case_card"]["evidence_references"][-1], "C0006")

    def test_distillation_rejects_tags_outside_taxonomy(self):
        payload = self.valid_distillation_payload()
        payload["tags"]["audience"] = ["女性向"]

        with self.assertRaisesRegex(RuntimeError, "受众标签不在受控词表"):
            script_library_service._validate_distillation(
                payload,
                {f"C{index:04d}" for index in range(1, 7)},
                source_text="林夏、顾沉、离婚协议、星河集团",
            )

    def test_distillation_rejects_conflicting_story_eras(self):
        payload = self.valid_distillation_payload()
        payload["tags"]["background"] = ["现代", "古代", "宫廷"]

        with self.assertRaisesRegex(RuntimeError, "应以主要剧情时空为准"):
            script_library_service._validate_distillation(
                payload,
                {f"C{index:04d}" for index in range(1, 7)},
                source_text="林夏、顾沉、离婚协议、星河集团",
            )

    def test_metadata_update_rejects_conflicting_story_eras(self):
        upload = UploadFile(
            filename="标签校验.md",
            file=io.BytesIO(("第1集\n" + "林夏与顾沉围绕星河集团项目交锋。\n" * 80).encode("utf-8")),
        )
        script_id = script_library_service.create_uploaded_script(
            self.conn, actor=self.admin, upload=upload
        )["script"]["id"]
        tags = self.valid_distillation_payload()["tags"]
        tags["background"] = ["现代", "古代"]

        with self.assertRaises(HTTPException) as raised:
            script_library_service.update_script_metadata(
                self.conn,
                actor=self.admin,
                script_id=script_id,
                title=None,
                tags=tags,
            )

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("应以主要剧情时空为准", str(raised.exception.detail))
        self.assertEqual(script_library_service.get_script(self.conn, script_id)["tags"]["background"], [])

    def test_mechanism_curation_requires_every_candidate_once(self):
        result = script_library_service._validate_mechanism_curation(
            {
                "operations": [{
                    "candidate_keys": ["M01", "M02"],
                    "action": "reuse",
                    "mechanism_id": "mechanism-existing",
                    "reason": "两个候选的触发、因果过程和回报一致。",
                }]
            },
            candidate_keys={"M01", "M02"},
            existing_ids={"mechanism-existing"},
        )

        self.assertEqual(result["operations"][0]["candidate_keys"], ["M01", "M02"])
        with self.assertRaisesRegex(RuntimeError, "未完成判定"):
            script_library_service._validate_mechanism_curation(
                {
                    "operations": [{
                        "candidate_keys": ["M01"],
                        "action": "reuse",
                        "mechanism_id": "mechanism-existing",
                        "reason": "候选机制已经被现有机制完整覆盖。",
                    }]
                },
                candidate_keys={"M01", "M02"},
                existing_ids={"mechanism-existing"},
            )

        with self.assertRaisesRegex(RuntimeError, "残留原剧专属词"):
            script_library_service._validate_mechanism_curation(
                {
                    "operations": [{
                        "candidate_keys": ["M01"],
                        "action": "create",
                        "mechanism_id": "",
                        "reason": "该候选的核心因果尚未被现有机制覆盖。",
                        "title": "公开证据反转",
                        "function": "让林夏在公开场合使用证据重写原有判断并收回行动权。",
                        "trigger": "对手已经在公开场合完成指控，主角手中存在可以复核的证据链。",
                        "payoff": "原来的指控者在同一批见证人面前失去判断权并承担代价。",
                        "transferable_strategy": "先让对手锁死立场，再分层展示可验证事实，最后使用同一裁判规则反向定责。",
                        "failure_boundary": "若对手同时完全控制证据、见证人和裁判者，则应先建立独立验证环节。",
                    }]
                },
                candidate_keys={"M01"},
                existing_ids=set(),
                forbidden_terms={"林夏"},
            )

        generic_setting = script_library_service._validate_mechanism_curation(
            {
                "operations": [{
                    "candidate_keys": ["M01"],
                    "action": "create",
                    "mechanism_id": "",
                    "reason": "该候选的核心因果尚未被现有机制覆盖。",
                    "title": "双方身份错位验证",
                    "function": "利用身份错位迫使双方重新验证原有判断和关系责任。",
                    "trigger": "灵魂互换或其他身份错位已经改变了双方的行动权限。",
                    "payoff": "原有误判被具体经历推翻，关系和资源分配发生可见变化。",
                    "transferable_strategy": "先规定错位的权限与限制，再让双方分别经历对方的现实压力，最后用行动重新分配责任。",
                    "failure_boundary": "若错位不改变任何信息、权限或选择代价，则只是表层噪头。",
                }]
            },
            candidate_keys={"M01"},
            existing_ids=set(),
            forbidden_terms={"灵魂互换"},
        )
        self.assertEqual(generic_setting["operations"][0]["title"], "双方身份错位验证")

    def test_create_mechanism_id_is_owned_by_service(self):
        normalized = script_library_service._coalesce_mechanism_operations({
            "operations": [{
                "candidate_keys": ["M01"],
                "action": "create",
                "mechanism_id": "MECH-0001",
                "reason": "历史机制无法解释该候选的完整因果。",
                "title": "公开证据反转",
                "function": "让主角在公开场合使用证据重写原有判断并收回行动权。",
                "trigger": "对手已经在公开场合完成指控，主角手中存在可以复核的证据链。",
                "payoff": "原来的指控者在同一批见证人面前失去判断权并承担代价。",
                "transferable_strategy": "先让对手锁死公开立场，再分层展示可验证事实，最后使用同一裁判规则反向定责。",
                "failure_boundary": "若对手同时完全控制证据、见证人和裁判者，则应先建立独立验证环节。",
            }]
        })
        result = script_library_service._validate_mechanism_curation(
            normalized,
            candidate_keys={"M01"},
            existing_ids=set(),
        )

        self.assertEqual(result["operations"][0]["mechanism_id"], "")

    def test_retry_reuses_validated_distillation_checkpoint(self):
        sections = ["# 检查点剧本"]
        for episode in range(1, 7):
            sections.append(
                f"第{episode}集\n" + "林夏、顾沉、离婚协议和星河集团推动一次具体冲突。\n" * 70
            )
        upload = UploadFile(
            filename="检查点剧本.md",
            file=io.BytesIO("\n".join(sections).encode("utf-8")),
        )
        created = script_library_service.create_uploaded_script(self.conn, actor=self.admin, upload=upload)
        old_job_id = created["job_id"]
        old_directory = script_library_service._work_directory(old_job_id)
        (old_directory / "result.json").write_text(
            json.dumps(self.valid_distillation_payload(), ensure_ascii=False),
            encoding="utf-8",
        )
        self.conn.execute(
            "UPDATE script_distillation_jobs SET status = 'failed' WHERE id = ?",
            (old_job_id,),
        )
        self.conn.execute(
            """
            UPDATE script_library_scripts
            SET status = 'failed', distillation_stage = 'formula',
                distillation_stage_label = '提炼公式候选',
                distillation_progress_current = 8,
                distillation_progress_total = 12,
                distillation_progress_message = '公式阶段未完成'
            WHERE id = ?
            """,
            (created["script"]["id"],),
        )
        retried = script_library_service.retry_distillation(
            self.conn,
            actor=self.admin,
            script_id=created["script"]["id"],
        )
        script = self.conn.execute(
            "SELECT * FROM script_library_scripts WHERE id = ?",
            (created["script"]["id"],),
        ).fetchone()

        self.assertEqual(script["distillation_stage"], "formula")
        self.assertEqual(script["distillation_progress_current"], 8)
        self.assertEqual(script["distillation_progress_total"], 12)
        self.assertIn("继续", script["distillation_progress_message"])

        checkpoint = script_library_service._load_distillation_checkpoint(
            retried["job_id"],
            script,
            self.conn,
        )

        self.assertIsNotNone(checkpoint)
        self.assertEqual(checkpoint[1], old_job_id)
        self.assertEqual(checkpoint[0]["summary"], self.valid_distillation_payload()["summary"])
        self.assertTrue(
            (script_library_service._work_directory(retried["job_id"]) / "distillation-checkpoint.json").is_file()
        )

    def test_mechanism_curation_reuses_card_and_accumulates_cross_genre_tags(self):
        first_upload = UploadFile(
            filename="都市证据反击.md",
            file=io.BytesIO(("第1集\n" + "林夏在股东会公开证据并完成反击。\n" * 80).encode("utf-8")),
        )
        first_id = script_library_service.create_uploaded_script(
            self.conn, actor=self.admin, upload=first_upload
        )["script"]["id"]
        first_payload = self.valid_distillation_payload()
        first_script = self.conn.execute(
            "SELECT * FROM script_library_scripts WHERE id = ?", (first_id,)
        ).fetchone()
        script_library_service._save_distillation(self.conn, first_script, first_payload)
        first_candidate = script_library_service._mechanism_candidates(first_id, first_payload)[0]
        create_operation = {
            "candidate_keys": [first_candidate["key"]],
            "action": "create",
            "mechanism_id": "",
            "reason": "现有机制库为空，该因果结构需要建立首张通用卡。",
            "title": "公开指控的证据反转",
            "function": "让对手先在公开场合完成指控，再用可核验证据重写现场的判断权。",
            "trigger": "对手已经借助公共规则或群体站队对主角定性，且主角拥有可复核的证据。",
            "payoff": "证据不仅证明主角清白，还让指控者在原见证人面前承担误判代价。",
            "transferable_strategy": "先建立有明确裁判规则的公开场，再让对手锁死立场，最后抛出能被现场验证的证据链。",
            "failure_boundary": "证据必须可验证且公共裁判仍然有效；若对手完全控制证据与裁判者，机制无法成立。",
        }
        first_summary = script_library_service._apply_mechanism_curation(
            self.conn,
            script_id=first_id,
            curation={"operations": [create_operation]},
            candidates=[first_candidate],
        )
        mechanism_id = first_summary["mechanism_ids"][0]

        second_upload = UploadFile(
            filename="古代庭审反击.md",
            file=io.BytesIO(("第1集\n" + "女主在庭审中以官文和证人推翻指控。\n" * 80).encode("utf-8")),
        )
        second_id = script_library_service.create_uploaded_script(
            self.conn, actor=self.admin, upload=second_upload
        )["script"]["id"]
        second_payload = self.valid_distillation_payload()
        second_payload["tags"] = {
            "theme": ["古风言情", "权谋"],
            "setting": ["大女主", "打脸虐渣"],
            "background": ["古代", "宫廷"],
            "audience": ["女频"],
        }
        second_script = self.conn.execute(
            "SELECT * FROM script_library_scripts WHERE id = ?", (second_id,)
        ).fetchone()
        script_library_service._save_distillation(self.conn, second_script, second_payload)
        second_candidate = script_library_service._mechanism_candidates(second_id, second_payload)[0]
        script_library_service._apply_mechanism_curation(
            self.conn,
            script_id=second_id,
            curation={
                "operations": [{
                    "candidate_keys": [second_candidate["key"]],
                    "action": "reuse",
                    "mechanism_id": mechanism_id,
                    "reason": "题材不同，但公开指控、可核验证据和现场反转的因果结构一致。",
                }]
            },
            candidates=[second_candidate],
        )

        card = self.conn.execute(
            "SELECT * FROM script_library_formula_cards WHERE id = ?", (mechanism_id,)
        ).fetchone()
        self.assertEqual(card["source_count"], 2)
        self.assertEqual(card["status"], "active")
        tags = json.loads(card["applicable_tags_json"])
        self.assertIn("现代言情", tags)
        self.assertIn("古风言情", tags)
        self.assertIn("现代", tags)
        self.assertIn("古代", tags)
        evidence = json.loads(card["content_json"])["evidence"]
        self.assertEqual({item["script_id"] for item in evidence}, {first_id, second_id})

        edited_tags = {**second_payload["tags"], "theme": ["古风言情", "宫斗"]}
        script_library_service.update_script_metadata(
            self.conn,
            actor=self.admin,
            script_id=second_id,
            title=None,
            tags=edited_tags,
        )
        refreshed = self.conn.execute(
            "SELECT applicable_tags_json FROM script_library_formula_cards WHERE id = ?", (mechanism_id,)
        ).fetchone()
        refreshed_tags = json.loads(refreshed["applicable_tags_json"])
        self.assertIn("宫斗", refreshed_tags)
        self.assertNotIn("权谋", refreshed_tags)

        improved = {
            "candidate_keys": [second_candidate["key"]],
            "action": "improve",
            "mechanism_id": mechanism_id,
            "reason": "古代案例补足了裁判者可能被权力控制时的失效边界。",
            "title": "公开指控的证据重判",
            "function": "让对手先在公开场合锁死指控，再用可核验证据改写现场的判断权与责任归属。",
            "trigger": "对手已经借助公共规则或群体站队对主角定性，且主角拥有可复核的事实链。",
            "payoff": "证据在原见证人和原裁判规则下完成重判，使指控者承担可见的误判代价。",
            "transferable_strategy": "先设计一个能让对手公开表态的裁判场，再让主角逐步展示可验证事实，最后用同一规则反向定责。",
            "failure_boundary": "至少要有独立见证人、无法完全操纵的验证环节或更高层裁判；若对手同时控制证据和裁判，应先转向取证或破局机制。",
        }
        improve_summary = script_library_service._apply_mechanism_curation(
            self.conn,
            script_id=second_id,
            curation={"operations": [improved]},
            candidates=[second_candidate],
        )
        self.assertEqual(improve_summary["mechanism_ids"], [mechanism_id])
        improved_card = self.conn.execute(
            "SELECT * FROM script_library_formula_cards WHERE id = ?", (mechanism_id,)
        ).fetchone()
        improved_content = json.loads(improved_card["content_json"])
        self.assertEqual(improved_card["title"], "公开指控的证据重判")
        self.assertEqual(improved_card["source_count"], 2)
        self.assertEqual(improved_content["revision"], 2)
        self.assertEqual(len(improved_content["evidence"]), 2)
        self.assertEqual(len(improved_content["curation_history"]), 2)
        library = script_library_service.list_scripts(self.conn)
        self.assertEqual(library["stats"]["formula_counts"]["mechanism"], 1)
        self.assertEqual(library["stats"]["formula_cards"], 6)
        self.assertEqual(library["stats"]["principle_cards"], 1)

        formulas = script_library_service.list_formula_cards(self.conn, card_kind="formula")
        principles = script_library_service.list_formula_cards(self.conn, card_kind="principle")
        self.assertEqual(formulas["pagination"]["total"], 6)
        self.assertTrue(all(card["formula_type"] != "mechanism" for card in formulas["formulas"]))
        self.assertEqual(principles["pagination"]["total"], 1)
        self.assertEqual(principles["formulas"][0]["formula_type"], "mechanism")

        first_detail = script_library_service.get_script(self.conn, first_id)
        self.assertEqual(len(first_detail["formula_cards"]), 3)
        self.assertEqual([card["id"] for card in first_detail["principle_cards"]], [mechanism_id])

        script_library_service.delete_script(self.conn, actor=self.admin, script_id=second_id)
        reduced_card = self.conn.execute(
            "SELECT * FROM script_library_formula_cards WHERE id = ?", (mechanism_id,)
        ).fetchone()
        reduced_content = json.loads(reduced_card["content_json"])
        reduced_tags = json.loads(reduced_card["applicable_tags_json"])
        self.assertEqual(reduced_card["source_count"], 1)
        self.assertEqual(reduced_card["status"], "candidate")
        self.assertEqual(len(reduced_content["evidence"]), 1)
        self.assertIn("现代", reduced_tags)
        self.assertNotIn("古代", reduced_tags)

    def test_bootstrap_source_quality_ignores_whitespace_padding(self):
        source = ("蜘\n 蛛              闲\n                 鱼\n                    潜\n" * 100)

        self.assertGreater(len(source), 1000)
        self.assertIn("有效正文不足 1000 字", script_library_service._bootstrap_source_error(source))
        self.assertIsNone(script_library_service._bootstrap_source_error("有效剧情内容" * 200))

    def test_unusable_bootstrap_source_cannot_be_retried(self):
        source = "蜘\n 蛛              闲\n" * 100
        source_path = script_library_service._write_source("b" * 64, source)
        cursor = self.conn.execute(
            """
            INSERT INTO script_library_scripts (
                title, source_type, source_label, original_filename, source_file_path,
                source_sha256, chars, status, error_message, created_by
            ) VALUES ('排版残片', 'short-writing-skill', '首批剧本库', '排版残片.md', ?, ?, ?, 'failed', ?, ?)
            """,
            (
                str(source_path),
                "b" * 64,
                len(source),
                script_library_service._bootstrap_source_error(source),
                self.admin["id"],
            ),
        )
        script_id = int(cursor.lastrowid)

        self.assertFalse(script_library_service.get_script(self.conn, script_id)["retryable"])
        with self.assertRaises(HTTPException) as raised:
            script_library_service.retry_distillation(
                self.conn, actor=self.admin, script_id=script_id
            )
        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("有效正文不足 1000 字", str(raised.exception.detail))

    def test_redistillation_replaces_stale_single_script_formula_cards(self):
        upload = UploadFile(
            filename="旧知识卡.md",
            file=io.BytesIO(("第1集\n" + "林夏与顾沉围绕星河集团项目交锋。\n" * 80).encode("utf-8")),
        )
        script_id = script_library_service.create_uploaded_script(
            self.conn, actor=self.admin, upload=upload
        )["script"]["id"]
        self.conn.execute(
            """
            INSERT INTO script_library_formula_cards (
                id, formula_type, title, description, applicable_tags_json,
                source_script_ids_json, source_count, status, origin, content_json
            ) VALUES ('stale-card', 'core', '旧卡', '旧内容', '[]', ?, 1, 'candidate', 'manual-ai', '{}')
            """,
            (json.dumps([script_id]),),
        )
        script = self.conn.execute(
            "SELECT * FROM script_library_scripts WHERE id = ?", (script_id,)
        ).fetchone()

        script_library_service._save_distillation(
            self.conn,
            script,
            self.valid_distillation_payload(),
            version="script-library-v2-luna-max",
            formula_origin="luna-v2",
        )

        self.assertIsNone(
            self.conn.execute("SELECT id FROM script_library_formula_cards WHERE id = 'stale-card'").fetchone()
        )
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM script_library_formula_cards WHERE origin = 'luna-v2'"
            ).fetchone()[0],
            3,
        )

    def test_upload_rejects_a_duplicate_script_title(self):
        source = ("家宴反击\n第1集\n" + "林夏用证据在家宴上完成反击。\n" * 40).encode("utf-8")
        first = UploadFile(filename="家宴反击.md", file=io.BytesIO(source))
        second = UploadFile(
            filename="家宴反击.txt",
            file=io.BytesIO(("家宴反击\n第1集\n" + "顾沉用新证据推翻旧结论。\n" * 40).encode("utf-8")),
        )
        script_library_service.create_uploaded_script(self.conn, actor=self.admin, upload=first)

        with self.assertRaises(HTTPException) as raised:
            script_library_service.create_uploaded_script(self.conn, actor=self.admin, upload=second)

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("已在剧本库中", str(raised.exception.detail))

    def test_delete_script_cleans_candidate_formula_and_updates_shared_sources(self):
        first_upload = UploadFile(filename="剧本一.md", file=io.BytesIO(("第1集\n" + "主角公开反击。\n" * 40).encode("utf-8")))
        second_upload = UploadFile(filename="剧本二.md", file=io.BytesIO(("第1集\n" + "主角守住家业。\n" * 40).encode("utf-8")))
        first_id = script_library_service.create_uploaded_script(
            self.conn, actor=self.admin, upload=first_upload
        )["script"]["id"]
        second_id = script_library_service.create_uploaded_script(
            self.conn, actor=self.admin, upload=second_upload
        )["script"]["id"]
        self.conn.execute(
            """
            INSERT INTO script_library_formula_cards (
                id, formula_type, title, description, applicable_tags_json,
                source_script_ids_json, source_count, status, origin, content_json
            ) VALUES (?, 'core', ?, ?, '[]', ?, 1, 'candidate', 'manual-ai', '{}')
            """,
            ("manual-test", "单剧候选", "只属于剧本一", json.dumps([first_id])),
        )
        self.conn.execute(
            """
            INSERT INTO script_library_formula_cards (
                id, formula_type, title, description, applicable_tags_json,
                source_script_ids_json, source_count, status, origin, content_json
            ) VALUES (?, 'gratification', ?, ?, '[]', ?, 1, 'candidate', 'luna-v2', '{}')
            """,
            ("luna-test", "Luna 单剧候选", "只属于剧本一", json.dumps([first_id])),
        )
        self.conn.execute(
            """
            INSERT INTO script_library_formula_cards (
                id, formula_type, title, description, applicable_tags_json,
                source_script_ids_json, source_count, status, origin, content_json
            ) VALUES (?, 'world', ?, ?, '[]', ?, 2, 'active', 'short-writing-skill-v1', '{}')
            """,
            ("shared-test", "聚合知识", "共享公式", json.dumps([first_id, second_id])),
        )

        script_library_service.delete_script(self.conn, actor=self.admin, script_id=first_id)

        self.assertIsNone(
            self.conn.execute("SELECT id FROM script_library_formula_cards WHERE id = 'manual-test'").fetchone()
        )
        self.assertIsNone(
            self.conn.execute("SELECT id FROM script_library_formula_cards WHERE id = 'luna-test'").fetchone()
        )
        shared = self.conn.execute(
            "SELECT source_script_ids_json, source_count FROM script_library_formula_cards WHERE id = 'shared-test'"
        ).fetchone()
        self.assertEqual(json.loads(shared["source_script_ids_json"]), [second_id])
        self.assertEqual(shared["source_count"], 1)

    def test_bootstrap_import_is_idempotent_and_queues_full_text_distillation(self):
        source_root = Path(self.temp_dir.name) / "short-writing-skill"
        library = source_root / "assets" / "library"
        full_scripts = source_root / "assets" / "full-scripts"
        mechanisms = source_root / "assets" / "mechanism-index"
        library.mkdir(parents=True)
        full_scripts.mkdir(parents=True)
        mechanisms.mkdir(parents=True)

        def write_jsonl(path: Path, values: list[dict]):
            path.write_text("".join(json.dumps(value, ensure_ascii=False) + "\n" for value in values), encoding="utf-8")

        source_text = "第1集\n家宴上，主角被误判。\n" + "她用遗嘱反击。\n" * 150
        source_hash = "a" * 64
        write_jsonl(library / "script_manifest.jsonl", [{
            "id": "s0001", "title": "家宴反击", "category": "女频短剧/重生复仇",
            "source_label": "女频短剧/家宴反击.md", "chars": len(source_text), "episode_count": 1,
        }])
        write_jsonl(library / "case_cards.jsonl", [{
            "script_id": "s0001", "audience_emotion": "被害者清算", "type_promise": "主角用证据逐层清算。",
            "opening_pressure": "家宴审判", "first3_model": "误判-证据-反击", "first10_model": "逐层清算",
            "midgame_upgrade": "家族资源争夺", "tags": ["重生"],
        }])
        write_jsonl(library / "beat_patterns.jsonl", [{
            "id": "b001", "category": "女频短剧/重生复仇", "type_promise": "逐层清算",
            "first_screen": "公开误判", "midgame_upgrade": "更高权力", "audience_emotion": "复仇",
            "first3_model": "压迫-反击", "first10_model": "小仗-旧账",
        }])
        write_jsonl(library / "dialogue_patterns.jsonl", [{"id": "d001", "function": "公开误判", "pattern": "用事实反问"}])
        write_jsonl(mechanisms / "mechanisms.jsonl", [{"id": "m001", "title": "证据倒计时", "transferable_mechanism": "证据将揭未揭"}])
        write_jsonl(full_scripts / "manifest.jsonl", [{
            "id": "fs0001", "filename": "fs_001.enc", "plaintext_sha256": source_hash,
        }])
        (full_scripts / "fs_001.enc").write_bytes(b"encrypted")

        with patch.object(script_library_service, "_decrypt_source", return_value=source_text):
            first = script_library_service.import_short_writing_skill(
                self.conn, actor=self.admin, source_root=source_root
            )
            second = script_library_service.import_short_writing_skill(
                self.conn, actor=self.admin, source_root=source_root
            )

        self.assertEqual(first["imported"], 1)
        self.assertEqual(second["imported"], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM script_library_scripts").fetchone()[0], 1)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM script_library_formula_cards").fetchone()[0], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM script_distillation_jobs").fetchone()[0], 1)
        script = script_library_service.get_script(self.conn, 1)
        self.assertEqual(script["tags"]["theme"], [])
        self.assertEqual(script["status"], "queued")


class MechanismCurationScriptTest(unittest.TestCase):
    def test_group_schema_matches_runtime_content_limits(self):
        schema = curate_script_mechanisms._group_schema(36)
        properties = schema["properties"]["groups"]["items"]["properties"]

        self.assertEqual(schema["required"], ["groups"])
        self.assertEqual(properties["function"]["minLength"], 20)
        self.assertEqual(properties["transferable_strategy"]["minLength"], 30)
        self.assertEqual(properties["failure_boundary"]["maxLength"], 600)

        operation_schema = curate_script_mechanisms._operation_schema()
        self.assertEqual(operation_schema["required"], ["operations"])

    def test_split_model_operations_are_coalesced_before_strict_validation(self):
        result = curate_script_mechanisms._coalesce_routing_operations(
            {
                "operations": [
                    {
                        "candidate_keys": ["M01"],
                        "action": "reuse",
                        "mechanism_id": "seed-001",
                        "reason": "结构一致。",
                    },
                    {
                        "candidate_keys": ["M02"],
                        "action": "improve",
                        "mechanism_id": "seed-001",
                        "reason": "补充失效边界。",
                        "title": "更完整机制",
                        "function": "补充机制在公开裁决中的可迁移作用。",
                        "trigger": "存在公开裁决且主角拥有可验证事实。",
                        "payoff": "裁决结果反转并产生可见责任。",
                        "transferable_strategy": "先锁定公开立场，再分层验证事实，最后使用同一规则反向定责。",
                        "failure_boundary": "若证据和裁判都被同一方控制，先建立独立验证。",
                    },
                ]
            }
        )
        self.assertEqual(len(result["operations"]), 1)
        operation = result["operations"][0]
        self.assertEqual(operation["candidate_keys"], ["M01", "M02"])
        self.assertEqual(operation["action"], "improve")
        self.assertIn("补充失效边界", operation["reason"])

    def test_group_prompt_uses_cli_output_instead_of_file_writes(self):
        prompt = curate_script_mechanisms._group_prompt(
            input_path=Path("input.json"),
            output_path=Path("result.json"),
            max_groups=36,
            final_stage=False,
            legacy_path=None,
        )

        self.assertIn("Codex CLI 会自动将响应保存", prompt)
        self.assertIn("不得调用 Write、apply_patch 或 shell", prompt)


if __name__ == "__main__":
    unittest.main()
