import {
  evenPositions,
  MAX_CATCHUP_OPS,
  needsRebalance,
  positionBetween,
  ROLE_RANK,
  type BoardOp,
  type BoardSnapshot,
  type Card,
  type CardMoveResult,
  type CatchUp,
  type Column,
  type OpPayload,
  type OpRequest,
  type OpResult,
  type Role,
} from "@tandem/shared";
import { requireBoard, requireCard, requireColumn } from "./access";
import { isPgError, pool, RetryTransaction, UNIQUE_VIOLATION, withReadSnapshot, withTx, type Db } from "./db";
import { forbidden, HttpError, notFound } from "./errors";
import { listMembers } from "./routes/workspaces";

/*
 * Mọi thay đổi trên một bảng (từ REST hay từ WebSocket) đều đi qua executeOp:
 *
 *   BEGIN
 *     suy ra bảng từ thẻ/cột trong DB (không tin boardId client gửi) → kiểm tra quyền
 *     UPDATE boards SET last_seq = last_seq + 1     ← khóa dòng của bảng tới khi COMMIT
 *     làm thao tác (khóa cột → thẻ như tuần 2)
 *     INSERT INTO operations (seq, op_id, payload = kết quả)
 *   COMMIT
 *   → nơi gọi phát thao tác cho phòng board:{id}   ← chỉ phát SAU khi commit
 *
 * Thứ tự khóa trong cả server: BẢNG → CỘT (theo id tăng dần) → THẺ.
 * Khóa bảng đầu tiên nghĩa là mọi thao tác trên cùng một bảng xếp hàng lần lượt. Đổi lại:
 *  - seq liên tục, không lỗ, và thứ tự commit trùng thứ tự seq;
 *  - hai thao tác trên cùng bảng không thể deadlock với nhau.
 * Một bảng chỉ có vài người cùng sửa, nên xếp hàng không đáng kể (mỗi thao tác vài ms).
 */

export const BOARD_COLS = `id, workspace_id AS "workspaceId", title`;
const COLUMN_COLS = `id, board_id AS "boardId", title, position`;
const CARD_COLS = `k.id, k.board_id AS "boardId", k.column_id AS "columnId", k.title,
  k.due_date AS "dueDate", k.assignee_id AS "assigneeId", k.position, k.version,
  k.deleted_at AS "deletedAt", k.updated_at AS "updatedAt", k.updated_by AS "updatedBy"`;
const OP_COLS = `seq, op_id AS "opId", board_id AS "boardId", actor_id AS "actorId", type, payload,
  created_at AS "createdAt"`;

/** Client gửi id (thẻ/cột) trùng với dòng đã có. */
const idTaken = () => new HttpError(409, "id_taken", "This id is already in use");

// ---------- Đọc ----------

/** Date → chuỗi ISO ngay từ đây, để kết quả trả qua REST, qua socket và đọc lại từ bảng operations giống hệt nhau. */
const toCard = (row: unknown): Card => JSON.parse(JSON.stringify(row)) as Card;

async function getCard(db: Db, id: string): Promise<Card> {
  const { rows } = await db.query<Card>(`SELECT ${CARD_COLS} FROM cards k WHERE k.id = $1`, [id]);
  if (!rows[0]) throw notFound();
  return toCard(rows[0]);
}

function toOp(row: Omit<BoardOp, "createdAt"> & { createdAt: Date | string }): BoardOp {
  return { ...row, createdAt: new Date(row.createdAt).toISOString() } as BoardOp;
}

async function findOp(db: Db, opId: string): Promise<BoardOp | null> {
  const { rows } = await db.query(`SELECT ${OP_COLS} FROM operations WHERE op_id = $1`, [opId]);
  return rows[0] ? toOp(rows[0]) : null;
}

