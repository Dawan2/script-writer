import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDistillation } from "../skills/script-distillation/scripts/init-distillation.mjs";
import { readSourceChunks } from "../skills/script-distillation/scripts/read-source-chunks.mjs";
import { validateDistillation } from "../skills/script-distillation/scripts/check-distillation.mjs";

const sourceSections = [
  "第1集。林夏在蓝港集团发布会上被取消星海计划的署名。周淮要求她当场交出全部资料，她没有解释身份，而是记录现场每个人的表态。这个选择让公开误判先形成，并把后续反证需要面对的裁判规则建立起来。",
  "第2至5集。林夏继续完成项目验证，同时发现周淮也在调查署名被改的原因。两人从公开对立转为有限合作，但双方都隐瞒了旧合同。每次合作都会带来新证据，也让他们承担更高的职业风险和关系代价。",
  "第6至12集。蓝港集团用资源封锁迫使林夏退出，林夏转而联合客户进行独立测试。她先证明方案有效，再公开原始记录，使争议从个人口角变成可以复核的责任问题，周淮因此失去继续观望的空间。",
  "第13至20集。周淮查明旧合同由家族代理人替换，却发现自己的沉默同样造成伤害。他必须在继承资格和公开作证之间选择。林夏拒绝把和解当作补偿，要求先恢复团队利益和项目控制权。",
  "第21至28集。双方在审计会上提交相互独立的证据，星海计划的控制权被重新分配。反对者试图将矛盾转化为私人感情争执，但林夏坚持让每个决定对应具体责任、资源和后果。",
  "终局。周淮公开放弃以继承权交换沉默的条件，林夏取得项目决策权但保留独立团队。两人的关系不是靠一句道歉恢复，而是在共同承担损失、完成责任清算后进入新的合作状态。"
];

// 校验要求 creative_decision、creative_problem 与 usage_scenario 完全一致，
// expected_effect 与 goal 完全一致，因此这两组文案各只写一份。
const FORMULA_USAGE_SCENARIO = "开篇需要用一次公开误判快速建立压迫，并把它转化为可持续推进的反证行动线。";
const FORMULA_GOAL = "建立一个会迫使主角行动的未解状态，并让后续反转真正改变责任和行动权。";

