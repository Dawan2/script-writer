import argparse

from app.db.session import get_connection, init_db
from app.services.auth_service import create_user, get_user_by_username


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--username", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--display-name")
    parser.add_argument("--role", default="user", choices=["admin", "user"])
    args = parser.parse_args()

    init_db()
    with get_connection() as conn:
        if get_user_by_username(conn, args.username):
            print(f"User already exists: {args.username}")
            return
        create_user(
            conn,
            username=args.username,
            password=args.password,
            display_name=args.display_name,
            role=args.role,
        )
        conn.commit()
    print(f"Created user: {args.username} ({args.role})")


if __name__ == "__main__":
    main()
