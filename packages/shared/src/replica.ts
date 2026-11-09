import { applyOp, sortState, type BoardOp, type Optimistic, type OpRequest } from "./ops";
import type { BoardSnapshot } from "./schemas";

export interface PendingOp {
  request: OpRequest;
  /** Cập nhật lạc quan, áp lên trạng thái đã xác nhận mỗi lần tính lại `view`. */
  apply: Optimistic;
}

export type ReceiveResult = "applied" | "stale" | "gap";

/**
 * Bản sao của một bảng ở phía client. Không làm I/O: phần nối mạng (Socket.IO) bọc bên ngoài,
 * nên lõi này test được trong Node và dùng chung cho web lẫn test hội tụ phía server.
 *
 *  - `confirmed`: ảnh chụp + mọi thao tác server đã phát, áp dụng ĐÚNG thứ tự seq.
 *  - `pending`:   thao tác của mình chưa được xác nhận (cập nhật lạc quan).
 *  - `view`:      confirmed rồi áp lần lượt các pending lên trên — thứ người dùng nhìn thấy.
 *
 * Vì `view` luôn được tính lại từ `confirmed`, thao tác của người khác tới trong lúc mình đang chờ
 * không bị cập nhật lạc quan đè mất, và khi server từ chối thì chỉ cần bỏ pending đi là bảng tự về
 * đúng trạng thái (không phải tự viết thao tác ngược).
 */
export class BoardReplica {
  private confirmed: BoardSnapshot;
  /** Thao tác tới sớm (seq nhảy cóc), chờ phần còn thiếu. */
  private buffer = new Map<number, BoardOp>();
  private pending: PendingOp[] = [];
  private cachedView: BoardSnapshot | null = null;

  constructor(snapshot: BoardSnapshot) {
    this.confirmed = sortState(snapshot);
  }

  get seq(): number {
    return this.confirmed.seq;
  }

  /** Trạng thái đã được server xác nhận. */
  get state(): BoardSnapshot {
    return this.confirmed;
  }

  get pendingOps(): readonly PendingOp[] {
    return this.pending;
  }

  /** Đang thiếu thao tác (đã nhận seq lớn hơn seq + 1). */
  get hasGap(): boolean {
    return this.buffer.size > 0;
  }

  /** Giữ nguyên object khi không có gì đổi, để React không vẽ lại thừa. */
  get view(): BoardSnapshot {
    this.cachedView ??= sortState(this.pending.reduce((s, p) => p.apply(s), this.confirmed));
    return this.cachedView;
  }

  /**
   * Nhận một thao tác server phát.
   *  - seq ≤ seq hiện tại: đã có rồi (nhận trùng, hoặc đã nằm trong ảnh chụp) → bỏ qua.
   *  - seq = seq hiện tại + 1: áp dụng, rồi áp tiếp các thao tác đang chờ trong buffer nếu nối tiếp được.
   *  - lớn hơn: giữ lại, báo "gap" để bên ngoài đi lấy bù phần thiếu.
   */
  receive(op: BoardOp): ReceiveResult {
    if (op.seq <= this.confirmed.seq) return "stale";
    if (op.seq > this.confirmed.seq + 1) {
      this.buffer.set(op.seq, op);
      return "gap";
    }
    this.applyConfirmed(op);
    this.drain();
    return "applied";
  }

  /** Thay bằng ảnh chụp mới (khi lỡ quá nhiều thao tác). Thao tác của mình đang chờ vẫn được giữ. */
  reset(snapshot: BoardSnapshot) {
    this.confirmed = sortState(snapshot);
    for (const [seq, op] of this.buffer) {
      if (seq > snapshot.seq) continue;
      this.buffer.delete(seq);
      // Thao tác này đã nằm trong ảnh chụp. Nếu là của mình (ack tới lúc đang thiếu seq nên nằm trong
      // buffer) thì bỏ khỏi hàng chờ luôn: bản phát của nó sẽ không bao giờ tới nữa, và bên gửi đã đánh
      // dấu là đã ack nên cũng không gửi lại. Không bỏ thì bản lạc quan cũ đè lên ảnh chụp mãi mãi.
      this.pending = this.pending.filter((p) => p.request.opId !== op.opId);
    }
    this.drain();
    this.changed();
  }

  /** Đổi phần không do thao tác quyết định (danh sách thành viên, vai trò của mình). */
  patch(meta: Partial<Pick<BoardSnapshot, "members" | "role">>) {
    this.confirmed = { ...this.confirmed, ...meta };
    this.changed();
  }

  add(op: PendingOp) {
    this.pending = [...this.pending, op];
    this.changed();
  }

  /**
   * Server đã nhận thao tác (ack). Thường bản phát của chính thao tác này đã tới trước ack và nó đã
   * được bỏ khỏi pending. Còn nếu ack tới trước (hoặc đây là opId gửi lại, server trả kết quả cũ),
   * thì áp dụng luôn để không phải chờ.
   */
  acknowledge(op: BoardOp) {
    if (this.receive(op) === "stale") this.drop(op.opId);
  }

  /** Server từ chối: bỏ cập nhật lạc quan, bảng tự về trạng thái đã xác nhận. */
  reject(opId: string) {
    this.drop(opId);
  }

  private drop(opId: string) {
    const next = this.pending.filter((p) => p.request.opId !== opId);
    if (next.length !== this.pending.length) {
      this.pending = next;
      this.changed();
    }
  }

  private applyConfirmed(op: BoardOp) {
    this.confirmed = applyOp(this.confirmed, op);
    // Thao tác của chính mình đã được xác nhận → bỏ bản lạc quan.
    this.pending = this.pending.filter((p) => p.request.opId !== op.opId);
    this.changed();
  }

  private drain() {
    for (;;) {
      const next = this.buffer.get(this.confirmed.seq + 1);
      if (!next) break;
      this.buffer.delete(next.seq);
      this.applyConfirmed(next);
    }
  }

  private changed() {
    this.cachedView = null;
  }
}
