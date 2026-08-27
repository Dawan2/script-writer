import sqlite3

from fastapi import APIRouter, Depends, Query

from app.db.session import get_db
from app.dependencies import current_user
from app.services.notification_service import (
    list_notifications,
    mark_all_notifications_read,
    mark_notification_read,
)


router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
def get_notifications(
    limit: int = Query(30, ge=1, le=50),
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    return list_notifications(conn, user["id"], limit)


@router.post("/read")
def post_notifications_read(
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    return {"updated": mark_all_notifications_read(conn, user["id"])}


@router.post("/{notification_id}/read")
def post_notification_read(
    notification_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user=Depends(current_user),
) -> dict:
    return {"updated": mark_notification_read(conn, user["id"], notification_id)}
