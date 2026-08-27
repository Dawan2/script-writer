from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.config import settings
from app.db.session import get_db
from app.dependencies import admin_feature_user
from app.services.admin_service import (
    bulk_admin_project_action,
    cancel_admin_job,
    dashboard_data,
    delete_admin_user,
    get_admin_user_or_404,
    list_admin_jobs,
    list_admin_projects,
    list_admin_users,
    list_audit_logs,
    purge_admin_project,
    restore_admin_project,
    retry_admin_job,
    trash_admin_project,
    update_admin_project,
    update_admin_user,
)
from app.services.agent_runner import public_job, run_agent_job
from app.services.audit_service import record_audit
from app.services.auth_service import create_user
from app.services.credit_service import (
    admin_credit_overview,
    record_credit_adjustment,
    set_user_credit_plan,
    update_stage_prices,
)
from app.services.region_admin_service import RegionRulesConfig, public_region_config, save_region_config
from app.services.role_service import (
    assign_legacy_role,
    can_manage_user_account,
    can_manage_role_definitions,
    create_role,
    delete_role,
    list_assignable_roles,
    list_role_management,
    replace_user_roles,
    update_role,
)
from app.services.script_sync_service import (
    ScriptSyncError,
    begin_script_sync_authorization,
    cleanup_sync_uploads,
    complete_script_sync_authorization,
    dispatch_script_sync_jobs,
    enqueue_script_sync_jobs,
    get_script_sync_config,
    ignore_project_sync,
    list_active_script_sync_jobs,
    list_script_sync_scripts,
    mark_project_sync_failed,
    save_script_sync_config,
    save_sync_uploads,
    sync_project_to_base,
    test_script_sync_target,
)
from app.services.script_library_service import (
    create_uploaded_script,
    delete_formula_card,
    delete_script,
    get_script,
    list_formula_cards,
    list_scripts,
    retry_distillation,
    search_source_chunks,
    update_script_metadata,
)
from app.services.notification_service import list_system_notifications, publish_system_notification
from app.services.model_config_service import (
    create_model_config,
    delete_model_config,
    list_model_management,
    test_model_config,
    update_function_model_route,
    update_function_model_routes,
    update_model_config,
)
from app.services.system_agent_evolution_service import (
    create_system_evolution_run,
    dismiss_system_evolution_run,
    ensure_evolution_analysis_runtime_log,
    evolution_analysis_runtime_log_path,
    get_system_evolution_run,
    list_all_user_preferences,
    list_system_evolution_runs,
    public_evolution_run,
    request_system_evolution_execution,
    retry_system_evolution_run,
    run_system_evolution_analysis,
    run_system_evolution_execution,
)
from app.services.writer_preference_service import (
    promote_writer_preferences_to_system,
    remove_system_writer_preferences,
)
from app.services.zdebug_manager import zdebug_manager


router = APIRouter(prefix="/admin", tags=["admin"])


class AdminUserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=40)
    display_name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=200)
    role: Literal["admin", "user"] = "user"
    role_ids: Optional[list[int]] = Field(default=None, max_length=30)

    @field_validator("username")
    @classmethod
    def validate_username(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized.replace("_", "").replace("-", "").isalnum():
            raise ValueError("用户名只能包含字母、数字、下划线和连字符")
        return normalized


class AdminUserUpdate(BaseModel):
    display_name: Optional[str] = Field(default=None, max_length=80)
    role: Optional[Literal["admin", "user"]] = None
    role_ids: Optional[list[int]] = Field(default=None, max_length=30)
    password: Optional[str] = Field(default=None, min_length=8, max_length=200)


class RoleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str = Field(default="", max_length=200)
    permission_keys: list[str] = Field(default_factory=list, max_length=30)


class RoleUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    description: Optional[str] = Field(default=None, max_length=200)
    permission_keys: Optional[list[str]] = Field(default=None, max_length=30)


class AgentEvolutionExecute(BaseModel):
    requirements: str = Field(min_length=1, max_length=4000)


class SystemWriterPreferenceBatch(BaseModel):
    preference_ids: list[int] = Field(min_length=1, max_length=100)

    @field_validator("preference_ids")
    @classmethod
    def validate_preference_ids(cls, value: list[int]) -> list[int]:
        if any(preference_id < 1 for preference_id in value):
            raise ValueError("偏好 ID 无效")
        return list(dict.fromkeys(value))


class AdminUserDelete(BaseModel):
    transfer_to_user_id: Optional[int] = None


class CreditPriceUpdate(BaseModel):
    prices: dict[str, int]


class CreditAdjustment(BaseModel):
    delta: int = Field(ge=-100_000, le=100_000)
    note: str = Field(default="", max_length=200)

    @field_validator("delta")
    @classmethod
    def validate_delta(cls, value: int) -> int:
        if value == 0:
            raise ValueError("调整额度不能为 0")
        return value


class CreditPlanUpdate(BaseModel):
    plan_code: Literal["free", "basic", "advanced"]


class RegionRulesUpdate(BaseModel):
    expected_hash: str = Field(min_length=64, max_length=64)
    config: RegionRulesConfig


class AdminProjectUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=160)
    owner_user_id: Optional[int] = None
    target_region: Optional[str] = Field(default=None, max_length=40)


