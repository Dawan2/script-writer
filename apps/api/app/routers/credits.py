from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from app.db.session import get_db
from app.dependencies import current_user
from app.services.credit_service import credit_summary


router = APIRouter(prefix="/credits", tags=["credits"])


@router.get("/me")
def get_my_credits(
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    return {"credits": credit_summary(conn, user_id=int(user["id"]))}
