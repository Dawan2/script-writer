import argparse

from app.db.session import get_connection, init_db
from app.services.auth_service import get_user_by_username
from app.services.workspace_service import import_workspace
from app.core.config import settings


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", required=True)
    args = parser.parse_args()

    init_db()
    imported = []
    with get_connection() as conn:
        owner = get_user_by_username(conn, args.owner)
        if not owner:
            raise SystemExit(f"Owner user not found: {args.owner}")
        for workspace_dir in sorted(settings.workspaces_dir.iterdir()):
            if workspace_dir.is_dir() and not workspace_dir.name.startswith("."):
                item = import_workspace(conn, workspace_dir, owner["id"])
                if item:
                    imported.append(item)
        conn.commit()
    print({"imported": imported, "count": len(imported)})


if __name__ == "__main__":
    main()