class AdminProjectBulkAction(BaseModel):
    action: Literal["archive", "trash"]
    project_ids: list[int] = Field(min_length=1, max_length=100)

    @field_validator("project_ids")
    @classmethod
    def validate_project_ids(cls, value: list[int]) -> list[int]:
        if any(project_id < 1 for project_id in value):
            raise ValueError("项目 ID 无效")
        return list(dict.fromkeys(value))


class SystemNotificationCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=5000)

    @field_validator("title", "message")
    @classmethod
    def validate_content(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("通知内容不能为空")
        return normalized


class ScriptSyncFieldMapping(BaseModel):
    source_key: str = Field(min_length=1, max_length=80)
    target_field_id: Optional[str] = Field(default=None, max_length=120)
    auto_create: bool = False


class ScriptSyncConfigUpdate(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    mappings: list[ScriptSyncFieldMapping] = Field(default_factory=list, max_length=20)


class ScriptSyncTargetTest(BaseModel):
    url: str = Field(min_length=8, max_length=2000)


class ScriptSyncExportFailure(BaseModel):
    message: str = Field(min_length=1, max_length=1000)


class ScriptSyncJobCreate(BaseModel):
    project_ids: list[int] = Field(min_length=1, max_length=100)

    @field_validator("project_ids")
    @classmethod
    def validate_project_ids(cls, value: list[int]) -> list[int]:
        if any(project_id < 1 for project_id in value):
            raise ValueError("剧本 ID 无效")
        return list(dict.fromkeys(value))


class ScriptLibraryTags(BaseModel):
    theme: list[str] = Field(default_factory=list, max_length=8)
    setting: list[str] = Field(default_factory=list, max_length=8)
    background: list[str] = Field(default_factory=list, max_length=8)
    audience: list[str] = Field(default_factory=list, max_length=8)


class ScriptLibraryMetadataUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=160)
    tags: Optional[ScriptLibraryTags] = None


class ModelConfigPayload(BaseModel):
    model_config = ConfigDict(protected_namespaces=())


class ModelConfigCreate(ModelConfigPayload):
    name: str = Field(min_length=1, max_length=80)
    model_type: Literal["claude_code", "image"]
    request_url: str = Field(default="", max_length=2000)
    api_key: str = Field(default="", max_length=4000)
    model_name: str = Field(default="", max_length=200)
    api_protocol: Literal["anthropic", "openai"] = "anthropic"
    thinking_level: Literal["low", "medium", "high", "xhigh", "max"] = "medium"
    image_size: str = Field(default="", max_length=80)
    image_output_format: Literal["png", "jpeg", "webp"] = "png"
    image_watermark: bool = False
    fallback_model_id: Optional[int] = Field(default=None, ge=1)
    is_enabled: bool = True


class ModelConfigUpdate(ModelConfigPayload):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    model_type: Optional[Literal["claude_code", "image"]] = None
    request_url: Optional[str] = Field(default=None, max_length=2000)
    api_key: Optional[str] = Field(default=None, max_length=4000)
    model_name: Optional[str] = Field(default=None, max_length=200)
    api_protocol: Optional[Literal["anthropic", "openai"]] = None
    thinking_level: Optional[Literal["low", "medium", "high", "xhigh", "max"]] = None
    image_size: Optional[str] = Field(default=None, max_length=80)
    image_output_format: Optional[Literal["png", "jpeg", "webp"]] = None
    image_watermark: Optional[bool] = None
    fallback_model_id: Optional[int] = Field(default=None, ge=1)
    is_enabled: Optional[bool] = None


class FunctionModelRouteUpdate(ModelConfigPayload):
    model_config_id: int = Field(ge=1)


class FunctionModelRouteKey(BaseModel):
    scenario_key: str = Field(min_length=1, max_length=80)
    action_key: str = Field(min_length=1, max_length=80)


class FunctionModelRouteBulkUpdate(ModelConfigPayload):
    model_config_id: int = Field(ge=1)
    route_keys: list[FunctionModelRouteKey] = Field(min_length=1, max_length=100)


def _project_or_404(conn: sqlite3.Connection, project_id: int) -> sqlite3.Row:
    project = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return project


@router.get("/dashboard")
def get_dashboard(
    period: Literal["today", "yesterday", "7d", "30d", "custom"] = "30d",
    operator_user_id: Optional[int] = None,
    task_type: Optional[Literal["rewrite", "novel", "replicate", "review", "translate", "humanize"]] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("dashboard")),
) -> dict:
    return dashboard_data(
        conn,
        period=period,
        operator_user_id=operator_user_id,
        task_type=task_type,
        start_date=start_date,
        end_date=end_date,
    )


