import { randomUUID } from "node:crypto";
import {
  boardInput,
  cardCreateInput,
  cardMoveInput,
  cardUpdateInput,
  columnCreateInput,
  columnUpdateInput,
  evenPositions,
  opRequest,
  type Board,
  type BoardOp,
  type Card,
  type CardMoveResult,
  type Column,
  type OpRequestInput,
  type ResultPayload,
} from "@tandem/shared";
import { Router, type Request } from "express";
import { z } from "zod";
import { requireBoard, requireWorkspace } from "../access";
import { uid } from "../auth/middleware";
import { pool, withTx } from "../db";
import { HttpError, parse, parseId } from "../errors";
import { BOARD_COLS, catchUp, executeOp, readSnapshot } from "../ops";
import { boardDeleted, publishOp } from "../realtime";

/*
 * REST vẫn giữ (dùng cho test, công cụ, và client không mở WebSocket), nhưng mọi thay đổi trên bảng đều
 * đi qua executeOp giống hệt đường WebSocket: có seq, được ghi vào operations và được phát cho phòng.
 */

export const boardsRouter = Router();

const DEFAULT_COLUMNS = ["To do", "In progress", "Done"];

/**
 * Header X-Op-Id (UUID) để gửi lại an toàn: cùng một opId thì server trả lại kết quả cũ.
 * Không có thì server tự sinh.
 */
function opIdOf(req: Request): string {
  const header = req.header("x-op-id");
  if (header === undefined) return randomUUID();
  const r = z.string().uuid().safeParse(header);
  if (!r.success) throw new HttpError(400, "invalid_input", "X-Op-Id must be a UUID");
  return r.data;
}

/** Chạy thao tác rồi phát cho phòng của bảng (sau khi đã commit). */
async function runOp(req: Request, input: Omit<OpRequestInput, "opId">): Promise<BoardOp> {
  const { op, duplicate } = await executeOp(uid(req), opRequest.parse({ ...input, opId: opIdOf(req) }));
  if (!duplicate) publishOp(op);
  return op;
}

/** Gửi lại opId của một loại thao tác khác đã bị executeOp từ chối, nên `type` ở đây luôn khớp. */
function payloadOf<T extends BoardOp["type"]>(op: BoardOp, _type: T): ResultPayload<T> {
  return op.payload as ResultPayload<T>;
}

// ---------- Bảng ----------

boardsRouter.get("/workspaces/:id/boards", async (req, res) => {
  const workspaceId = parseId(req.params.id);
  await requireWorkspace(pool, uid(req), workspaceId, "viewer");
  const { rows } = await pool.query<Board>(`SELECT ${BOARD_COLS} FROM boards WHERE workspace_id = $1 ORDER BY created_at`, [
    workspaceId,
  ]);
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
    // Cột mặc định là một phần của việc tạo bảng (seq = 0), không phải thao tác riêng.
    const positions = evenPositions(DEFAULT_COLUMNS.length);
    for (const [i, colTitle] of DEFAULT_COLUMNS.entries()) {
      await c.query("INSERT INTO columns (board_id, title, position) VALUES ($1, $2, $3)", [board.id, colTitle, positions[i]]);
    }
    return board;
  });
  res.status(201).json(board);
});

/** Ảnh chụp toàn bộ bảng kèm seq: client nhận tiếp các thao tác từ seq + 1. */
boardsRouter.get("/boards/:id", async (req, res) => {
  res.json(await readSnapshot(uid(req), parseId(req.params.id)));
});

/** Phần còn thiếu sau `after`: danh sách thao tác, hoặc ảnh chụp nếu thiếu quá nhiều. */
boardsRouter.get("/boards/:id/ops", async (req, res) => {
  const boardId = parseId(req.params.id);
  const after = parse(z.coerce.number().int().min(0), req.query.after ?? 0);
  res.json((await catchUp(uid(req), boardId, after)).catchUp);
});

boardsRouter.patch("/boards/:id", async (req, res) => {
  const boardId = parseId(req.params.id);
  const { title } = parse(boardInput, req.body);
  const op = await runOp(req, { type: "board.update", payload: { boardId, title } });
  res.json(payloadOf(op, "board.update").board);
});

boardsRouter.delete("/boards/:id", async (req, res) => {
  const boardId = parseId(req.params.id);
  await requireBoard(pool, uid(req), boardId, "owner");
  await pool.query("DELETE FROM boards WHERE id = $1", [boardId]);
  boardDeleted(boardId);
  res.status(204).end();
});

// ---------- Cột ----------

boardsRouter.post("/boards/:id/columns", async (req, res) => {
  const boardId = parseId(req.params.id);
  const input = parse(columnCreateInput, req.body);
  const op = await runOp(req, {
    type: "column.create",
    payload: { boardId, id: input.id ?? randomUUID(), title: input.title },
  });
  res.status(201).json(payloadOf(op, "column.create").column satisfies Column);
});

boardsRouter.patch("/columns/:id", async (req, res) => {
  const columnId = parseId(req.params.id);
  const { title } = parse(columnUpdateInput, req.body);
  const op = await runOp(req, { type: "column.update", payload: { columnId, title } });
  res.json(payloadOf(op, "column.update").column);
});

boardsRouter.delete("/columns/:id", async (req, res) => {
  const columnId = parseId(req.params.id);
  await runOp(req, { type: "column.delete", payload: { columnId } });
  res.status(204).end();
});

// ---------- Thẻ ----------

boardsRouter.post("/columns/:id/cards", async (req, res) => {
  const columnId = parseId(req.params.id);
  const input = parse(cardCreateInput, req.body);
  const op = await runOp(req, {
    type: "card.create",
    payload: { columnId, id: input.id ?? randomUUID(), title: input.title },
  });
  res.status(201).json(payloadOf(op, "card.create").card satisfies Card);
});

boardsRouter.patch("/cards/:id", async (req, res) => {
  const cardId = parseId(req.params.id);
  const input = parse(cardUpdateInput, req.body);
  const op = await runOp(req, { type: "card.update", payload: { ...input, cardId } });
  res.json(payloadOf(op, "card.update").card);
});

/** Kéo thả thẻ: sang chỗ khác trong cùng cột, hoặc sang cột khác của cùng bảng. */
boardsRouter.post("/cards/:id/move", async (req, res) => {
  const cardId = parseId(req.params.id);
  const intent = parse(cardMoveInput, req.body);
  const op = await runOp(req, { type: "card.move", payload: { ...intent, cardId } });
  res.json(payloadOf(op, "card.move") satisfies CardMoveResult);
});

boardsRouter.delete("/cards/:id", async (req, res) => {
  const cardId = parseId(req.params.id);
  const op = await runOp(req, { type: "card.delete", payload: { cardId } });
  res.json(payloadOf(op, "card.delete").card);
});

boardsRouter.post("/cards/:id/restore", async (req, res) => {
  const cardId = parseId(req.params.id);
  const op = await runOp(req, { type: "card.restore", payload: { cardId } });
  res.json(payloadOf(op, "card.restore").card);
});
