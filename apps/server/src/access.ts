import { ROLE_RANK, type Role } from "@tandem/shared";
import type { Db } from "./db";
import { forbidden, notFound } from "./errors";

/**
 * Kiểm tra quyền dựa trên dữ liệu trong DB, KHÔNG dựa trên id client gửi kèm.
 * Ví dụ sửa thẻ: workspace được suy ra từ thẻ → bảng → nhóm, nên client không thể
 * gửi boardId của bảng mình có quyền kèm cardId của nhóm khác (lỗi IDOR).
 *
 * Người ngoài nhóm nhận 404 thay vì 403, để không đoán được id nào tồn tại.
 */
function check(role: Role | null | undefined, min: Role): Role {
  if (!role) throw notFound();
  if (ROLE_RANK[role] < ROLE_RANK[min]) throw forbidden();
  return role;
}

export async function requireWorkspace(db: Db, userId: string, workspaceId: string, min: Role) {
  const { rows } = await db.query<{ role: Role }>(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  return check(rows[0]?.role, min);
}

export interface BoardAccess {
  boardId: string;
  workspaceId: string;
  role: Role;
}

export async function requireBoard(db: Db, userId: string, boardId: string, min: Role, lock = false) {
  const { rows } = await db.query<{ workspaceId: string; role: Role | null }>(
    `SELECT b.workspace_id AS "workspaceId", m.role
       FROM boards b
       LEFT JOIN workspace_members m ON m.workspace_id = b.workspace_id AND m.user_id = $2
      WHERE b.id = $1 ${lock ? "FOR UPDATE OF b" : ""}`,
    [boardId, userId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return { boardId, workspaceId: row.workspaceId, role: check(row.role, min) } satisfies BoardAccess;
}

export async function requireColumn(db: Db, userId: string, columnId: string, min: Role, lock = false) {
  const { rows } = await db.query<{ boardId: string; workspaceId: string; role: Role | null }>(
    `SELECT c.board_id AS "boardId", b.workspace_id AS "workspaceId", m.role
       FROM columns c
       JOIN boards b ON b.id = c.board_id
       LEFT JOIN workspace_members m ON m.workspace_id = b.workspace_id AND m.user_id = $2
      WHERE c.id = $1 ${lock ? "FOR UPDATE OF c" : ""}`,
    [columnId, userId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return { columnId, boardId: row.boardId, workspaceId: row.workspaceId, role: check(row.role, min) };
}

export async function requireCard(db: Db, userId: string, cardId: string, min: Role, lock = false) {
  const { rows } = await db.query<{
    boardId: string;
    columnId: string;
    workspaceId: string;
    version: number;
    deletedAt: string | null;
    deletedByName: string | null;
    role: Role | null;
  }>(
    `SELECT k.board_id AS "boardId", k.column_id AS "columnId", b.workspace_id AS "workspaceId",
            k.version, k.deleted_at AS "deletedAt", du.display_name AS "deletedByName", m.role
       FROM cards k
       JOIN boards b ON b.id = k.board_id
       LEFT JOIN users du ON du.id = k.deleted_by
       LEFT JOIN workspace_members m ON m.workspace_id = b.workspace_id AND m.user_id = $2
      WHERE k.id = $1 ${lock ? "FOR UPDATE OF k" : ""}`,
    [cardId, userId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return { cardId, ...row, role: check(row.role, min) };
}
