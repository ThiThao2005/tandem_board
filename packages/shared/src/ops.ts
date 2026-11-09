import { z } from "zod";
import { comparePositioned, positionBetween } from "./position";
import type { BoardPresence, PresenceUpdateInput } from "./presence";
import {
  boardInput,
  cardCreateInput,
  cardMoveInput,
  cardUpdateFields,
  columnCreateInput,
  columnUpdateInput,
  hasCardChange,
  type Board,
  type BoardSnapshot,
  type Card,
  type CardMoveResult,
  type Column,
  type Role,
} from "./schemas";

/*
 * Giao thức đồng bộ (tuần 3).
 *
 *   client → server:  { boardId, opId, type, payload }        — chỉ là YÊU CẦU
 *   server:           kiểm tra quyền (suy ra bảng từ thẻ/cột, không tin boardId client gửi)
 *                     → BEGIN → last_seq + 1 → làm thao tác → INSERT operations → COMMIT
 *                     → phát cho phòng board:{id}             — chỉ phát SAU khi commit
 *   server → mọi người: BoardOp { seq, opId, actorId, type, payload }
 *                     payload là KẾT QUẢ server đã quyết định (thẻ sau khi sửa, vị trí server tính…),
 *                     nên mọi client áp dụng cùng một dãy thao tác đều ra cùng một bảng.
 */

const uuid = z.string().uuid();

function op<T extends string, P extends z.ZodTypeAny>(type: T, payload: P) {
  return z.object({ opId: uuid, type: z.literal(type), payload });
}

/** Thao tác client gửi lên. opId do client sinh (UUID) để server bỏ qua khi bị gửi lại. */
export const opRequest = z.discriminatedUnion("type", [
  op("board.update", z.object({ boardId: uuid, title: boardInput.shape.title })),
  op("column.create", z.object({ boardId: uuid, id: uuid, title: columnCreateInput.shape.title })),
  op("column.update", z.object({ columnId: uuid, title: columnUpdateInput.shape.title })),
  op("column.delete", z.object({ columnId: uuid })),
  op("card.create", z.object({ columnId: uuid, id: uuid, title: cardCreateInput.shape.title })),
  op("card.update", cardUpdateFields.extend({ cardId: uuid }).refine(hasCardChange, { message: "Nothing to update" })),
  op("card.move", cardMoveInput.extend({ cardId: uuid })),
  op("card.delete", z.object({ cardId: uuid })),
  op("card.restore", z.object({ cardId: uuid })),
]);
/** Sau khi qua zod (đã điền giá trị mặc định). */
export type OpRequest = z.output<typeof opRequest>;
/** Client gửi lên (có thể bỏ trống trường có mặc định). */
export type OpRequestInput = z.input<typeof opRequest>;
export type OpType = OpRequest["type"];
export type OpPayload<T extends OpType> = Extract<OpRequest, { type: T }>["payload"];

/** Kết quả server đã quyết định — đây là thứ được lưu vào bảng operations và phát cho mọi người. */
export type OpResult =
  | { type: "board.update"; payload: { board: Board } }
  | { type: "column.create" | "column.update"; payload: { column: Column } }
  | { type: "column.delete"; payload: { columnId: string } }
  | { type: "card.create" | "card.update" | "card.delete" | "card.restore"; payload: { card: Card } }
  | { type: "card.move"; payload: CardMoveResult };

/** payload kết quả của một loại thao tác. (Extract không dùng được vì vài nhánh gộp nhiều type.) */
export type ResultPayload<T extends OpType> = (OpResult & { type: T })["payload"];

export type BoardOp = OpResult & {
  /** Tăng liên tục 1, 2, 3… riêng cho từng bảng, không có lỗ. */
  seq: number;
  opId: string;
  boardId: string;
  actorId: string | null;
  createdAt: string;
};

/** Lỡ nhiều hơn chừng này thao tác thì gửi ảnh chụp cả bảng thay vì gửi từng thao tác. */
export const MAX_CATCHUP_OPS = 500;

/** Phần gửi bù khi client vào bảng (hoặc kết nối lại) với lastSeq của mình. */
export type CatchUp = { kind: "ops"; ops: BoardOp[] } | { kind: "snapshot"; snapshot: BoardSnapshot };

// ---------- Sự kiện Socket.IO ----------

export const boardJoinInput = z.object({
  boardId: uuid,
  /** seq cuối client đang có; null = chưa có gì, server gửi ảnh chụp. */
  lastSeq: z.number().int().min(0).nullable().default(null),
});
export type BoardJoinInput = z.input<typeof boardJoinInput>;

