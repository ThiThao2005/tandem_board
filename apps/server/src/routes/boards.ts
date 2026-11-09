import {
  boardInput,
  cardCreateInput,
  cardMoveInput,
  cardUpdateInput,
  columnCreateInput,
  columnUpdateInput,
  evenPositions,
  needsRebalance,
  positionBetween,
  type Board,
  type BoardSnapshot,
  type Card,
  type CardMoveResult,
  type Column,
} from "@tandem/shared";
import { Router } from "express";
import { requireBoard, requireCard, requireColumn, requireWorkspace } from "../access";
import { uid } from "../auth/middleware";
import { isPgError, pool, RetryTransaction, UNIQUE_VIOLATION, withTx, type Db } from "../db";
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
 */
async function endOfColumn(db: Db, columnId: string, exceptCardId: string | null = null): Promise<string> {
  const { rows } = await db.query<{ max: string | null }>(
    "SELECT max(position) AS max FROM cards WHERE column_id = $1 AND id IS DISTINCT FROM $2",
    [columnId, exceptCardId],
  );
  return positionBetween(rows[0]?.max ?? null, null);
}

async function endOfBoard(db: Db, boardId: string): Promise<string> {
  const { rows } = await db.query<{ max: string | null }>(
    "SELECT max(position) AS max FROM columns WHERE board_id = $1",
    [boardId],
  );
  return positionBetween(rows[0]?.max ?? null, null);
}

/**
 * Chuẩn bị chuyển thẻ sang cột đích: khóa CẢ cột nguồn lẫn cột đích, rồi mới khóa thẻ.
 *
 * Thứ tự khóa trong cả file: CỘT TRƯỚC, THẺ SAU; nhiều cột thì theo id tăng dần.
 * - Cột trước thẻ: sắp xếp lại cột phải sửa mọi thẻ trong cột khi đang giữ khóa cột. Nếu có chỗ
 *   khóa thẻ trước rồi mới chờ cột thì A giữ thẻ X chờ cột D, B giữ cột D chờ thẻ X → deadlock.
 * - Phải khóa cả cột nguồn: nếu chỉ khóa cột đích, hai người kéo chéo nhau (X: B→A, Y: A→B)
 *   mà cả hai cột cùng phải sắp xếp lại thì A sửa Y (đang bị B giữ), B sửa X (đang bị A giữ)
 *   → deadlock. Khóa cả hai cột thì hai lượt kéo này xếp hàng chờ nhau.
 * - Theo id tăng dần: ai cũng khóa {A, B} theo cùng một thứ tự nên không ai giữ B mà chờ A.
 *
 * Cột nguồn đọc lúc chưa khóa; nếu trong lúc chờ khóa thẻ bị người khác chuyển sang cột khác
 * thì ném RetryTransaction để withTx chạy lại từ đầu với cột nguồn mới.
 */
