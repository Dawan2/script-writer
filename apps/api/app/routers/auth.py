import sqlite3

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.core.security import create_access_token
from app.db.session import get_db
from app.dependencies import current_user
from app.services.audit_service import record_audit
from app.services.auth_service import authenticate_user, change_password as change_user_password, public_user
from app.services.role_service import permission_keys_for_user

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


@router.post("/login")
def login(payload: LoginRequest, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    user = authenticate_user(conn, payload.username, payload.password)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect username or password")
    record_audit(
        conn,
        actor=user,
        action="auth.login",
        target_type="user",
        target_id=user["id"],
        target_label=user["username"],
        details={"role": user["role"], "auth_version": user["auth_version"] if "auth_version" in user.keys() else 0},
    )
    token = create_access_token({
        "sub": str(user["id"]),
        "username": user["username"],
        "role": user["role"],
        "ver": user["auth_version"] if "auth_version" in user.keys() else 0,
    })
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": public_user(user, permission_keys=permission_keys_for_user(conn, user)),
    }


@router.get("/me")
def me(
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    return {"user": public_user(user, permission_keys=permission_keys_for_user(conn, user))}


@router.post("/change-password")
def change_password(
    payload: ChangePasswordRequest,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    updated_user = change_user_password(
        conn,
        user=user,
        current_password=payload.current_password,
        new_password=payload.new_password,
    )
    token = create_access_token({
        "sub": str(updated_user["id"]),
        "username": updated_user["username"],
        "role": updated_user["role"],
        "ver": updated_user["auth_version"] if "auth_version" in updated_user.keys() else 0,
    })
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": public_user(updated_user, permission_keys=permission_keys_for_user(conn, updated_user)),
    }


@router.post("/logout")
def logout(
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    record_audit(
        conn,
        actor=user,
        action="auth.logout",
        target_type="user",
        target_id=user["id"],
        target_label=user["username"],
    )
    return {"ok": True}
