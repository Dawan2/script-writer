# C-3　`npm run test:api` 输出与整合态说明

## 对照的整合态：既不是七项前置，也不是前六项

实现规格 1.2 要求写明本项实际对照的是哪个整合态。**开工时集成槽尚未把任何一项前置并入 `main`**，
`main` 仍是 `abb779e`，因此本项无法对照勘误 E-3 的 454 项 2 失败 0 错误。
本项按裁定 9.4 的判据"相对基线不新增失败项"执行，基线取本分支的改动前状态：

| 项 | 值 |
| --- | --- |
| 代码基线 | `main @ abb779e`（七项集成前置一项未并入） |
| 环境补齐 | `fastapi.testclient` 依赖 `httpx`，`requirements.txt` 未含。按 `6a68305` 的说明在本地环境安装，**不改仓内依赖文件**（那是集成槽与 `6a68305` 的动作） |
| 改动前基线 | **454 项 4 失败 8 错误** |
| 改动后 | **469 项 4 失败 8 错误**（新增的 15 项是本项的 `test_error_contract.py`） |
| 判定 | 失败项与错误项的名单逐条一致，未新增失败项 |

## 未并入前置带来的基线差异（与勘误 E-3 的 454 项 2 失败 0 错误相比）

| 差异 | 条数 | 由哪一项前置消除 | 是否本项范围 |
| --- | --- | --- | --- |
| `test_script_sync_service` 的 `utc_now_iso` NameError | 8 错误 | `6a68305` | 否 |
| `test_script_output_contracts` 的世界观 / 全稿夹具缺失 | 2 失败 | `dd10033`、`50f0ce4` | 否 |
| `test_script_output_contracts` 的执行策略夹具缺失 | 2 失败 | 无（归 `C1-W1-36`） | 否，规格 1.2 明确本项不得改动 |

## 改动前基线（失败与错误名单）

```
ERROR: test_sync_generates_uploads_and_cleans_up_cover_image (test_script_sync_service.ScriptSyncServiceTest.test_sync_generates_uploads_and_cleans_up_cover_image)
ERROR: test_sync_recreates_deleted_base_record (test_script_sync_service.ScriptSyncServiceTest.test_sync_recreates_deleted_base_record)
ERROR: test_sync_recreates_record_when_it_is_deleted_after_the_existence_check (test_script_sync_service.ScriptSyncServiceTest.test_sync_recreates_record_when_it_is_deleted_after_the_existence_check)
ERROR: test_sync_retries_title_lookup_until_created_record_is_visible (test_script_sync_service.ScriptSyncServiceTest.test_sync_retries_title_lookup_until_created_record_is_visible)
ERROR: test_sync_reuses_exactly_one_matching_title_record (test_script_sync_service.ScriptSyncServiceTest.test_sync_reuses_exactly_one_matching_title_record)
ERROR: test_sync_upserts_eligible_script_with_feishu_cli (test_script_sync_service.ScriptSyncServiceTest.test_sync_upserts_eligible_script_with_feishu_cli)
ERROR: test_sync_without_cover_mapping_does_not_generate_cover_image (test_script_sync_service.ScriptSyncServiceTest.test_sync_without_cover_mapping_does_not_generate_cover_image)
ERROR: test_sync_writes_automatic_data_source_to_single_select_field (test_script_sync_service.ScriptSyncServiceTest.test_sync_writes_automatic_data_source_to_single_select_field)
FAIL: test_full_generation_normalizes_legacy_trial_episode_headings (test_script_output_contracts.ScriptOutputContractsTest.test_full_generation_normalizes_legacy_trial_episode_headings)
FAIL: test_trial_and_full_checks_allow_optional_target_dialogue (test_script_output_contracts.ScriptOutputContractsTest.test_trial_and_full_checks_allow_optional_target_dialogue)
FAIL: test_trial_and_full_checks_enforce_the_default_duration_length_floor (test_script_output_contracts.ScriptOutputContractsTest.test_trial_and_full_checks_enforce_the_default_duration_length_floor)
FAIL: test_trial_initialization_uses_the_configured_episode_duration (test_script_output_contracts.ScriptOutputContractsTest.test_trial_initialization_uses_the_configured_episode_duration)
Ran 454 tests in 26.582s
FAILED (failures=4, errors=8)
```

## 改动后（失败与错误名单）

```
ERROR: test_sync_generates_uploads_and_cleans_up_cover_image (test_script_sync_service.ScriptSyncServiceTest.test_sync_generates_uploads_and_cleans_up_cover_image)
ERROR: test_sync_recreates_deleted_base_record (test_script_sync_service.ScriptSyncServiceTest.test_sync_recreates_deleted_base_record)
ERROR: test_sync_recreates_record_when_it_is_deleted_after_the_existence_check (test_script_sync_service.ScriptSyncServiceTest.test_sync_recreates_record_when_it_is_deleted_after_the_existence_check)
ERROR: test_sync_retries_title_lookup_until_created_record_is_visible (test_script_sync_service.ScriptSyncServiceTest.test_sync_retries_title_lookup_until_created_record_is_visible)
ERROR: test_sync_reuses_exactly_one_matching_title_record (test_script_sync_service.ScriptSyncServiceTest.test_sync_reuses_exactly_one_matching_title_record)
ERROR: test_sync_upserts_eligible_script_with_feishu_cli (test_script_sync_service.ScriptSyncServiceTest.test_sync_upserts_eligible_script_with_feishu_cli)
ERROR: test_sync_without_cover_mapping_does_not_generate_cover_image (test_script_sync_service.ScriptSyncServiceTest.test_sync_without_cover_mapping_does_not_generate_cover_image)
ERROR: test_sync_writes_automatic_data_source_to_single_select_field (test_script_sync_service.ScriptSyncServiceTest.test_sync_writes_automatic_data_source_to_single_select_field)
FAIL: test_full_generation_normalizes_legacy_trial_episode_headings (test_script_output_contracts.ScriptOutputContractsTest.test_full_generation_normalizes_legacy_trial_episode_headings)
FAIL: test_trial_and_full_checks_allow_optional_target_dialogue (test_script_output_contracts.ScriptOutputContractsTest.test_trial_and_full_checks_allow_optional_target_dialogue)
FAIL: test_trial_and_full_checks_enforce_the_default_duration_length_floor (test_script_output_contracts.ScriptOutputContractsTest.test_trial_and_full_checks_enforce_the_default_duration_length_floor)
FAIL: test_trial_initialization_uses_the_configured_episode_duration (test_script_output_contracts.ScriptOutputContractsTest.test_trial_initialization_uses_the_configured_episode_duration)
Ran 469 tests in 30.515s
FAILED (failures=4, errors=8)
```

## 本项新增用例单独执行

```
$ cd apps/api && .venv/bin/python -m unittest tests.test_error_contract
----------------------------------------------------------------------
Ran 15 tests in 3.053s

OK
```