/** Ảnh chụp toàn bộ bảng. Gọi trong withReadSnapshot để seq khớp với dữ liệu. */
async function snapshotIn(db: Db, boardId: string, role: Role, workspaceId: string): Promise<BoardSnapshot> {
  const board = await db.query<{ id: string; workspaceId: string; title: string; seq: number }>(
    `SELECT ${BOARD_COLS}, last_seq AS seq FROM boards WHERE id = $1`,
    [boardId],
  );
  const columns = await db.query<Column>(`SELECT ${COLUMN_COLS} FROM columns WHERE board_id = $1 ORDER BY position, id`, [
    boardId,
  ]);
  // Trùng vị trí (rất hiếm, nhờ jitter) thì xếp theo id, để ai tải bảng cũng thấy cùng một thứ tự.
  const cards = await db.query<Card>(
    `SELECT ${CARD_COLS} FROM cards k WHERE k.board_id = $1 AND k.deleted_at IS NULL ORDER BY k.position, k.id`,
    [boardId],
  );
  const { seq, ...b } = board.rows[0]!;
  return {
    seq,
    board: b,
    role,
    columns: columns.rows,
    cards: JSON.parse(JSON.stringify(cards.rows)) as Card[],
    members: await listMembers(db, workspaceId),
  };
}

export async function readSnapshot(userId: string, boardId: string): Promise<BoardSnapshot> {
  return withReadSnapshot(async (c) => {
    const access = await requireBoard(c, userId, boardId, "viewer");
    return snapshotIn(c, boardId, access.role, access.workspaceId);
  });
}

/**
 * Phần client còn thiếu khi vào bảng hoặc kết nối lại: các thao tác có seq > lastSeq.
 * Thiếu quá MAX_CATCHUP_OPS (hoặc lastSeq vô lý: null, lớn hơn seq của server) thì gửi ảnh chụp.
 */
export async function catchUp(
  userId: string,
  boardId: string,
  lastSeq: number | null,
): Promise<{ role: Role; workspaceId: string; catchUp: CatchUp }> {
  return withReadSnapshot(async (c) => {
    const access = await requireBoard(c, userId, boardId, "viewer");
    const { rows } = await c.query<{ seq: number }>("SELECT last_seq AS seq FROM boards WHERE id = $1", [boardId]);
    const seq = rows[0]!.seq;
    const base = { role: access.role, workspaceId: access.workspaceId };
    if (lastSeq === null || lastSeq > seq || seq - lastSeq > MAX_CATCHUP_OPS) {
      return { ...base, catchUp: { kind: "snapshot", snapshot: await snapshotIn(c, boardId, access.role, access.workspaceId) } };
    }
    const ops = await c.query(`SELECT ${OP_COLS} FROM operations WHERE board_id = $1 AND seq > $2 ORDER BY seq`, [
      boardId,
      lastSeq,
    ]);
    return { ...base, catchUp: { kind: "ops", ops: ops.rows.map(toOp) } };
  });
}

// ---------- Vị trí (tuần 2) ----------

/**
 * Vị trí cuối cột. Gọi khi đã khóa cột (hoặc bảng), nên hai lần thêm song song không lấy trùng.
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
  const { rows } = await db.query<{ max: string | null }>("SELECT max(position) AS max FROM columns WHERE board_id = $1", [
    boardId,
  ]);
  return positionBetween(rows[0]?.max ?? null, null);
}

/**
 * Khóa CẢ cột nguồn lẫn cột đích (theo id tăng dần), rồi mới khóa thẻ — xem NOTES.md tuần 2.
 * Từ tuần 3 bảng đã bị khóa trước đó nên các thao tác trên cùng bảng không còn chạy song song nữa;
 * giữ nguyên thứ tự khóa này để vẫn đúng nếu sau này bỏ khóa bảng.
 */