@router.get("/users")
def get_users(
    query: Optional[str] = None,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("users")),
) -> dict:
    users = list_admin_users(conn, query)
    return {
        "users": [user for user in users if can_manage_user_account(conn, actor, user)],
        "assignable_roles": list_assignable_roles(conn, actor),
    }


@router.get("/role-management")
def get_role_management(
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("roles")),
) -> dict:
    return list_role_management(conn)


@router.post("/role-management/roles", status_code=status.HTTP_201_CREATED)
def post_role(
    payload: RoleCreate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("roles")),
) -> dict:
    return {
        "role": create_role(
            conn,
            actor=actor,
            name=payload.name,
            description=payload.description,
            permission_keys=payload.permission_keys,
        )
    }


@router.put("/role-management/roles/{role_id}")
def put_role(
    role_id: int,
    payload: RoleUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("roles")),
) -> dict:
    return {
        "role": update_role(
            conn,
            actor=actor,
            role_id=role_id,
            name=payload.name,
            description=payload.description,
            permission_keys=payload.permission_keys,
        )
    }


@router.delete("/role-management/roles/{role_id}")
def delete_role_configuration(
    role_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("roles")),
) -> dict:
    delete_role(conn, actor=actor, role_id=role_id)
    return {"ok": True}


@router.get("/system-notifications")
def get_system_notifications(
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("notifications")),
) -> dict:
    return {"notifications": list_system_notifications(conn)}


@router.post("/system-notifications", status_code=status.HTTP_201_CREATED)
def post_system_notification(
    payload: SystemNotificationCreate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("notifications")),
) -> dict:
    notification = publish_system_notification(
        conn,
        title=payload.title,
        message=payload.message,
        created_by=actor["id"],
    )
    record_audit(
        conn,
        actor=actor,
        action="system_notification.publish",
        target_type="system_notification",
        target_id=notification["id"],
        target_label=notification["title"],
        details={"recipient_count": notification["recipient_count"]},
    )
    return {"notification": notification}


@router.post("/users", status_code=status.HTTP_201_CREATED)
def post_user(
    payload: AdminUserCreate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("users")),
) -> dict:
    try:
        user = create_user(
            conn,
            username=payload.username,
            password=payload.password,
            display_name=payload.display_name.strip(),
            role="user",
        )
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="用户名已存在") from exc
    target = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户创建失败")
    if payload.role_ids is not None:
        replace_user_roles(
            conn,
            actor=actor,
            target=target,
            role_ids=payload.role_ids,
            # Explicit selections replace the compatibility default role.
            preserve_unassignable_existing=False,
        )
    elif payload.role == "admin":
        assign_legacy_role(conn, actor=actor, target=target, role="admin")
    elif not can_manage_role_definitions(conn, actor):
        # Do not grant a default role outside a limited manager's scope.
        replace_user_roles(
            conn,
            actor=actor,
            target=target,
            role_ids=[],
            preserve_unassignable_existing=False,
        )
    record_audit(
        conn,
        actor=actor,
        action="user.create",
        target_type="user",
        target_id=user["id"],
        target_label=user["username"],
        details={"display_name": user["display_name"], "role_ids": payload.role_ids or []},
    )
    created = next(item for item in list_admin_users(conn) if item["id"] == user["id"])
    return {"user": created}