function indexedSource() {
  return sourceSections.map((content, index) => {
    const repeated = `${content}\n${content}\n${content}`;
    return `<!-- C${String(index + 1).padStart(4, "0")} | 第${index + 1}阶段 -->\n${repeated}`;
  }).join("\n\n");
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "script-distillation-"));
  const source = path.join(directory, "source.md");
  const output = path.join(directory, "result.json");
  await fs.writeFile(source, indexedSource(), "utf8");
  const initialized = await initializeDistillation({ source, output, title: "星海署名" });
  const payload = JSON.parse(await fs.readFile(output, "utf8"));
  Object.assign(payload, {
    summary: "林夏在项目署名被夺后，没有把争议停留在私人辩解，而是通过独立验证、原始记录和公开审计逐步夺回项目控制权。周淮从利益观望者转为责任承担者，两人在完成团队补偿和权力重分配后建立新的合作关系。",
    tags: {
      theme: ["现代言情", "女性成长", "商战"],
      setting: ["大女主", "业界精英", "强强联合"],
      background: ["现代", "都市", "职场"],
      audience: ["女频"]
    },
    case_card: {
      logline: "项目负责人林夏在署名和控制权被夺后，以独立验证和公开审计完成责任清算，并重新选择亲密关系。",
      audience_promise: "观众持续等待女主把被私人化的委屈转化为可核验的职业责任，并看到男主用实际损失而不是口头道歉完成补偿。",
      story_engine: {
        initial_situation: "林夏失去项目署名和组织内的话语权，公开解释也无法改变既有权力判断。",
        protagonist_goal: "恢复团队成果的真实归属，并取得不再受家族权力摆布的项目决策权。",
        main_resistance: "组织资源、旧合同和周淮的利益观望共同阻止事实被公开核验。",
        stakes: "失败不仅意味着职业成果被夺，也会让团队成员承担违约责任并失去行业信用。",
        repeatable_conflict_loop: "每取得一层可核验证据，既得利益方就升级资源封锁，主角必须扩大验证范围并迫使新的责任人站队。",
        ending_change: "项目控制权和责任被重新分配，人物关系从隐瞒与观望转为以共同承担后果为前提的合作。"
      },
      world_rules: [{
        rule: "组织内的署名和项目控制权必须通过合同、测试结果与审计记录共同确认。",
        resource_or_limit: "公司掌握预算和正式发布渠道，独立团队只能依靠客户测试建立外部证据。",
        violation_cost: "绕过核验程序会触发违约、行业信用损失和继承资格变化。",
        story_function: "让人物不能只靠表态解决冲突，每次选择都必须改变可验证的资源和责任。",
        evidence_references: ["C0001", "C0003", "C0005"]
      }],
      characters: [{
        name: "林夏",
        dramatic_function: "以行动验证推动责任公开的主角。",
        desire: "夺回团队成果和项目决策权。",
        fear_need_or_misbelief: "担心任何关系合作都会再次稀释团队的真实贡献。",
        leverage: "原始记录、技术能力和客户验证渠道。",
        secret_or_unknown: "起初不知道旧合同被谁替换，也无法确认周淮是否参与。",
        initial_state: "拥有专业能力但失去组织内的正式身份和话语权。",
        turning_action: "放弃内部辩解，组织独立测试并把争议转化为可审计的责任问题。",
        final_state: "取得项目决策权，同时保留独立团队和重新选择关系的主动权。",
        evidence_references: ["C0001", "C0003", "C0005", "C0006"]
      }, {
        name: "周淮",
        dramatic_function: "掌握内部资源却必须从观望转为承担代价的关系对手。",
        desire: "保住继承资格并查清项目署名被替换的责任。",
        fear_need_or_misbelief: "误以为保持中立即可避免对任何一方造成新的伤害。",
        leverage: "内部调查权限、正式审计入口和家族继承资源。",
        secret_or_unknown: "隐瞒旧合同存在，也不知道代理人已经更换关键页面。",
        initial_state: "在利益和关系之间观望，用调查尚未完成延迟公开站队。",
        turning_action: "在继承资格与公开作证之间选择后者，并承认沉默造成的实际后果。",
        final_state: "失去部分继承利益，以承担损失为前提获得重新合作的机会。",
        evidence_references: ["C0002", "C0004", "C0005", "C0006"]
      }],
      relationship_dynamics: [{
        parties: ["林夏", "周淮"],
        initial_power: "周淮掌握组织资源和正式调查入口，林夏掌握专业事实却没有公开裁判权。",
        debt_or_misunderstanding: "旧合同和男方长期观望让职业伤害被误解为可以私下和解的感情争执。",
        change_chain: "公开对立转为有限合作，合作暴露隐瞒，再由利益选择和共同承担损失建立新的信任。",
        final_state: "双方在权力重新分配后恢复合作，关系不再以一方提供资源、另一方接受补偿为基础。",
        evidence_references: ["C0001", "C0002", "C0004", "C0006"]
      }],
      narrative_phases: [{
        phase: "公开误判",
        goal: "保留原始事实并确认现场各方的公开立场。",
        opposition: "组织权力试图迫使主角当场退出并接受既有署名。",
        irreversible_change: "主角不再依赖内部解释，冲突转向外部验证。",
        audience_return: "观众明确看见伤害、责任缺口和主角可执行的反击方向。",
        evidence_references: ["C0001", "C0002"]
      }, {
        phase: "证据扩张",
        goal: "用独立测试和原始记录把私人争议转化为责任问题。",
        opposition: "资源封锁和关系隐瞒不断提高验证成本。",
        irreversible_change: "证据迫使掌握内部权力的人公开站队。",
        audience_return: "能力证明与关系真相同步兑现，但新的代价继续推动追看。",
        evidence_references: ["C0003", "C0004"]
      }, {
        phase: "责任清算",
        goal: "完成控制权、团队利益和人物责任的重新分配。",
        opposition: "反对者试图把公共责任重新缩减成私人感情争执。",
        irreversible_change: "男主承担继承损失，女主取得独立决策权。",
        audience_return: "职业正义和关系修复都通过可见行动完成。",
        evidence_references: ["C0005", "C0006"]
      }],
      audience_payoffs: [{
        payoff_type: "职业反击",
        setup: "女主被公开取消署名，组织规则暂时站在既得利益方一边。",
        pressure: "预算封锁和行业信用风险让她无法只靠口头证明自己。",
        release: "她用客户测试、原始记录和独立审计逐层建立外部证据。",
        story_consequence: "项目控制权和责任分配被正式改变，反击不止停留在舆论胜负。",
        evidence_references: ["C0001", "C0003", "C0005"]
      }, {
        payoff_type: "关系修复",
        setup: "男方把观望误认为中立，女方拒绝接受无代价的口头道歉。",
        pressure: "真相要求男方在继承利益和公开责任之间选择。",
        release: "男方放弃利益并公开作证，女方在保留独立权后重新选择合作。",
        story_consequence: "关系改变建立在责任清算之后，避免用爱情覆盖职业伤害。",
        evidence_references: ["C0002", "C0004", "C0006"]
      }],
      key_observations: [{
        observation_id: "O01",
        stage: "trial_generate",
        creative_problem: "开篇需要快速建立压迫，同时为后续反击保留可执行空间。",
        setup: "主角拥有事实和能力，但公开裁判权掌握在对手组织手中。",
        author_choice: "先让组织完成公开定性，再让主角记录立场并转向独立验证。",
        story_change: "争议从现场口角转向谁能建立可复核证据，主角获得连续行动目标。",
        audience_effect_hypothesis: "公开误判与明确行动方向可能同时形成不平感和对反证兑现的期待。",
        tradeoff_or_boundary: "若主角没有实际验证能力或后续证据无法改变权力，延迟解释只会显得被动。",
        evidence_references: ["C0001", "C0003"]
      }, {
        observation_id: "O02",
        stage: "outline_rewrite",
        creative_problem: "中段需要让证据升级同时推动人物关系，避免两条线彼此脱节。",
        setup: "双方各自掌握不同证据和资源，也各自隐瞒会伤害合作的事实。",
        author_choice: "每次合作获得新证据时，同时暴露一层隐瞒并提高下一次选择代价。",
        story_change: "查明真相不再自动等于关系修复，人物必须为此前选择承担具体后果。",
        audience_effect_hypothesis: "事实进展和关系变化共用同一行动，可能减少中段重复调查的疲劳。",
        tradeoff_or_boundary: "如果隐瞒与当前行动没有因果联系，连续揭密会沦为人为制造误会。",
        evidence_references: ["C0002", "C0004"]
      }, {
        observation_id: "O03",
        stage: "full_generate",
        creative_problem: "终局需要同时兑现职业胜负和感情修复，又不能让爱情覆盖公共责任。",
        setup: "女主要求恢复团队利益，男主必须在个人资源和公开责任之间做出选择。",
        author_choice: "先完成审计与控制权重分配，再通过承担继承损失恢复合作资格。",
        story_change: "关系修复成为责任清算后的新选择，而不是对既有伤害的替代补偿。",
        audience_effect_hypothesis: "双重回报都落实为可见后果，可能提高终局的公平感和情感可信度。",
        tradeoff_or_boundary: "若利益损失只是口头声明或女主重新依附原权力，关系回报仍会抵消成长线。",
        evidence_references: ["C0005", "C0006"]
      }],
      strengths: ["职业线和关系线通过同一组证据与选择推进，关键回报会改变人物实际权力。"],
      limitations: ["外部客户的支持过程展开较少，独立验证能够顺利进入审计仍依赖一定情节便利。"],
      source_specific_terms: ["林夏", "周淮", "星海计划", "蓝港集团"],
      evidence_references: ["C0001", "C0002", "C0003", "C0004", "C0005", "C0006"]
    },
    formula_candidates: [{
      candidate_id: "F01",
      category: "hook_information",
      name: "公开误判后的可验证反证",
      stages: ["trial_generate", "full_generate"],
      usage_scenario: FORMULA_USAGE_SCENARIO,
      not_applicable: ["场内不存在能够公开定性的裁判规则时不适用", "主角没有可以逐步验证的事实资源时不适用"],
      creative_decision: FORMULA_USAGE_SCENARIO,
      creative_problem: FORMULA_USAGE_SCENARIO,
      goal: FORMULA_GOAL,
      core_formula: "公开定性锁定立场，被误判者转向可积累的验证行动，分层扩大证据的独立性与见证范围，最后用同一裁判规则重新分配责任与行动权。",
      conditions: ["场内存在能够公开定性的裁判规则", "主角拥有暂未被承认但可以逐步验证的事实资源"],
      variables: ["被误判者", "定性者", "裁判规则", "可验证事实"],
      steps: ["先让定性者在公开规则下锁定立场", "让被误判者选择能够积累证据的行动而非立即争辩", "分层扩大证据的独立性和见证范围", "用同一裁判规则改变责任与行动权"],
      mechanism: "公开立场提高反悔成本，可验证事实逐层扩大判断者范围，使期待最终落实为权力和责任的重新分配。",
      expected_effect: FORMULA_GOAL,
      observable_checks: ["开篇已经明确谁拥有定性权以及主角下一步要验证什么", "兑现后至少一项资源、责任或关系发生不可逆变化"],
      failure_modes: ["证据缺少前置来源时会成为机械翻盘", "裁判规则从未生效时公开定性不会产生真实压力"],
      rewrite_usage: "保留原剧的误判原因、人物关系和主线结果，只检查开篇是否明确裁判权、验证目标和后续行动线。",
      original_usage: "先为新人物设计一套真实生效的裁判规则，再从人物已有能力和资源中生成可以逐步验证的原创证据链。",
      genre_adaptations: [{
        tags: ["现代言情", "商战", "大女主", "职场", "女频"],
        difference: "女频职场故事的回报重点是拿回职业成果、选择权和公开叙事权，而不是只让对手难堪。",
        usage_adjustment: "让每层证据分别改变团队署名、项目资源和关系责任，避免一次身份公开解决全部问题。",
        boundary_adjustment: "如果女主没有真实专业行动或组织规则不产生约束，公开反证会退化为身份打脸。"
      }],
      applicable_tags: ["现代言情", "商战", "大女主", "职场", "女频"],
      observation_refs: ["O01", "O03"],
      evidence_references: ["C0001", "C0003", "C0005"],
      catalog_decision: {
        action: "unresolved",
        target_id: "",
        reason: "本次没有提供可比较的历史公式候选短名单，需要后续检索后再判断。"
      },
      maturity: "single_case"
    }],
    no_formula_reason: "",
    principle_observations: [{
      observation_id: "P01",
      stages: ["trial_generate", "full_generate", "foreign_review"],
      statement: "当反转承担主要情绪回报时，应当让兑现改变人物后续可采取的行动、资源或关系，而不只改变现场评价。",
      relation: "proposes",
      rationale: "可见的状态变化能把前期压迫和后续剧情连接起来，也让观众判断回报是否真正完成。",
      applies_when: ["前期冲突已经具体限制人物行动或资源", "反转被用作阶段性或终局主要回报"],
      fails_or_changes_when: ["轻喜剧中的小型误会只承担节奏功能时可以使用较轻的评价变化", "故事有意保留失败后果时不应强求当场翻盘"],
      review_criteria: ["反转前后至少一项行动权限、资源分配或关系状态可以从文本中定位", "变化由此前可回溯的行动与证据触发"],
      related_formula_candidate_ids: ["F01"],
      evidence_references: ["C0001", "C0005", "C0006"],
      catalog_decision: {
        action: "unresolved",
        target_id: "",
        reason: "本次没有提供历史原则候选短名单，只记录单剧层面的原则观察。"
      },
      status: "candidate_only"
    }],
    no_principle_reason: "",
    quality_review: {
      full_source_read: true,
      facts_and_hypotheses_separated: true,
      formula_deidentified: true,
      principles_kept_as_candidates: true,
      known_unknowns: ["仅凭剧本文本不能证明实际播放数据或成片表演效果。"]
    }
  });
  await fs.writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { directory, source, output, initialized };
}

