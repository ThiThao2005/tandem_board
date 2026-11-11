import type { BoardState, OpRequest, OptimisticContext } from "./ops";
import type { Card, Member } from "./schemas";

/*
 * Hàng đợi offline (tuần 6) — lõi không làm I/O: nơi lưu (IndexedDB trong trình duyệt, bộ nhớ trong test)
 * được truyền vào qua `OutboxStorage`, nên logic "ai gửi hàng đợi nào" test được trong Node.
 *
 * Mỗi thay đổi chưa được server xác nhận nằm trong hàng đợi, kèm opId do client sinh. Tải lại trang, đóng
 * tab hay mất mạng đều không làm mất nó; gửi lại cùng opId là an toàn vì server chống ghi trùng (tuần 3).
 */

/** Một thay đổi chưa gửi, đã lưu xuống đĩa. */
export interface OutboxRecord {
  opId: string;
  userId: string;
  boardId: string;
  request: OpRequest;
  /** Thẻ cần để dựng lại bản lạc quan của "khôi phục thẻ" sau khi tải lại trang (thẻ đã xóa không còn trong ảnh chụp). */
  restoreCard?: Card;
  /** Mô tả cho người đọc ("Rename card “A” to “B”"), chụp lúc người dùng thao tác — sau này thẻ có thể đã biến mất. */
  label: string;
  queuedAt: string;
  /** Tab đang giữ bản ghi này (chỉ tab đó gửi nó). */
  owner: string;
  /** Thứ tự xếp hàng toàn cục, do nơi lưu gán, tăng dần. */
  order: number;
}

export type NewOutboxRecord = Omit<OutboxRecord, "order">;

/** Lỗi server trả về cho một thao tác bị từ chối (cùng dạng SocketErrorBody). */
export interface FailedError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

/** Thao tác bị server từ chối: giữ lại để người dùng xem và quyết định, không âm thầm bỏ đi. */
export interface FailedOp {
  opId: string;
  userId: string;
  boardId: string;
  request: OpRequest;
  restoreCard?: Card;
  label: string;
  error: FailedError;
  failedAt: string;
}

export interface OutboxStorage {
  add(rec: NewOutboxRecord): Promise<void>;
  remove(opIds: string[]): Promise<void>;
  /**
   * NGUYÊN TỬ: nhận về các bản ghi của (user, bảng) mà `me` được phép gửi — bản ghi của chính `me`, và của
   * tab đã chết (chủ không nằm trong `liveOwners`; `null` = không biết tab nào còn sống thì coi mọi tab khác
   * là đã chết) — rồi đổi chủ thành `me`. Hai tab gọi cùng lúc thì mỗi bản ghi chỉ về một tab.
   */
  claim(userId: string, boardId: string, me: string, liveOwners: ReadonlySet<string> | null): Promise<OutboxRecord[]>;
  addFailed(rec: FailedOp): Promise<void>;
  listFailed(userId: string, boardId: string): Promise<FailedOp[]>;
  removeFailed(opIds: string[]): Promise<void>;
}

/** Nơi lưu trong bộ nhớ: dùng cho test, và làm phương án dự phòng khi trình duyệt không cho dùng IndexedDB. */
export class MemoryOutboxStorage implements OutboxStorage {
  private records: OutboxRecord[] = [];
  private failed: FailedOp[] = [];
  private counter = 0;

  async add(rec: NewOutboxRecord) {
    this.records.push({ ...rec, order: ++this.counter });
  }

  async remove(opIds: string[]) {
    const gone = new Set(opIds);
    this.records = this.records.filter((r) => !gone.has(r.opId));
  }

  async claim(userId: string, boardId: string, me: string, liveOwners: ReadonlySet<string> | null) {
    const taken: OutboxRecord[] = [];
    this.records = this.records.map((r) => {
      if (r.userId !== userId || r.boardId !== boardId) return r;
      if (r.owner !== me && liveOwners?.has(r.owner)) return r;
      const mine = { ...r, owner: me };
      taken.push(mine);
      return mine;
    });
    return taken.sort((a, b) => a.order - b.order);
  }

  async addFailed(rec: FailedOp) {
    this.failed = [...this.failed.filter((f) => f.opId !== rec.opId), rec];
  }

  async listFailed(userId: string, boardId: string) {
    return this.failed.filter((f) => f.userId === userId && f.boardId === boardId);
  }

  async removeFailed(opIds: string[]) {
    const gone = new Set(opIds);
    this.failed = this.failed.filter((f) => !gone.has(f.opId));
  }