@router.patch("/users/{user_id}")
def patch_user(
    user_id: int,
    payload: AdminUserUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("users")),
) -> dict:
    target = get_admin_user_or_404(conn, user_id)
    return {
        "user": update_admin_user(
            conn,
            actor=actor,
            target=target,
            display_name=payload.display_name,
            role=payload.role,
            role_ids=payload.role_ids,
            password=payload.password,
        )
    }


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    payload: AdminUserDelete,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("users")),
) -> dict:
    target = get_admin_user_or_404(conn, user_id)
    return delete_admin_user(
        conn,
        actor=actor,
        target=target,
        transfer_to_user_id=payload.transfer_to_user_id,
    )


@router.get("/credits")
def get_credits(
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("credits")),
) -> dict:
    return admin_credit_overview(conn)


@router.put("/credits/prices")
def put_credit_prices(
    payload: CreditPriceUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("credits")),
) -> dict:
    prices = update_stage_prices(conn, prices=payload.prices)
    record_audit(
        conn,
        actor=actor,
        action="credits.prices.update",
        target_type="credit_prices",
        target_label="阶段额度",
        details={"prices": payload.prices},
    )
    return {"prices": prices}


@router.post("/credits/users/{user_id}/adjust")
def post_credit_adjustment(
    user_id: int,
    payload: CreditAdjustment,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("credits")),
) -> dict:
    target = get_admin_user_or_404(conn, user_id)
    note = payload.note.strip() or ("手工发放创作额度" if payload.delta > 0 else "手工扣减创作额度")
    account = record_credit_adjustment(
        conn,
        user_id=int(target["id"]),
        delta=payload.delta,
        note=note,
    )
    record_audit(
        conn,
        actor=actor,
        action="credits.adjust",
        target_type="user",
        target_id=target["id"],
        target_label=target["username"],
        details={"delta": payload.delta, "balance": account["balance"], "note": note},
    )
    return {"account": {"user_id": target["id"], **account}}


@router.put("/credits/users/{user_id}/plan")
def put_user_credit_plan(
    user_id: int,
    payload: CreditPlanUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("credits")),
) -> dict:
    target = get_admin_user_or_404(conn, user_id)
    account = set_user_credit_plan(
        conn,
        user_id=int(target["id"]),
        plan_code=payload.plan_code,
        granted_by=int(actor["id"]),
    )
    record_audit(
        conn,
        actor=actor,
        action="credits.plan.update",
        target_type="user",
        target_id=target["id"],
        target_label=target["username"],
        details={
            "plan_code": payload.plan_code,
            "balance": account["balance"],
            "initial_credits": account["plan_grant"]["granted_credits"] if account["initial_granted"] else 0,
            "automatic_grant": account["initial_granted"],
            "expires_at": account["plan_term"]["expires_at"],
        },
    )
    return {"account": account}
@router.get("/regions")
def get_regions(
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("regions")),
) -> dict:
    return public_region_config(conn)


@router.put("/regions")
def put_regions(
    payload: RegionRulesUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("regions")),
) -> dict:
    return save_region_config(conn, actor=actor, config=payload.config, expected_hash=payload.expected_hash)


@router.get("/model-management")
def get_model_management(
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("models")),
) -> dict:
    return list_model_management(conn)


@router.post("/model-management/models", status_code=status.HTTP_201_CREATED)
def post_model_configuration(
    payload: ModelConfigCreate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("models")),
) -> dict:
    return {"model": create_model_config(conn, actor=actor, payload=payload.model_dump())}


@router.put("/model-management/models/{model_id}")
def put_model_configuration(
    model_id: int,
    payload: ModelConfigUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("models")),
) -> dict:
    return {"model": update_model_config(conn, actor=actor, model_id=model_id, payload=payload.model_dump(exclude_unset=True))}