export interface SocketErrorBody {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export type Ack<T extends object = object> = ({ ok: true } & T) | { ok: false; error: SocketErrorBody };

export type OpAck = Ack<{ op: BoardOp; duplicate: boolean }>;
export type JoinAck = Ack<{ role: Role; catchUp: CatchUp }>;

/** Mã lỗi trong `connect_error` (err.data.code) và sự kiện ngắt kết nối. */
export const SOCKET_AUTH_ERRORS = ["unauthorized", "token_expired"] as const;

export interface ServerToClientEvents {
  op: (op: BoardOp) => void;
  /** Access token đã hết hạn mà client không gửi auth.refresh: server sẽ ngắt kết nối ngay sau đó. */
  "session.expired": () => void;
  /** Bị xóa khỏi nhóm: server đã đưa socket ra khỏi phòng của các bảng này. */
  "access.revoked": (msg: { workspaceId: string; boardIds: string[] }) => void;
  /** Vai trò trong nhóm đổi (vd. editor → viewer). */
  "access.role": (msg: { workspaceId: string; role: Role }) => void;
  /** Danh sách thành viên nhóm đổi (ai đó vào/rời nhóm). */
  "members.changed": (msg: { workspaceId: string }) => void;
  "board.deleted": (msg: { boardId: string }) => void;
  /** Danh sách người đang ở trên bảng (cả danh sách, gửi mỗi khi nó đổi và ngay sau khi vào bảng). */
  presence: (msg: BoardPresence) => void;
}

export interface ClientToServerEvents {
  "board.join": (msg: BoardJoinInput, ack: (res: JoinAck) => void) => void;
  "board.leave": (msg: { boardId: string }) => void;
  op: (msg: OpRequestInput & { boardId: string }, ack: (res: OpAck) => void) => void;
  "auth.refresh": (token: string, ack: (res: Ack) => void) => void;
  /** Trạng thái của tab này trên bảng: vừa là thông báo thay đổi vừa là heartbeat. Ack không bắt buộc. */
  "presence.update": (msg: PresenceUpdateInput, ack?: (res: Ack) => void) => void;
}

// ---------- Áp dụng thao tác ----------

/** Phần của ảnh chụp bị thao tác làm thay đổi. */
export interface BoardState {
  seq: number;
  board: Board;
  columns: Column[];
  cards: Card[];
}

function upsert<T extends { id: string; position: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  const next = i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
  return next.sort(comparePositioned);
}

/** Sắp xếp giống server (`ORDER BY position, id`) để hai bên so sánh được từng phần tử. */
export function sortState<S extends BoardState>(s: S): S {
  return { ...s, columns: [...s.columns].sort(comparePositioned), cards: [...s.cards].sort(comparePositioned) };
}

/** Áp dụng kết quả server trả về. Thuần (không đổi `state`), và áp dụng hai lần cũng như một lần. */
export function applyResult<S extends BoardState>(s: S, r: OpResult): S {
  switch (r.type) {
    case "board.update":
      return { ...s, board: r.payload.board };
    case "column.create":
    case "column.update":
      return { ...s, columns: upsert(s.columns, r.payload.column) };
    case "column.delete": {
      const id = r.payload.columnId;
      return { ...s, columns: s.columns.filter((c) => c.id !== id), cards: s.cards.filter((k) => k.columnId !== id) };
    }
    case "card.create":
    case "card.update":
    case "card.delete":
    case "card.restore": {
      const card = r.payload.card;
      // Ảnh chụp chỉ chứa thẻ chưa xóa.
      return { ...s, cards: card.deletedAt ? s.cards.filter((k) => k.id !== card.id) : upsert(s.cards, card) };
    }
    case "card.move": {
      const moved = new Map(r.payload.rebalanced.map((x) => [x.id, x.position]));
      // rebalanced là vị trí mới của MỌI thẻ trong cột (kể cả thẻ vừa kéo), nên áp dụng cho tất cả.
      const cards = upsert(s.cards, r.payload.card).map((k) => {
        const position = moved.get(k.id);
        return position === undefined ? k : { ...k, position };
      });
      return { ...s, cards: cards.sort(comparePositioned) };
    }
  }
}

/** Áp dụng một thao tác đã có seq. Gọi đúng thứ tự seq — kiểm tra thứ tự là việc của BoardReplica. */
export function applyOp<S extends BoardState>(s: S, op: BoardOp): S {
  return { ...applyResult(s, op), seq: op.seq };
}

// ---------- Cập nhật lạc quan ----------

export type Optimistic = <S extends BoardState>(s: S) => S;

export interface OptimisticContext {
  userId: string;
  now?: string;
  /** Dữ liệu thẻ để hiện lại ngay khi khôi phục (thẻ đã xóa không còn trong ảnh chụp). */
  restoreCard?: Card;
}

function endOf(list: { position: string }[]): string {
  let max: string | null = null;
  for (const x of list) if (max === null || x.position > max) max = x.position;
  return positionBetween(max, null);
}

function mapCard<S extends BoardState>(s: S, id: string, fn: (k: Card) => Card): S {
  return s.cards.some((k) => k.id === id) ? { ...s, cards: s.cards.map((k) => (k.id === id ? fn(k) : k)) } : s;
}

/**
 * Hàm cập nhật lạc quan cho một yêu cầu: client hiện kết quả ngay, chưa chờ server.
 *
 * Vị trí được tính MỘT LẦN ở đây (từ `view` lúc người dùng thao tác) rồi đóng gói vào hàm trả về,
 * vì hàm này bị gọi lại mỗi khi có thao tác mới từ server (xem BoardReplica.view) — tính lại thì
 * phần jitter ngẫu nhiên sẽ khác mỗi lần.
 *
 * Hàm trả về phải chịu được việc trạng thái đã đổi (thẻ đã bị người khác xóa, cột không còn…):
 * khi đó không làm gì, và server sẽ từ chối yêu cầu.
 */
export function optimisticUpdate(view: BoardState, req: OpRequest, ctx: OptimisticContext): Optimistic {
  const now = ctx.now ?? new Date().toISOString();
  switch (req.type) {
    case "board.update": {
      const { title } = req.payload;
      return (s) => ({ ...s, board: { ...s.board, title } });
    }
    case "column.create": {
      const column: Column = { id: req.payload.id, boardId: req.payload.boardId, title: req.payload.title, position: endOf(view.columns) };
      return (s) => (s.columns.some((c) => c.id === column.id) ? s : { ...s, columns: upsert(s.columns, column) });
    }
    case "column.update": {
      const { columnId, title } = req.payload;
      return (s) => ({ ...s, columns: s.columns.map((c) => (c.id === columnId ? { ...c, title } : c)) });
    }
    case "column.delete": {
      const { columnId } = req.payload;
      return (s) => ({ ...s, columns: s.columns.filter((c) => c.id !== columnId) });
    }
    case "card.create": {
      const { id, columnId, title } = req.payload;
      const card: Card = {
        id,
        boardId: view.board.id,
        columnId,
        title,
        dueDate: null,
        assigneeId: null,
        position: endOf(view.cards.filter((k) => k.columnId === columnId)),
        version: 1,
        deletedAt: null,
        updatedAt: now,
        updatedBy: ctx.userId,
      };
      return (s) =>
        s.cards.some((k) => k.id === id) || !s.columns.some((c) => c.id === columnId) ? s : { ...s, cards: upsert(s.cards, card) };
    }
    case "card.update": {
      const { cardId, title, dueDate, assigneeId, columnId } = req.payload;
      const current = view.cards.find((k) => k.id === cardId);
      const position =
        columnId !== undefined && columnId !== current?.columnId
          ? endOf(view.cards.filter((k) => k.columnId === columnId))
          : undefined;
      return (s) =>
        mapCard(s, cardId, (k) => ({
          ...k,
          ...(title !== undefined && { title }),
          ...(dueDate !== undefined && { dueDate }),
          ...(assigneeId !== undefined && { assigneeId }),
          ...(position !== undefined && columnId !== undefined && { columnId, position }),
        }));
    }
    case "card.move": {
      const { cardId, columnId, afterCardId, beforeCardId } = req.payload;
      const pos = (id: string | null) => (id === null ? null : (view.cards.find((k) => k.id === id)?.position ?? null));
      let position: string;
      try {
        position =
          afterCardId === null && beforeCardId === null
            ? endOf(view.cards.filter((k) => k.columnId === columnId && k.id !== cardId))
            : positionBetween(pos(afterCardId), pos(beforeCardId));
      } catch {
        // Hai hàng xóm trùng vị trí (rất hiếm): không cập nhật lạc quan, chờ server.
        return (s) => s;
      }
      return (s) => mapCard(s, cardId, (k) => ({ ...k, columnId, position }));
    }
    case "card.delete": {
      const { cardId } = req.payload;
      return (s) => ({ ...s, cards: s.cards.filter((k) => k.id !== cardId) });
    }
    case "card.restore": {
      const card = ctx.restoreCard;
      if (!card || card.id !== req.payload.cardId) return (s) => s;
      const restored = { ...card, deletedAt: null };
      return (s) =>
        s.cards.some((k) => k.id === card.id) || !s.columns.some((c) => c.id === card.columnId)
          ? s
          : { ...s, cards: upsert(s.cards, restored) };
    }
  }
}

/** Ảnh chụp chỉ gồm phần trạng thái bảng (bỏ role, members) — dùng để so sánh trong test hội tụ. */
export function boardState(s: BoardSnapshot): BoardState {
  return { seq: s.seq, board: s.board, columns: s.columns, cards: s.cards };
}