async function lockCardAndColumns(db: Db, userId: string, cardId: string, targetColumnId: string) {
  const { boardId, columnId: sourceColumnId } = await requireCard(db, userId, cardId, "editor");
  const { rows } = await db.query<{ id: string; boardId: string }>(
    `SELECT id, board_id AS "boardId" FROM columns WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[sourceColumnId, targetColumnId]],
  );
  // Cột đích phải thuộc cùng bảng với thẻ; kiểm tra bằng DB chứ không tin client.
  if (rows.find((r) => r.id === targetColumnId)?.boardId !== boardId) throw notFound("Target column not found");

  const card = await requireCard(db, userId, cardId, "editor", true);
  if (card.columnId !== sourceColumnId) throw new RetryTransaction();
  return card;
}

function cardDeleted(card: { cardId: string; deletedByName: string | null }) {
  return new HttpError(410, "card_deleted", `This card was deleted by ${card.deletedByName ?? "someone else"}`, {
    cardId: card.cardId,
    deletedBy: card.deletedByName,
  });
}

/**
 * Tính vị trí mới từ ý định của client, dựa trên hàng xóm HIỆN TẠI trong DB:
 *  1. afterCardId còn trong cột → ngay sau thẻ đó (trước thẻ kế tiếp của nó);
 *  2. không thì beforeCardId còn trong cột → ngay trước thẻ đó;
 *  3. không thì nếu client thả lên đầu cột (after = null, before ≠ null) → đầu cột;
 *  4. còn lại → cuối cột.
 */
async function positionForMove(db: Db, cardId: string, intent: OpPayload<"card.move">): Promise<string> {
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
 * Sắp xếp lại cả cột khi vị trí quá dài: giữ thứ tự, gán lại "a0", "a1", … Tính cả thẻ đã xóa mềm
 * để khi khôi phục chúng về đúng chỗ cũ. Không tăng version: đổi vị trí không phải là sửa nội dung.
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

// ---------- Từng loại thao tác ----------

/**
 * Bảng mà thao tác tác động tới (suy ra từ thẻ/cột trong DB, không tin boardId client gửi) và quyền
 * "editor" của người gửi trên bảng đó — gộp trong MỘT truy vấn để bớt một lượt gọi DB (DB ở xa thì mỗi
 * lượt ~100 ms). Chưa khóa gì: board_id của thẻ/cột không bao giờ đổi.
 */
async function boardAccessOf(db: Db, me: string, req: OpRequest): Promise<string> {
  const member = "LEFT JOIN workspace_members m ON m.workspace_id = b.workspace_id AND m.user_id = $2";
  let sql: string;
  let id: string;
  switch (req.type) {
    case "board.update":
    case "column.create":
      sql = `SELECT b.id AS "boardId", m.role FROM boards b ${member} WHERE b.id = $1`;
      id = req.payload.boardId;
      break;
    case "column.update":
    case "column.delete":
    case "card.create":
      sql = `SELECT c.board_id AS "boardId", m.role FROM columns c JOIN boards b ON b.id = c.board_id ${member} WHERE c.id = $1`;
      id = req.payload.columnId;
      break;
    case "card.update":
    case "card.move":
    case "card.delete":
    case "card.restore":
      sql = `SELECT k.board_id AS "boardId", m.role FROM cards k JOIN boards b ON b.id = k.board_id ${member} WHERE k.id = $1`;
      id = req.payload.cardId;
      break;
  }
  const { rows } = await db.query<{ boardId: string; role: Role | null }>(sql, [id, me]);
  const row = rows[0];
  // Người ngoài nhóm nhận 404 như mọi chỗ khác (không cho biết thẻ/cột có tồn tại hay không).
  if (!row || !row.role) throw notFound();
  if (ROLE_RANK[row.role] < ROLE_RANK.editor) throw forbidden();
  return row.boardId;
}

/** Các trường của thẻ được theo dõi riêng để phát hiện xung đột (khóa trong cards.field_versions). */
const CARD_FIELDS = ["title", "dueDate", "assigneeId", "columnId"] as const;
type CardField = (typeof CARD_FIELDS)[number];
type FieldVersions = Partial<Record<CardField, { v: number; by: string | null }>>;

async function updateCard(db: Db, me: string, p: OpPayload<"card.update">): Promise<OpResult> {
  // Đổi cột: khóa cột nguồn + cột đích TRƯỚC khi khóa thẻ.
  const current =
    p.columnId !== undefined ? await lockCardAndColumns(db, me, p.cardId, p.columnId) : await requireCard(db, me, p.cardId, "editor", true);
  if (current.deletedAt) throw cardDeleted(current);

  const fields = CARD_FIELDS.filter((f) => p[f] !== undefined && !(f === "columnId" && p.columnId === current.columnId));
  const fv = current.fieldVersions as FieldVersions;

  // Xung đột chỉ khi CHÍNH trường đang sửa đã bị NGƯỜI KHÁC sửa sau phiên bản client đang thấy.
  // Sửa trường khác, kéo thẻ, hay chính mình vừa sửa (thao tác trước còn đang trên đường) thì không tính.
  if (p.baseVersion !== undefined) {
    const base = p.baseVersion;
    const conflicts = fields.filter((f) => {
      const last = fv[f];
      return last !== undefined && last.v > base && last.by !== me;
    });
    if (conflicts.length > 0) {
      throw new HttpError(409, "version_conflict", "Someone else just changed this card", {
        fields: conflicts,
        card: await getCard(db, p.cardId),
      });
    }
  }

  const sets: string[] = [];
  const values: unknown[] = [p.cardId, me];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (p.title !== undefined) set("title", p.title);
  if (p.dueDate !== undefined) set("due_date", p.dueDate);
  if (p.assigneeId !== undefined) {
    if (p.assigneeId !== null) {
      const ok = await db.query("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [
        current.workspaceId,
        p.assigneeId,
      ]);
      if (!ok.rowCount) throw new HttpError(400, "invalid_assignee", "The assignee must be a workspace member");
    }
    set("assignee_id", p.assigneeId);
  }
  if (p.columnId !== undefined && p.columnId !== current.columnId) {
    set("column_id", p.columnId);
    set("position", await endOfColumn(db, p.columnId));
  }

  if (sets.length === 0) return { type: "card.update", payload: { card: await getCard(db, p.cardId) } };
  const stamp = { v: current.version + 1, by: me };
  set("field_versions", JSON.stringify({ ...fv, ...Object.fromEntries(fields.map((f) => [f, stamp])) }));
  // RETURNING thay cho một lần đọc lại thẻ: bớt một lượt gọi DB.
  const { rows } = await db.query(
    `UPDATE cards AS k SET ${sets.join(", ")}, version = version + 1, updated_by = $2, updated_at = now()
      WHERE k.id = $1 RETURNING ${CARD_COLS}`,
    values,
  );
  return { type: "card.update", payload: { card: toCard(rows[0]) } };
}

async function moveCard(db: Db, me: string, p: OpPayload<"card.move">): Promise<OpResult> {
  const current = await lockCardAndColumns(db, me, p.cardId, p.columnId);
  if (current.deletedAt) throw cardDeleted(current);

  const position = await positionForMove(db, p.cardId, p);
  const columnChanged = p.columnId !== current.columnId;
  const { rows } = await db.query(
    `UPDATE cards AS k SET column_id = $2, position = $3, version = version + 1, updated_by = $4, updated_at = now(),
            field_versions = CASE WHEN $5::boolean THEN field_versions || jsonb_build_object('columnId',
              jsonb_build_object('v', version + 1, 'by', $4::uuid)) ELSE field_versions END
      WHERE k.id = $1 RETURNING ${CARD_COLS}`,
    [p.cardId, p.columnId, position, me, columnChanged],
  );
  const card = toCard(rows[0]);
  const rebalanced = needsRebalance(position) ? await rebalanceColumn(db, p.columnId) : [];
  // Cột vừa được sắp xếp lại thì vị trí của chính thẻ này cũng đổi theo.
  const moved = rebalanced.find((r) => r.id === card.id);
  return { type: "card.move", payload: { card: moved ? { ...card, position: moved.position } : card, rebalanced } };
}

/** Làm thao tác. Bảng đã bị khóa và quyền "editor" trên bảng đã được kiểm tra. */
async function run(db: Db, me: string, boardId: string, req: OpRequest): Promise<OpResult> {
  switch (req.type) {
    case "board.update": {
      const { rows } = await db.query(
        `UPDATE boards SET title = $2, updated_at = now() WHERE id = $1 RETURNING ${BOARD_COLS}`,
        [boardId, req.payload.title],
      );
      return { type: req.type, payload: { board: rows[0] } };
    }
    case "column.create": {
      const { rows } = await db.query<Column>(
        `INSERT INTO columns (id, board_id, title, position) VALUES ($1, $2, $3, $4) RETURNING ${COLUMN_COLS}`,
        [req.payload.id, boardId, req.payload.title, await endOfBoard(db, boardId)],
      );
      return { type: req.type, payload: { column: rows[0]! } };
    }
    case "column.update": {
      await requireColumn(db, me, req.payload.columnId, "editor", true);
      const { rows } = await db.query<Column>(`UPDATE columns SET title = $2 WHERE id = $1 RETURNING ${COLUMN_COLS}`, [
        req.payload.columnId,
        req.payload.title,
      ]);
      return { type: req.type, payload: { column: rows[0]! } };
    }
    case "column.delete": {
      // Không cho xóa cột còn thẻ: xóa dây chuyền sẽ làm mất thẻ người khác vừa thêm.
      const { columnId } = req.payload;
      await requireColumn(db, me, columnId, "editor", true);
      const { rows } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM cards WHERE column_id = $1 AND deleted_at IS NULL",
        [columnId],
      );
      if (rows[0]!.n > 0) {
        throw new HttpError(409, "column_not_empty", "This column still has cards. Move or delete them first");
      }
      await db.query("DELETE FROM columns WHERE id = $1", [columnId]);
      return { type: req.type, payload: { columnId } };
    }
    case "card.create": {
      const { id, columnId, title } = req.payload;
      // Khóa cột và lấy vị trí cuối cột (tính cả thẻ đã xóa mềm) trong cùng một lượt gọi DB.
      const col = await db.query<{ max: string | null }>(
        `SELECT (SELECT max(position) FROM cards WHERE column_id = c.id) AS max
           FROM columns c WHERE c.id = $1 FOR UPDATE OF c`,
        [columnId],
      );
      if (!col.rows[0]) throw notFound();
      const { rows } = await db.query(
        `INSERT INTO cards AS k (id, board_id, column_id, title, position, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING ${CARD_COLS}`,
        [id, boardId, columnId, title, positionBetween(col.rows[0].max, null), me],
      );
      return { type: req.type, payload: { card: toCard(rows[0]) } };
    }
    case "card.update":
      return updateCard(db, me, req.payload);
    case "card.move":
      return moveCard(db, me, req.payload);
    case "card.delete": {
      // Xóa mềm: thẻ vẫn còn trong DB để khôi phục và để báo cho người đang sửa dở.
      await requireCard(db, me, req.payload.cardId, "editor", true);
      const { rows } = await db.query(
        `UPDATE cards AS k SET deleted_at = now(), deleted_by = $2, version = version + 1, updated_by = $2, updated_at = now()
          WHERE k.id = $1 AND k.deleted_at IS NULL RETURNING ${CARD_COLS}`,
        [req.payload.cardId, me],
      );
      // Đã bị xóa từ trước thì không đổi gì: trả lại thẻ như hiện tại.
      return { type: req.type, payload: { card: rows[0] ? toCard(rows[0]) : await getCard(db, req.payload.cardId) } };
    }
    case "card.restore": {
      await requireCard(db, me, req.payload.cardId, "editor", true);
      const { rows } = await db.query(
        `UPDATE cards AS k SET deleted_at = NULL, deleted_by = NULL, version = version + 1, updated_by = $2, updated_at = now()
          WHERE k.id = $1 AND k.deleted_at IS NOT NULL RETURNING ${CARD_COLS}`,
        [req.payload.cardId, me],
      );
      return { type: req.type, payload: { card: rows[0] ? toCard(rows[0]) : await getCard(db, req.payload.cardId) } };
    }
  }
}

// ---------- Chạy một thao tác ----------

/** opId đã có trong bảng operations (ném ra trong transaction để rollback phần seq vừa lấy). */
class DuplicateOp extends Error {
  constructor(public op: BoardOp) {
    super("duplicate op");
  }
}

export interface ExecuteResult {
  op: BoardOp;
  /** opId này đã được xử lý trước đó: trả lại đúng kết quả cũ, KHÔNG phát lại. */
  duplicate: boolean;
}

/**
 * opId gửi lại (client mất kết nối trước khi nhận được ack) → trả lại kết quả cũ, không báo lỗi.
 * Nhưng chỉ khi đúng là thao tác đó của chính người này trên chính bảng này; nếu không, người khác
 * có thể đoán/nghe được opId rồi gửi lại để đọc kết quả của một bảng mình không có quyền.
 */
function duplicateOf(op: BoardOp, me: string, req: OpRequest, expectedBoardId?: string): ExecuteResult {
  if (op.actorId !== me || op.type !== req.type || (expectedBoardId !== undefined && op.boardId !== expectedBoardId)) {
    throw new HttpError(409, "op_id_taken", "This operation id was already used for a different operation");
  }
  return { op, duplicate: true };
}

/**
 * Chạy một thao tác: kiểm tra quyền, lấy seq, ghi DB, ghi nhật ký operations — tất cả trong một
 * transaction. Nơi gọi phải phát `op` cho phòng của bảng SAU khi hàm này trả về (nếu không trùng).
 *
 * @param expectedBoardId bảng client nói là đang thao tác (qua socket). Không dùng để kiểm tra quyền,
 *   chỉ để từ chối nếu thẻ/cột thực ra thuộc bảng khác.
 */
export async function executeOp(me: string, req: OpRequest, expectedBoardId?: string): Promise<ExecuteResult> {
  // Không tra opId trước transaction (tốn thêm một lượt gọi DB cho MỌI thao tác). Thao tác gửi lại được
  // nhận ra bên trong transaction sau khi khóa bảng; riêng trường hợp thẻ/cột đã bị xóa hẳn (không tìm
  // ra bảng) thì tra ở nhánh lỗi bên dưới.
  try {
    return await withTx(async (c) => {
      const boardId = await boardAccessOf(c, me, req);
      if (expectedBoardId !== undefined && boardId !== expectedBoardId) throw notFound();

      const { rows } = await c.query<{ seq: number }>(
        "UPDATE boards SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq AS seq",
        [boardId],
      );
      const seq = rows[0]!.seq;
      // Kiểm tra lại khi đã giữ khóa bảng: hai lần gửi cùng opId chạy song song thì lần sau
      // phải chờ lần trước commit, và tới đây sẽ thấy nó.
      const again = await findOp(c, req.opId);
      if (again) throw new DuplicateOp(again);

      const result = await run(c, me, boardId, req);
      const inserted = await c.query(
        `INSERT INTO operations (board_id, seq, op_id, actor_id, type, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING ${OP_COLS}`,
        [boardId, seq, req.opId, me, result.type, JSON.stringify(result.payload)],
      );
      return { op: toOp(inserted.rows[0]), duplicate: false };
    });
  } catch (err) {
    if (err instanceof DuplicateOp) return duplicateOf(err.op, me, req, expectedBoardId);
    if (err instanceof HttpError && err.status === 404) {
      // Gửi lại một thao tác mà thẻ/cột của nó nay đã bị xóa hẳn (vd. xóa cột): trả lại kết quả cũ.
      const op = await findOp(pool, req.opId);
      if (op) return duplicateOf(op, me, req, expectedBoardId);
    }
    if (isPgError(err, UNIQUE_VIOLATION, "operations_op_id_key")) {
      // Cùng opId được gửi song song vào hai bảng khác nhau: lần sau đụng chỉ mục UNIQUE.
      const op = await findOp(pool, req.opId);
      if (op) return duplicateOf(op, me, req, expectedBoardId);
    }
    if (isPgError(err, UNIQUE_VIOLATION)) throw idTaken();
    throw err;
  }
}