@router.delete("/model-management/models/{model_id}")
def delete_model_configuration(
    model_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("models")),
) -> dict:
    delete_model_config(conn, actor=actor, model_id=model_id)
    return {"ok": True}


@router.post("/model-management/models/{model_id}/test")
def post_model_configuration_test(
    model_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("models")),
) -> dict:
    return {"result": test_model_config(conn, actor=actor, model_id=model_id)}


@router.put("/model-management/routes/{scenario_key}/{action_key}")
def put_function_model_route(
    scenario_key: str,
    action_key: str,
    payload: FunctionModelRouteUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("models")),
) -> dict:
    return {
        "route": update_function_model_route(
            conn,
            actor=actor,
            scenario_key=scenario_key,
            action_key=action_key,
            model_config_id=payload.model_config_id,
        )
    }


@router.put("/model-management/routes/batch")
def put_function_model_routes(
    payload: FunctionModelRouteBulkUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("models")),
) -> dict:
    return update_function_model_routes(
        conn,
        actor=actor,
        route_keys=[route_key.model_dump() for route_key in payload.route_keys],
        model_config_id=payload.model_config_id,
    )


@router.get("/projects")
def get_projects(
    query: Optional[str] = None,
    lifecycle: Literal["all", "active", "completed", "trash"] = "all",
    task_type: Optional[Literal["rewrite", "novel", "replicate", "review", "translate", "humanize"]] = None,
    region: Optional[str] = None,
    owner_user_id: Optional[int] = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("projects")),
) -> dict:
    return list_admin_projects(
        conn,
        query=query,
        lifecycle=lifecycle,
        task_type=task_type,
        region=region,
        owner_user_id=owner_user_id,
        page=page,
        page_size=page_size,
    )


@router.post("/projects/bulk-actions")
def post_project_bulk_action(
    payload: AdminProjectBulkAction,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("projects")),
) -> dict:
    return bulk_admin_project_action(
        conn,
        actor=actor,
        action=payload.action,
        project_ids=payload.project_ids,
    )


@router.patch("/projects/{project_id}")
def patch_project(
    project_id: int,
    payload: AdminProjectUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("projects")),
) -> dict:
    project = _project_or_404(conn, project_id)
    return {
        "project": update_admin_project(
            conn,
            actor=actor,
            project=project,
            name=payload.name,
            owner_user_id=payload.owner_user_id,
            target_region=payload.target_region,
        )
    }


@router.delete("/projects/{project_id}")
def delete_project(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("projects")),
) -> dict:
    project = _project_or_404(conn, project_id)
    trash_admin_project(conn, actor=actor, project=project)
    return {"ok": True}


@router.post("/projects/{project_id}/restore")
def post_restore_project(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("projects")),
) -> dict:
    project = _project_or_404(conn, project_id)
    if not project["deleted_at"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目不在回收站中")
    return {"project": restore_admin_project(conn, actor=actor, project=project)}


@router.delete("/projects/{project_id}/permanent")
def delete_project_permanently(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("projects")),
) -> dict:
    project = _project_or_404(conn, project_id)
    if not project["deleted_at"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="只能彻底删除回收站中的项目")
    purge_admin_project(conn, actor=actor, project=project)
    return {"ok": True}


@router.get("/script-sync/config")
def get_script_sync_configuration(
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("script_sync")),
) -> dict:
    return get_script_sync_config(conn)


@router.post("/script-sync/config/test")
def post_script_sync_target_test(
    payload: ScriptSyncTargetTest,
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("script_sync")),
) -> dict:
    return test_script_sync_target(conn, url=payload.url)


@router.post("/script-sync/config/authorization")
def post_script_sync_authorization(
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("script_sync")),
) -> dict:
    try:
        return {"authorization_url": begin_script_sync_authorization(conn)}
    except ScriptSyncError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post("/script-sync/config/authorization/complete")
def post_complete_script_sync_authorization(
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("script_sync")),
) -> dict:
    try:
        return complete_script_sync_authorization(conn)
    except ScriptSyncError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.put("/script-sync/config")
def put_script_sync_configuration(
    payload: ScriptSyncConfigUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("script_sync")),
) -> dict:
    try:
        return save_script_sync_config(
            conn,
            actor=actor,
            url=payload.url,
            mappings=[item.model_dump() for item in payload.mappings],
        )
    except ScriptSyncError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.get("/script-sync/scripts")