  /** Cho test: mọi bản ghi đang lưu, theo thứ tự. */
  all(): OutboxRecord[] {
    return [...this.records].sort((a, b) => a.order - b.order);
  }
}

export interface OutboxOptions {
  storage: OutboxStorage;
  userId: string;
  boardId: string;
  /** Định danh tab này (mỗi lần tải trang một giá trị mới). */
  tabId: string;
  /** Các tab đang sống (Web Locks). null = trình duyệt không cho biết. */
  liveTabs: () => Promise<ReadonlySet<string> | null>;
  /** Ghi xuống đĩa lỗi (hết dung lượng, chế độ riêng tư…): hàng đợi vẫn chạy được nhưng sẽ mất nếu tải lại trang. */
  onStorageError?: (err: unknown) => void;
}

/**
 * Hàng đợi của MỘT bảng, ở MỘT tab. Giữ danh sách opId đã ghi xuống đĩa (`tracked`) và đồng bộ nó với hàng
 * chờ của BoardReplica: có trong hàng chờ thì phải có trên đĩa, rời hàng chờ (đã xác nhận / bị từ chối / đã nằm
 * trong ảnh chụp) thì xóa khỏi đĩa.
 *
 * Mọi thao tác ghi đi qua MỘT chuỗi promise nên thứ tự ghi đúng thứ tự gọi (không có chuyện "xóa" tới trước "thêm").
 */
export class Outbox {
  private tracked = new Set<string>();
  /** opId đã xóa khỏi đĩa: lần `claim` sau (khi lần xóa chưa kịp xong) không được nhận lại thao tác đã xong. */
  private settled = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private broken = false;

  constructor(private readonly o: OutboxOptions) {}

  /** false khi ghi xuống đĩa đã lỗi: thay đổi chưa gửi sẽ mất nếu tải lại trang. */
  get durable(): boolean {
    return !this.broken;
  }

  get userId() {
    return this.o.userId;
  }

  private run(fn: () => Promise<unknown>): Promise<void> {
    const next = this.chain.then(fn).then(
      () => undefined,
      (err: unknown) => {
        this.broken = true;
        this.o.onStorageError?.(err);
      },
    );
    this.chain = next;
    return next;
  }

  /** Chờ mọi lần ghi đang chạy xong (cho test, và trước khi đóng). */
  idle(): Promise<void> {
    return this.run(async () => {});
  }

  /** Thao tác mới của người dùng: ghi xuống đĩa NGAY (gọi đồng bộ cùng lúc với việc thêm vào hàng chờ). */
  queue(request: OpRequest, label: string, restoreCard?: Card, now = new Date()): void {
    const { opId } = request;
    this.tracked.add(opId);
    const rec: NewOutboxRecord = {
      opId,
      userId: this.o.userId,
      boardId: this.o.boardId,
      request,
      label,
      queuedAt: now.toISOString(),
      owner: this.o.tabId,
      ...(restoreCard && { restoreCard }),
    };
    void this.run(() => this.o.storage.add(rec));
  }

  /** Nhận các thay đổi còn trên đĩa mà tab này được phép gửi (của lần tải trang trước, hoặc của tab đã đóng). */
  async claim(): Promise<OutboxRecord[]> {
    let taken: OutboxRecord[] = [];
    await this.run(async () => {
      const live = await this.o.liveTabs().catch(() => null);
      taken = await this.o.storage.claim(this.o.userId, this.o.boardId, this.o.tabId, live);
    });
    taken = taken.filter((r) => !this.settled.has(r.opId));
    for (const r of taken) this.tracked.add(r.opId);
    return taken;
  }

  /** Hàng chờ hiện tại có những opId này: xóa khỏi đĩa mọi thứ đã rời hàng chờ. */
  retain(pending: Iterable<string>): void {
    const keep = new Set(pending);
    const gone = [...this.tracked].filter((id) => !keep.has(id));
    if (gone.length === 0) return;
    for (const id of gone) {
      this.tracked.delete(id);
      this.settled.add(id);
    }
    void this.run(() => this.o.storage.remove(gone));
  }

  /** Ghi lại thao tác bị từ chối. Gọi TRƯỚC khi thao tác rời hàng chờ: sập giữa chừng thì còn bản gửi lại, không mất. */
  fail(failed: FailedOp): void {
    void this.run(() => this.o.storage.addFailed(failed));
  }

  async listFailed(): Promise<FailedOp[]> {
    let list: FailedOp[] = [];
    await this.run(async () => {
      list = await this.o.storage.listFailed(this.o.userId, this.o.boardId);
    });
    return list;
  }

