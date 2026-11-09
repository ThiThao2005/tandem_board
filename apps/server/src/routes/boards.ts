import {
  boardInput,
  cardCreateInput,
  cardUpdateInput,
  columnCreateInput,
  columnUpdateInput,
  type Board,
  type BoardSnapshot,
  type Card,
  type Column,
} from "@tandem/shared";
import { Router } from "express";
import { generateKeyBetween } from "fractional-indexing";
import { requireBoard, requireCard, requireColumn, requireWorkspace } from "../access";
import { uid } from "../auth/middleware";
import { isPgError, pool, UNIQUE_VIOLATION, withTx, type Db } from "../db";
import { HttpError, notFound, parse, parseId } from "../errors";
import { listMembers } from "./workspaces";

export const boardsRouter = Router();

const BOARD_COLS = `id, workspace_id AS "workspaceId", title`;
const COLUMN_COLS = `id, board_id AS "boardId", title, position`;
const CARD_COLS = `k.id, k.board_id AS "boardId", k.column_id AS "columnId", k.title,
  k.due_date AS "dueDate", k.assignee_id AS "assigneeId", k.position, k.version,
  k.deleted_at AS "deletedAt", k.updated_at AS "updatedAt", k.updated_by AS "updatedBy"`;

const DEFAULT_COLUMNS = ["To do", "In progress", "Done"];

/** Client gửi id trùng với dòng đã có. */
const idTaken = () => new HttpError(409, "id_taken", "This id is already in use");