def get_script_sync_scripts(
    query: Optional[str] = Query(default=None, max_length=160),
    scenario: Optional[Literal["rewrite", "novel", "replicate"]] = None,
    operator: Optional[str] = Query(default=None, max_length=80),
    sync_status: Optional[str] = Query(default=None, max_length=120),
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("script_sync")),
) -> dict:
    statuses = {item.strip() for item in (sync_status or "").split(",") if item.strip()}
    allowed_statuses = {"pending", "synced", "needs_update", "failed", "ignored"}
    if not statuses:
        statuses = set()
    elif not statuses.issubset(allowed_statuses):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="同步状态筛选无效")
    return list_script_sync_scripts(
        conn,
        query=query,
        scenario=scenario,
        operator=operator,
        sync_statuses=statuses,
    )


@router.get("/script-sync/jobs/active")
def get_active_script_sync_jobs(
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("script_sync")),
) -> dict:
    return list_active_script_sync_jobs(conn)


@router.post("/script-sync/jobs", status_code=status.HTTP_202_ACCEPTED)
def post_script_sync_jobs(
    payload: ScriptSyncJobCreate,
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("script_sync")),
) -> dict:
    try:
        result = enqueue_script_sync_jobs(conn, actor=actor, project_ids=payload.project_ids)
    except ScriptSyncError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    background_tasks.add_task(dispatch_script_sync_jobs)
    return result


@router.post("/script-sync/scripts/{project_id}/ignore")
def post_ignore_script_sync_project(
    project_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("script_sync")),
) -> dict:
    try:
        return {"sync": ignore_project_sync(conn, actor=actor, project_id=project_id)}
    except ScriptSyncError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post("/script-sync/scripts/{project_id}/sync")
def post_script_sync_project(
    project_id: int,
    files: list[UploadFile] = File(default=[]),
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("script_sync")),
) -> dict:
    upload_items = [
        (Path(file.filename or "").stem, file.file, file.filename or "")
        for file in files
        if file.filename
    ]
    directory, attachments = save_sync_uploads(upload_items)
    try:
        return {"sync": sync_project_to_base(conn, actor=actor, project_id=project_id, attachments=attachments)}
    except ScriptSyncError as exc:
        # 飞书已经可能创建了记录；保留失败状态，供列表展示原因并支持后续重试。
        conn.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    finally:
        cleanup_sync_uploads(directory)


@router.post("/script-sync/scripts/{project_id}/export-failed")
def post_script_sync_export_failed(
    project_id: int,
    payload: ScriptSyncExportFailure,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("script_sync")),
) -> dict:
    mark_project_sync_failed(conn, actor=actor, project_id=project_id, message=payload.message.strip())
    return {"ok": True}


@router.get("/script-library/scripts")
def get_script_library_scripts(
    query: str = "",
    script_status: Optional[Literal["queued", "processing", "ready", "failed"]] = None,
    theme: str = "",
    setting: str = "",
    background: str = "",
    audience: str = "",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=30, ge=1, le=100),
    include_legacy: bool = Query(default=False),
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("distillation")),
) -> dict:
    return list_scripts(
        conn,
        query=query,
        script_status=script_status or "",
        theme=theme,
        setting=setting,
        background=background,
        audience=audience,
        page=page,
        page_size=page_size,
        include_legacy=include_legacy,
    )


@router.get("/script-library/scripts/{script_id}")
def get_script_library_script(
    script_id: int,
    include_legacy: bool = Query(default=False),
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("distillation")),
) -> dict:
    return {"script": get_script(conn, script_id, include_legacy=include_legacy)}


@router.get("/script-library/scripts/{script_id}/source")
def get_script_library_source(
    script_id: int,
    query: str = "",
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("distillation")),
) -> dict:
    return search_source_chunks(conn, script_id=script_id, query=query)


@router.post("/script-library/scripts", status_code=status.HTTP_202_ACCEPTED)
def post_script_library_scripts(
    files: list[UploadFile] = File(...),
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("distillation")),
) -> dict:
    if not files or len(files) > 20:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="每次请上传 1-20 个剧本")
    created = []
    rejected = []
    for file in files:
        try:
            created.append(create_uploaded_script(conn, actor=actor, upload=file))
        except HTTPException as exc:
            rejected.append({"filename": file.filename or "未命名文件", "message": str(exc.detail)})
        except Exception as exc:
            rejected.append({"filename": file.filename or "未命名文件", "message": str(exc) or "文件处理失败"})
    return {
        "scripts": [item["script"] for item in created],
        "job_ids": [item["job_id"] for item in created],
        "rejected": rejected,
    }


