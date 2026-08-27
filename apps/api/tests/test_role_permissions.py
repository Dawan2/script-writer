import inspect
import unittest

from fastapi import HTTPException

from app.dependencies import admin_user
from app.routers.admin import post_agent_evolution_run_debug
from app.routers.agent import post_start_agent_debug


class RolePermissionsTest(unittest.TestCase):
    def test_admin_can_use_admin_only_capabilities(self):
        user = {"id": 1, "role": "admin"}

        self.assertIs(admin_user(user), user)

    def test_regular_user_is_denied_admin_only_capabilities(self):
        with self.assertRaises(HTTPException) as context:
            admin_user({"id": 2, "role": "user"})

        self.assertEqual(context.exception.status_code, 403)

    def test_zdebug_start_requires_task_running_permission(self):
        dependency = inspect.signature(post_start_agent_debug).parameters["user"].default

        self.assertIsNot(dependency.dependency, admin_user)
        self.assertEqual(dependency.dependency.__closure__[0].cell_contents, "admin:jobs")

    def test_evolution_zdebug_requires_evolution_permission(self):
        dependency = inspect.signature(post_agent_evolution_run_debug).parameters["_actor"].default

        self.assertIsNot(dependency.dependency, admin_user)
        self.assertEqual(dependency.dependency.__closure__[0].cell_contents, "admin:evolution")


if __name__ == "__main__":
    unittest.main()