  dismissFailed(opIds: string[]): void {
    void this.run(() => this.o.storage.removeFailed(opIds));
  }
}

// ---------- Mô tả thao tác cho người đọc ----------

const clip = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const quote = (s: string) => `“${clip(s)}”`;

/**
 * Câu mô tả một yêu cầu, dựng từ trạng thái bảng LÚC NGƯỜI DÙNG THAO TÁC (sau này thẻ có thể đã bị xóa nên không
 * tra lại được tên). Giữ nguyên chữ người dùng gõ, để thao tác bị từ chối thì vẫn chép lại được.
 */
export function describeRequest(
  view: BoardState & { members?: Member[] },
  req: OpRequest,
  ctx: Pick<OptimisticContext, "restoreCard"> = {},
): string {
  const cardTitle = (id: string) => {
    const t = view.cards.find((k) => k.id === id)?.title ?? (ctx.restoreCard?.id === id ? ctx.restoreCard.title : undefined);
    return t === undefined ? "a card" : quote(t);
  };
  const columnTitle = (id: string) => {
    const t = view.columns.find((c) => c.id === id)?.title;
    return t === undefined ? "a column" : quote(t);
  };
  switch (req.type) {
    case "board.update":
      return `Rename the board to ${quote(req.payload.title)}`;
    case "column.create":
      return `Add column ${quote(req.payload.title)}`;
    case "column.update":
      return `Rename column ${columnTitle(req.payload.columnId)} to ${quote(req.payload.title)}`;
    case "column.delete":
      return `Delete column ${columnTitle(req.payload.columnId)}`;
    case "card.create":
      return `Add card ${quote(req.payload.title)} to ${columnTitle(req.payload.columnId)}`;
    case "card.update": {
      const { cardId, title, dueDate, assigneeId, columnId } = req.payload;
      const parts: string[] = [];
      if (title !== undefined) parts.push(`title to ${quote(title)}`);
      if (dueDate !== undefined) parts.push(dueDate === null ? "clear the due date" : `due date to ${dueDate}`);
      if (assigneeId !== undefined) {
        const name = view.members?.find((m) => m.id === assigneeId)?.displayName;
        parts.push(assigneeId === null ? "unassign" : `assignee to ${name ?? "a member"}`);
      }
      if (columnId !== undefined) parts.push(`column to ${columnTitle(columnId)}`);
      return `Change ${cardTitle(cardId)}: ${parts.join(", ")}`;
    }
    case "card.move":
      return `Move ${cardTitle(req.payload.cardId)} to ${columnTitle(req.payload.columnId)}`;
    case "card.delete":
      return `Delete card ${cardTitle(req.payload.cardId)}`;
    case "card.restore":
      return `Restore card ${cardTitle(req.payload.cardId)}`;
  }
}

// ---------- Thử lại thao tác bị từ chối ----------

/** Mã lỗi mà thử lại cũng vô ích (hoặc không được phép): chỉ cho bỏ qua. */
const NOT_RETRYABLE = new Set(["forbidden", "not_found", "invalid_input", "id_taken", "op_id_taken", "unauthorized"]);

/** Lỗi tạm thời: client tự gửi lại, không hiện cho người dùng như một thay đổi bị từ chối. */
export function isTransientError(error: { status: number; code: string }): boolean {
  return error.code === "rate_limited" || error.code === "busy" || error.status >= 500;
}

export interface RetryOption {
  /** Chữ trên nút. */
  label: string;
  /** Các yêu cầu mới (opId mới) sẽ được gửi lần lượt. */
  requests: (newId: () => string) => OpRequest[];
}

/** Cách thử lại hợp lý cho một thao tác bị từ chối, hoặc null nếu chỉ nên bỏ qua. */
export function retryOption(f: FailedOp): RetryOption | null {
  const { request, error } = f;
  if (NOT_RETRYABLE.has(error.code)) return null;

  if (error.code === "version_conflict" && request.type === "card.update") {
    // "Dùng bản của tôi": ghi đè, tức bỏ baseVersion.
    const { baseVersion: _drop, ...payload } = request.payload;
    return { label: "Use mine", requests: (newId) => [{ ...request, opId: newId(), payload }] };
  }
  if (error.code === "card_deleted" && "cardId" in request.payload) {
    const cardId = request.payload.cardId;
    return {
      label: "Restore card and apply",
      requests: (newId) => [
        { opId: newId(), type: "card.restore", payload: { cardId } },
        { ...request, opId: newId() } as OpRequest,
      ],
    };
  }
  return { label: "Try again", requests: (newId) => [{ ...request, opId: newId() } as OpRequest] };
}