@router.patch("/script-library/scripts/{script_id}")
def patch_script_library_script(
    script_id: int,
    payload: ScriptLibraryMetadataUpdate,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("distillation")),
) -> dict:
    tags = payload.tags.model_dump() if payload.tags is not None else None
    return {"script": update_script_metadata(conn, actor=actor, script_id=script_id, title=payload.title, tags=tags)}


@router.delete("/script-library/scripts/{script_id}")
def delete_script_library_script(
    script_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("distillation")),
) -> dict:
    delete_script(conn, actor=actor, script_id=script_id)
    return {"ok": True}


@router.post("/script-library/scripts/{script_id}/retry", status_code=status.HTTP_202_ACCEPTED)
def post_script_library_retry(
    script_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("distillation")),
) -> dict:
    result = retry_distillation(conn, actor=actor, script_id=script_id)
    return result


@router.get("/script-library/formulas")
def get_script_library_formulas(
    formula_type: Optional[Literal[
        "story_engine", "world_rule", "character_relationship", "long_arc",
        "episode_structure", "hook_information", "audience_payoff",
        "emotional_progression", "scene_conflict", "dialogue_action",
    ]] = None,
    card_kind: Optional[Literal["formula", "principle"]] = None,
    stage: Optional[Literal[
        "global", "novel_analysis", "world_view", "outline_rewrite",
        "character_rewrite", "trial_generate", "full_generate",
        "dialogue_translate", "foreign_review",
    ]] = None,
    verification_status: Optional[Literal["candidate", "active"]] = None,
    query: str = "",
    theme: str = "",
    setting: str = "",
    background: str = "",
    audience: str = "",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=30, ge=1, le=100),
    include_legacy: bool = Query(default=False),
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("distillation")),
) -> dict:
    return list_formula_cards(
        conn,
        formula_type=formula_type or "",
        card_kind=card_kind or "",
        stage=stage or "",
        verification_status=verification_status or "",
        query=query,
        theme=theme,
        setting=setting,
        background=background,
        audience=audience,
        page=page,
        page_size=page_size,
        include_legacy=include_legacy,
    )


@router.delete("/script-library/formulas/{formula_id}")
def delete_script_library_formula(
    formula_id: str,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("distillation")),
) -> dict:
    delete_formula_card(conn, actor=actor, formula_id=formula_id)
    return {"ok": True}


@router.get("/jobs")
def get_jobs(
    query: Optional[str] = None,
    job_status: Optional[Literal["queued", "running", "succeeded", "failed", "canceled"]] = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("jobs")),
) -> dict:
    return list_admin_jobs(conn, query=query, job_status=job_status, page=page, page_size=page_size)


@router.post("/jobs/{job_id}/cancel")
def post_cancel_job(
    job_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("jobs")),
) -> dict:
    return {"job": cancel_admin_job(conn, actor=actor, job_id=job_id)}


@router.post("/jobs/{job_id}/retry", status_code=status.HTTP_201_CREATED)
def post_retry_job(
    job_id: int,
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("jobs")),
) -> dict:
    job = retry_admin_job(conn, actor=actor, job_id=job_id)
    conn.commit()
    background_tasks.add_task(run_agent_job, job["id"])
    return {"job": public_job(job)}


@router.get("/audit-logs")
def get_audit_logs(
    query: Optional[str] = None,
    action: Optional[str] = None,
    project_id: Optional[int] = Query(default=None, ge=1),
    outcome: Optional[Literal["success", "failure", "denied"]] = None,
    source: Optional[Literal["web", "api", "system"]] = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=30, ge=1, le=100),
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("audit")),
) -> dict:
    return list_audit_logs(
        conn,
        query=query,
        action=action,
        project_id=project_id,
        outcome=outcome,
        source=source,
        page=page,
        page_size=page_size,
    )


@router.get("/agent-evolution")
def get_agent_evolution(
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("evolution")),
) -> dict:
    return {
        "runs": list_system_evolution_runs(conn),
        "preferences": list_all_user_preferences(conn),
    }


