import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.db import session
from app.routers.admin import AdminUserCreate, get_users, post_user
from app.services.auth_service import create_user, get_user_by_username
from app.services.admin_service import update_admin_user
from app.services.credit_service import credit_summary
from app.services.role_service import (
    ALL_PERMISSION_KEYS,
    ROLE_CODE_DEFAULT_CREATOR,
    ROLE_CODE_SYSTEM_ADMIN,
    admin_permission_key,
    create_role,
    ensure_role_defaults,
    list_assignable_roles,
    permission_keys_for_user,
    replace_user_roles,
    roles_for_user_ids,
    scenario_permission_key,
    update_role,
)


class RoleManagementTest(unittest.TestCase):
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
        self.patch = patch.object(session, "settings", self.settings)
        self.patch.start()
        session.init_db()
        self.conn = session.get_connection()
        create_user(self.conn, username="admin", password="admin-password", display_name="系统管理员", role="admin")
        create_user(self.conn, username="author", password="author-password", display_name="创作者")
        self.admin = get_user_by_username(self.conn, "admin")
        self.author = get_user_by_username(self.conn, "author")
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.patch.stop()
        self.temp_dir.cleanup()

    def test_legacy_accounts_receive_compatible_builtin_roles(self):
        admin_permissions = permission_keys_for_user(self.conn, self.admin)
        author_permissions = permission_keys_for_user(self.conn, self.author)
        roles = roles_for_user_ids(self.conn, [self.admin["id"], self.author["id"]])

        self.assertEqual(admin_permissions, ALL_PERMISSION_KEYS)
        self.assertIn(scenario_permission_key("rewrite"), author_permissions)
        self.assertIn(scenario_permission_key("replicate"), admin_permissions)
        self.assertNotIn(admin_permission_key("users"), author_permissions)
        self.assertEqual(roles[self.admin["id"]][0]["code"], ROLE_CODE_SYSTEM_ADMIN)

    def test_custom_role_changes_take_effect_on_next_permission_lookup(self):
        role = create_role(
            self.conn,
            actor=self.admin,
            name="任务运营",
            permission_keys=[scenario_permission_key("rewrite"), "batch_tasks"],
        )
        replace_user_roles(self.conn, actor=self.admin, target=self.author, role_ids=[role["id"]])

        self.assertEqual(
            permission_keys_for_user(self.conn, self.author),
            frozenset({scenario_permission_key("rewrite"), "batch_tasks"}),
        )

        update_role(
            self.conn,
            actor=self.admin,
            role_id=role["id"],
            permission_keys=[scenario_permission_key("novel")],
        )

        self.assertEqual(permission_keys_for_user(self.conn, self.author), frozenset({scenario_permission_key("novel")}))

    def test_default_creator_permissions_can_be_configured_and_survive_default_initialization(self):
        creator_role = self.conn.execute(
            "SELECT * FROM roles WHERE code = ?", (ROLE_CODE_DEFAULT_CREATOR,)
        ).fetchone()
        self.assertIsNotNone(creator_role)

        configured_permissions = [
            scenario_permission_key("rewrite"),
            "batch_tasks",
            admin_permission_key("projects"),
        ]
        updated = update_role(
            self.conn,
            actor=self.admin,
            role_id=int(creator_role["id"]),
            permission_keys=configured_permissions,
        )

        self.assertTrue(creator_role["is_system"])
        self.assertEqual(set(updated["permission_keys"]), set(configured_permissions))
        ensure_role_defaults(self.conn)
        self.assertEqual(permission_keys_for_user(self.conn, self.author), frozenset(configured_permissions))

        update_role(
            self.conn,
            actor=self.admin,
            role_id=int(creator_role["id"]),
            permission_keys=[],
        )
        ensure_role_defaults(self.conn)
        self.assertEqual(permission_keys_for_user(self.conn, self.author), frozenset())

    def test_default_creator_name_and_description_remain_fixed(self):
        creator_role = self.conn.execute(
            "SELECT * FROM roles WHERE code = ?", (ROLE_CODE_DEFAULT_CREATOR,)
        ).fetchone()
        with self.assertRaises(HTTPException) as context:
            update_role(
                self.conn,
                actor=self.admin,
                role_id=int(creator_role["id"]),
                name="内容创作者",
            )
        self.assertEqual(context.exception.status_code, 409)

    def test_limited_user_manager_only_sees_and_assigns_safe_custom_roles(self):
        manager_role = create_role(
            self.conn,
            actor=self.admin,
            name="用户协调员",
            permission_keys=[admin_permission_key("users"), scenario_permission_key("rewrite")],
        )
        model_role = create_role(
            self.conn,
            actor=self.admin,
            name="模型管理员",
            permission_keys=[admin_permission_key("models")],
        )
        create_user(self.conn, username="manager", password="manager-password", display_name="协调员")
        manager = get_user_by_username(self.conn, "manager")
        replace_user_roles(self.conn, actor=self.admin, target=manager, role_ids=[manager_role["id"]])

        assignable_ids = {role["id"] for role in list_assignable_roles(self.conn, manager)}
        self.assertEqual(assignable_ids, {manager_role["id"]})

        replace_user_roles(self.conn, actor=manager, target=self.author, role_ids=[manager_role["id"]])
        author_role_ids = {role["id"] for role in roles_for_user_ids(self.conn, [self.author["id"]])[self.author["id"]]}
        self.assertIn(manager_role["id"], author_role_ids)

        with self.assertRaises(HTTPException) as context:
            replace_user_roles(self.conn, actor=manager, target=self.author, role_ids=[model_role["id"]])
        self.assertEqual(context.exception.status_code, 403)

    def test_limited_user_manager_does_not_keep_default_role_on_new_user(self):
        manager_role = create_role(
            self.conn,
            actor=self.admin,
            name="受限用户管理员",
            permission_keys=[admin_permission_key("users"), scenario_permission_key("rewrite")],
        )
        writer_role = create_role(
            self.conn,
            actor=self.admin,
            name="改写专员",
            permission_keys=[scenario_permission_key("rewrite")],
        )
        create_user(self.conn, username="limited-manager", password="manager-password", display_name="受限管理员")
        manager = get_user_by_username(self.conn, "limited-manager")
        replace_user_roles(self.conn, actor=self.admin, target=manager, role_ids=[manager_role["id"]])

        result = post_user(
            AdminUserCreate(
                username="rewrite-writer",
                display_name="改写创作者",
                password="writer-password",
                role_ids=[writer_role["id"]],
            ),
            conn=self.conn,
            actor=manager,
        )
        writer = get_user_by_username(self.conn, "rewrite-writer")

        self.assertEqual(result["user"]["id"], writer["id"])
        self.assertEqual(permission_keys_for_user(self.conn, writer), frozenset({scenario_permission_key("rewrite")}))

    def test_new_admin_user_receives_free_plan_credits(self):
        result = post_user(
            AdminUserCreate(
                username="trial-writer",
                display_name="体验创作者",
                password="writer-password",
            ),
            conn=self.conn,
            actor=self.admin,
        )

        summary = credit_summary(self.conn, user_id=int(result["user"]["id"]))

        self.assertEqual(summary["balance"], 55)
        self.assertEqual(summary["balances"], {"experience": 55, "supplemental": 0, "plan": 0})
        self.assertEqual(summary["plan"]["code"], "free")
        self.assertTrue(summary["plan_grant"]["granted"])
        self.assertEqual(summary["plan_grant"]["granted_credits"], 55)
        self.assertEqual(summary["transactions"][0]["note"], "体验套餐 · 体验套餐额度")

    def test_limited_user_manager_cannot_reset_higher_privilege_user_password(self):
        manager_role = create_role(
            self.conn,
            actor=self.admin,
            name="受限密码管理员",
            permission_keys=[admin_permission_key("users"), scenario_permission_key("rewrite")],
        )
        create_user(self.conn, username="password-manager", password="manager-password", display_name="密码管理员")
        manager = get_user_by_username(self.conn, "password-manager")
        replace_user_roles(self.conn, actor=self.admin, target=manager, role_ids=[manager_role["id"]])

        visible_user_ids = {user["id"] for user in get_users(conn=self.conn, actor=manager)["users"]}
        self.assertIn(manager["id"], visible_user_ids)
        self.assertNotIn(self.author["id"], visible_user_ids)

        with self.assertRaises(HTTPException) as context:
            update_admin_user(
                self.conn,
                actor=manager,
                target=self.author,
                password="replaced-password",
            )

        self.assertEqual(context.exception.status_code, 403)

    def test_reading_permissions_does_not_rewrite_builtin_role_permissions(self):
        permission_keys_for_user(self.conn, self.admin)

        with patch("app.services.role_service._replace_role_permissions") as replace_permissions:
            ensure_role_defaults(self.conn)

        replace_permissions.assert_not_called()


if __name__ == "__main__":
    unittest.main()