async function getCard(db: Db, id: string): Promise<Card> {
  const { rows } = await db.query<Card>(`SELECT ${CARD_COLS} FROM cards k WHERE k.id = $1`, [id]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

/**
 * Vị trí cuối cột. Gọi bên trong transaction SAU KHI đã khóa dòng cột (hoặc bảng),
 * nên hai lần thêm song song không lấy trùng một vị trí.
 * Tính cả thẻ đã xóa mềm, để thẻ được khôi phục không trùng vị trí với thẻ mới.
 * (Tuần 2 sẽ thay bằng chèn vào giữa khi kéo thả.)
 */
async function endOfColumn(db: Db, columnId: string): Promise<string> {
  const { rows } = await db.query<{ max: string | null }>(
    "SELECT max(position) AS max FROM cards WHERE column_id = $1",
    [columnId],
  );
  return generateKeyBetween(rows[0]?.max ?? null, null);
}

async function endOfBoard(db: Db, boardId: string): Promise<string> {
  const { rows } = await db.query<{ max: string | null }>(
    "SELECT max(position) AS max FROM columns WHERE board_id = $1",
    [boardId],
  );
  return generateKeyBetween(rows[0]?.max ?? null, null);
}

// ---------- Bảng ----------

boardsRouter.get("/workspaces/:id/boards", async (req, res) => {
  const workspaceId = parseId(req.params.id);
  await requireWorkspace(pool, uid(req), workspaceId, "viewer");
  const { rows } = await pool.query<Board>(
    `SELECT ${BOARD_COLS} FROM boards WHERE workspace_id = $1 ORDER BY created_at`,
    [workspaceId],
  );
  res.json(rows);
});

boardsRouter.post("/workspaces/:id/boards", async (req, res) => {
  const workspaceId = parseId(req.params.id);
  const { title } = parse(boardInput, req.body);
  const board = await withTx(async (c) => {
    await requireWorkspace(c, uid(req), workspaceId, "editor");
    const { rows } = await c.query<Board>(
      `INSERT INTO boards (workspace_id, title, created_by) VALUES ($1, $2, $3) RETURNING ${BOARD_COLS}`,
      [workspaceId, title, uid(req)],
    );
    const board = rows[0]!;
    let pos: string | null = null;
    for (const colTitle of DEFAULT_COLUMNS) {
      pos = generateKeyBetween(pos, null);
      await c.query("INSERT INTO columns (board_id, title, position) VALUES ($1, $2, $3)", [board.id, colTitle, pos]);
    }
    return board;
  });
  res.status(201).json(board);
});

/** Ảnh chụp toàn bộ bảng: cột, thẻ chưa xóa, thành viên (để chọn người phụ trách). */
boardsRouter.get("/boards/:id", async (req, res) => {
  const boardId = parseId(req.params.id);
  const access = await requireBoard(pool, uid(req), boardId, "viewer");
  const [board, columns, cards, members] = await Promise.all([
    pool.query<Board>(`SELECT ${BOARD_COLS} FROM boards WHERE id = $1`, [boardId]),
    pool.query<Column>(`SELECT ${COLUMN_COLS} FROM columns WHERE board_id = $1 ORDER BY position`, [boardId]),
    pool.query<Card>(
      `SELECT ${CARD_COLS} FROM cards k WHERE k.board_id = $1 AND k.deleted_at IS NULL ORDER BY k.position`,
      [boardId],
    ),
    listMembers(pool, access.workspaceId),
  ]);
  const snapshot: BoardSnapshot = {
    board: board.rows[0]!,
    role: access.role,
    columns: columns.rows,
    cards: cards.rows,
    members,
  };
  res.json(snapshot);
});

boardsRouter.patch("/boards/:id", async (req, res) => {
  const boardId = parseId(req.params.id);
  const { title } = parse(boardInput, req.body);
  await requireBoard(pool, uid(req), boardId, "editor");
  const { rows } = await pool.query<Board>(
    `UPDATE boards SET title = $2, updated_at = now() WHERE id = $1 RETURNING ${BOARD_COLS}`,
    [boardId, title],
  );
  res.json(rows[0]);
});

boardsRouter.delete("/boards/:id", async (req, res) => {
  const boardId = parseId(req.params.id);
  await requireBoard(pool, uid(req), boardId, "owner");
  await pool.query("DELETE FROM boards WHERE id = $1", [boardId]);
  res.status(204).end();
});

// ---------- Cột ----------

boardsRouter.post("/boards/:id/columns", async (req, res) => {
  const boardId = parseId(req.params.id);
  const input = parse(columnCreateInput, req.body);
  try {
    const column = await withTx(async (c) => {
      await requireBoard(c, uid(req), boardId, "editor", true);
      const { rows } = await c.query<Column>(
        `INSERT INTO columns (id, board_id, title, position)
         VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4) RETURNING ${COLUMN_COLS}`,
        [input.id ?? null, boardId, input.title, await endOfBoard(c, boardId)],
      );
      return rows[0]!;
    });
    res.status(201).json(column);
  } catch (err) {
    if (isPgError(err, UNIQUE_VIOLATION)) throw idTaken();
    throw err;
  }
});

boardsRouter.patch("/columns/:id", async (req, res) => {
  const columnId = parseId(req.params.id);
  const { title } = parse(columnUpdateInput, req.body);
  await requireColumn(pool, uid(req), columnId, "editor");
  const { rows } = await pool.query<Column>(
    `UPDATE columns SET title = $2 WHERE id = $1 RETURNING ${COLUMN_COLS}`,
    [columnId, title],
  );
  res.json(rows[0]);
});

/** Không cho xóa cột còn thẻ: xóa dây chuyền sẽ làm mất thẻ người khác vừa thêm. */
boardsRouter.delete("/columns/:id", async (req, res) => {
  const columnId = parseId(req.params.id);
  await withTx(async (c) => {
    await requireColumn(c, uid(req), columnId, "editor", true);
    const { rows } = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM cards WHERE column_id = $1 AND deleted_at IS NULL",
      [columnId],
    );
    if (rows[0]!.n > 0) {
      throw new HttpError(409, "column_not_empty", "This column still has cards. Move or delete them first");
    }
    await c.query("DELETE FROM columns WHERE id = $1", [columnId]);
  });
  res.status(204).end();
});

// ---------- Thẻ ----------

boardsRouter.post("/columns/:id/cards", async (req, res) => {
  const columnId = parseId(req.params.id);
  const input = parse(cardCreateInput, req.body);
  const me = uid(req);
  try {
    const card = await withTx(async (c) => {
      const col = await requireColumn(c, me, columnId, "editor", true);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO cards (id, board_id, column_id, title, position, created_by, updated_by)
         VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $6) RETURNING id`,
        [input.id ?? null, col.boardId, columnId, input.title, await endOfColumn(c, columnId), me],
      );
      return getCard(c, rows[0]!.id);
    });
    res.status(201).json(card);
  } catch (err) {
    if (isPgError(err, UNIQUE_VIOLATION)) throw idTaken();
    throw err;
  }
});

boardsRouter.patch("/cards/:id", async (req, res) => {
  const cardId = parseId(req.params.id);
  const input = parse(cardUpdateInput, req.body);
  const me = uid(req);
  const card = await withTx(async (c) => {
    const current = await requireCard(c, me, cardId, "editor", true);

    if (current.deletedAt) {
      throw new HttpError(410, "card_deleted", `This card was deleted by ${current.deletedByName ?? "someone else"}`, {
        deletedBy: current.deletedByName,
      });
    }
    // Tuần 1: so cả thẻ. Tuần 3 sẽ đổi thành so từng trường.
    if (input.baseVersion !== undefined && input.baseVersion !== current.version) {
      throw new HttpError(409, "version_conflict", "Someone else just edited this card", { card: await getCard(c, cardId) });
    }

    const sets: string[] = [];
    const values: unknown[] = [cardId, me];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (input.title !== undefined) set("title", input.title);
    if (input.dueDate !== undefined) set("due_date", input.dueDate);
    if (input.assigneeId !== undefined) {
      if (input.assigneeId !== null) {
        const ok = await c.query("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [
          current.workspaceId,
          input.assigneeId,
        ]);
        if (!ok.rowCount) throw new HttpError(400, "invalid_assignee", "The assignee must be a workspace member");
      }
      set("assignee_id", input.assigneeId);
    }
    if (input.columnId !== undefined && input.columnId !== current.columnId) {
      // Cột đích phải thuộc cùng bảng; kiểm tra bằng DB chứ không tin client.
      const target = await c.query<{ boardId: string }>(
        `SELECT board_id AS "boardId" FROM columns WHERE id = $1 FOR UPDATE`,
        [input.columnId],
      );
      if (target.rows[0]?.boardId !== current.boardId) throw notFound("Target column not found");
      set("column_id", input.columnId);
      set("position", await endOfColumn(c, input.columnId));
    }

    if (sets.length > 0) {
      await c.query(
        `UPDATE cards SET ${sets.join(", ")}, version = version + 1, updated_by = $2, updated_at = now()
          WHERE id = $1`,
        values,
      );
    }
    return getCard(c, cardId);
  });
  res.json(card);
});

/** Xóa mềm: thẻ vẫn còn trong DB để khôi phục và để báo cho người đang sửa dở. */
boardsRouter.delete("/cards/:id", async (req, res) => {
  const cardId = parseId(req.params.id);
  const me = uid(req);
  const card = await withTx(async (c) => {
    await requireCard(c, me, cardId, "editor", true);
    await c.query(
      `UPDATE cards SET deleted_at = now(), deleted_by = $2, version = version + 1, updated_by = $2, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL`,
      [cardId, me],
    );
    return getCard(c, cardId);
  });
  res.json(card);
});

boardsRouter.post("/cards/:id/restore", async (req, res) => {
  const cardId = parseId(req.params.id);
  const me = uid(req);
  const card = await withTx(async (c) => {
    await requireCard(c, me, cardId, "editor", true);
    await c.query(
      `UPDATE cards SET deleted_at = NULL, deleted_by = NULL, version = version + 1, updated_by = $2, updated_at = now()
        WHERE id = $1 AND deleted_at IS NOT NULL`,
      [cardId, me],
    );
    return getCard(c, cardId);
  });
  res.json(card);
});