@router.post("/agent-evolution/preferences/system")
def post_system_writer_preferences(
    payload: SystemWriterPreferenceBatch,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("evolution")),
) -> dict:
    result = promote_writer_preferences_to_system(conn, preference_ids=payload.preference_ids)
    record_audit(
        conn,
        actor=actor,
        action="writer_preference.system_default.enable",
        target_type="system_writer_preference",
        target_label="系统偏好",
        details={"source_preference_ids": payload.preference_ids, **result},
    )
    return {**result, "preferences": list_all_user_preferences(conn)}


@router.delete("/agent-evolution/preferences/system")
def delete_system_writer_preferences(
    payload: SystemWriterPreferenceBatch,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("evolution")),
) -> dict:
    result = remove_system_writer_preferences(conn, system_preference_ids=payload.preference_ids)
    record_audit(
        conn,
        actor=actor,
        action="writer_preference.system_default.disable",
        target_type="system_writer_preference",
        target_label="系统偏好",
        details=result,
        severity="warning",
    )
    return {**result, "preferences": list_all_user_preferences(conn)}


@router.get("/agent-evolution/runs/{run_id}")
def get_agent_evolution_run_detail(
    run_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("evolution")),
) -> dict:
    return {"run": public_evolution_run(get_system_evolution_run(conn, run_id), include_report=True)}


@router.post("/agent-evolution/runs", status_code=status.HTTP_201_CREATED)
def post_agent_evolution_run(
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("evolution")),
) -> dict:
    run = create_system_evolution_run(conn, actor=actor)
    conn.commit()
    background_tasks.add_task(run_system_evolution_analysis, int(run["id"]))
    return {"run": public_evolution_run(run)}


@router.post("/agent-evolution/runs/{run_id}/retry", status_code=status.HTTP_202_ACCEPTED)
def post_agent_evolution_run_retry(
    run_id: int,
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("evolution")),
) -> dict:
    run = get_system_evolution_run(conn, run_id)
    updated = retry_system_evolution_run(conn, run=run, actor=actor)
    conn.commit()
    background_tasks.add_task(run_system_evolution_analysis, run_id)
    return {"run": public_evolution_run(updated)}


@router.post("/agent-evolution/runs/{run_id}/debug")
def post_agent_evolution_run_debug(
    run_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    _actor=Depends(admin_feature_user("evolution")),
) -> dict:
    run = get_system_evolution_run(conn, run_id)
    runtime_log_path = evolution_analysis_runtime_log_path(run_id)
    live = run["status"] in {"queued", "analyzing"}
    if not live:
        runtime_log_path = ensure_evolution_analysis_runtime_log(run)
    service = zdebug_manager.start_for_evolution_run(
        run_id=run_id,
        project_path=settings.agents_dir,
        runtime_log_path=runtime_log_path,
        modified_at=run["analysis_started_at"] or run["created_at"],
        live=live,
    )
    record_audit(
        conn,
        actor=_actor,
        action="agent_evolution.debug.start",
        target_type="system_agent_evolution",
        target_id=run_id,
        target_label=f"进化分析 #{run_id}",
        details={"reused": bool(service.get("reused")), "live": live},
    )
    return {"debug": service}


@router.post("/agent-evolution/runs/{run_id}/dismiss")
def post_agent_evolution_run_dismiss(
    run_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("evolution")),
) -> dict:
    run = get_system_evolution_run(conn, run_id)
    updated = dismiss_system_evolution_run(conn, run=run, actor=actor)
    return {"run": public_evolution_run(updated)}


@router.post("/agent-evolution/runs/{run_id}/execute")
def post_agent_evolution_run_execute(
    run_id: int,
    payload: AgentEvolutionExecute,
    background_tasks: BackgroundTasks,
    conn: sqlite3.Connection = Depends(get_db),
    actor=Depends(admin_feature_user("evolution")),
) -> dict:
    run = get_system_evolution_run(conn, run_id)
    updated = request_system_evolution_execution(
        conn,
        run=run,
        actor=actor,
        requirements=payload.requirements,
    )
    conn.commit()
    background_tasks.add_task(run_system_evolution_execution, int(run["id"]))
    return {"run": public_evolution_run(updated)}