async function lockCardAndColumns(db: Db, userId: string, cardId: string, targetColumnId: string) {
  const { boardId, columnId: sourceColumnId } = await requireCard(db, userId, cardId, "editor");
  const { rows } = await db.query<{ id: string; boardId: string }>(
    // LockRows nằm trên Sort trong kế hoạch thực thi → các dòng bị khóa đúng theo thứ tự id.
    `SELECT id, board_id AS "boardId" FROM columns WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[sourceColumnId, targetColumnId]],
  );
  // Cột đích phải thuộc cùng bảng với thẻ; kiểm tra bằng DB chứ không tin client.
  if (rows.find((r) => r.id === targetColumnId)?.boardId !== boardId) throw notFound("Target column not found");

  const card = await requireCard(db, userId, cardId, "editor", true);
  if (card.columnId !== sourceColumnId) throw new RetryTransaction();
  return card;
}

function cardDeleted(card: { deletedByName: string | null }) {
  return new HttpError(410, "card_deleted", `This card was deleted by ${card.deletedByName ?? "someone else"}`, {
    deletedBy: card.deletedByName,
  });
}

interface MoveIntent {
  columnId: string;
  afterCardId: string | null;
  beforeCardId: string | null;
}

/**
 * Tính vị trí mới từ ý định của client, dựa trên hàng xóm HIỆN TẠI trong DB:
 *  1. afterCardId còn trong cột → ngay sau thẻ đó (trước thẻ kế tiếp của nó);
 *  2. không thì beforeCardId còn trong cột → ngay trước thẻ đó;
 *  3. không thì nếu client thả lên đầu cột (after = null, before ≠ null) → đầu cột;
 *  4. còn lại → cuối cột.
 * Hàng xóm "không còn" là đã bị xóa, bị chuyển sang cột khác, hoặc chính là thẻ đang kéo.
 * Phải gọi khi đang khóa cột đích, để "thẻ kế tiếp" không bị ai chen vào giữa chừng.
 */
async function positionForMove(db: Db, cardId: string, intent: MoveIntent): Promise<string> {
  const { columnId } = intent;
  const live = "column_id = $1 AND id <> $2 AND deleted_at IS NULL";
  const one = async (sql: string, extra: unknown[] = []) =>
    (await db.query<{ v: string | null }>(sql, [columnId, cardId, ...extra])).rows[0]?.v ?? null;
  const anchor = (id: string | null) =>
    id === null ? null : one(`SELECT position AS v FROM cards WHERE ${live} AND id = $3`, [id]);

  const after = await anchor(intent.afterCardId);
  if (after !== null) {
    const next = await one(`SELECT min(position) AS v FROM cards WHERE ${live} AND position > $3 COLLATE "C"`, [after]);
    return positionBetween(after, next);
  }
  const before = await anchor(intent.beforeCardId);
  if (before !== null) {
    const prev = await one(`SELECT max(position) AS v FROM cards WHERE ${live} AND position < $3 COLLATE "C"`, [before]);
    return positionBetween(prev, before);
  }
  if (intent.afterCardId === null && intent.beforeCardId !== null) {
    return positionBetween(null, await one(`SELECT min(position) AS v FROM cards WHERE ${live}`));
  }
  return endOfColumn(db, columnId, cardId);
}

/**
 * Sắp xếp lại cả cột khi vị trí quá dài: giữ nguyên thứ tự hiện tại, gán lại các
 * vị trí ngắn "a0", "a1", … Tính cả thẻ đã xóa mềm để khi khôi phục chúng vẫn về
 * đúng chỗ cũ. Không tăng version: đổi vị trí không phải là sửa nội dung thẻ.
 * Phải gọi khi đang khóa cột.
 */
async function rebalanceColumn(db: Db, columnId: string): Promise<CardMoveResult["rebalanced"]> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM cards WHERE column_id = $1 ORDER BY position, id", [
    columnId,
  ]);
  const ids = rows.map((r) => r.id);
  const positions = evenPositions(ids.length);
  await db.query(
    `UPDATE cards AS k SET position = v.position
       FROM unnest($1::uuid[], $2::text[]) AS v(id, position)
      WHERE k.id = v.id AND k.column_id = $3`,
    [ids, positions, columnId],
  );
  return ids.map((id, i) => ({ id, position: positions[i]! }));
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
    const positions = evenPositions(DEFAULT_COLUMNS.length);
    for (const [i, colTitle] of DEFAULT_COLUMNS.entries()) {
      await c.query("INSERT INTO columns (board_id, title, position) VALUES ($1, $2, $3)", [
        board.id,
        colTitle,
        positions[i],
      ]);
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
    pool.query<Column>(`SELECT ${COLUMN_COLS} FROM columns WHERE board_id = $1 ORDER BY position, id`, [boardId]),
    // Trùng vị trí (rất hiếm, nhờ jitter) thì xếp theo id, để ai tải bảng cũng thấy cùng một thứ tự.
    pool.query<Card>(
      `SELECT ${CARD_COLS} FROM cards k WHERE k.board_id = $1 AND k.deleted_at IS NULL ORDER BY k.position, k.id`,
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
    // Đổi cột: khóa cột nguồn + cột đích TRƯỚC khi khóa thẻ (xem lockCardAndColumns).
    const current =
      input.columnId !== undefined
        ? await lockCardAndColumns(c, me, cardId, input.columnId)
        : await requireCard(c, me, cardId, "editor", true);
    if (current.deletedAt) throw cardDeleted(current);

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

/** Kéo thả thẻ: sang chỗ khác trong cùng cột, hoặc sang cột khác của cùng bảng. */
boardsRouter.post("/cards/:id/move", async (req, res) => {
  const cardId = parseId(req.params.id);
  const intent = parse(cardMoveInput, req.body);
  const me = uid(req);
  const result = await withTx(async (c): Promise<CardMoveResult> => {
    const current = await lockCardAndColumns(c, me, cardId, intent.columnId);
    if (current.deletedAt) throw cardDeleted(current);

    const position = await positionForMove(c, cardId, intent);
    await c.query(
      `UPDATE cards SET column_id = $2, position = $3, version = version + 1, updated_by = $4, updated_at = now()
        WHERE id = $1`,
      [cardId, intent.columnId, position, me],
    );
    const rebalanced = needsRebalance(position) ? await rebalanceColumn(c, intent.columnId) : [];
    return { card: await getCard(c, cardId), rebalanced };
  });
  res.json(result);
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