test("单剧蒸馏工具初始化、连续读取并通过完整校验", async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.directory, { recursive: true, force: true }));
  assert.equal(data.initialized.chunk_count, 6);
  const first = await readSourceChunks({ source: data.initialized.indexed_source, start: "1", count: "2" });
  const last = await readSourceChunks({ source: data.initialized.indexed_source, start: String(first.next_start), count: "8" });
  assert.equal(first.completed, false);
  assert.equal(last.completed, true);
  const result = await validateDistillation({ source: data.initialized.indexed_source, output: data.output });
  assert.equal(result.formula_candidates, 1);
  assert.equal(result.principle_observations, 1);
});

test("校验拒绝互相冲突的主要时代标签", async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.directory, { recursive: true, force: true }));
  const payload = JSON.parse(await fs.readFile(data.output, "utf8"));
  payload.tags.background = ["现代", "古代"];
  await fs.writeFile(data.output, JSON.stringify(payload), "utf8");
  await assert.rejects(
    () => validateDistillation({ source: data.initialized.indexed_source, output: data.output }),
    /背景不能同时包含多个主要时代/u
  );
});

test("校验拒绝把原作专名带入公式", async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.directory, { recursive: true, force: true }));
  const payload = JSON.parse(await fs.readFile(data.output, "utf8"));
  payload.formula_candidates[0].name = "林夏式公开反证";
  await fs.writeFile(data.output, JSON.stringify(payload), "utf8");
  await assert.rejects(
    () => validateDistillation({ source: data.initialized.indexed_source, output: data.output }),
    /仍包含原文专属词：林夏/u
  );
});
