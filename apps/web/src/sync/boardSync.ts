import {
  BoardReplica,
  optimisticUpdate,
  type BoardOp,
  type BoardSnapshot,
  type OpRequest,
  type OptimisticContext,
  type PresenceUser,
  type Role,
  type SocketErrorBody,
  type WorkspaceDetail,
} from "@tandem/shared";
import { api } from "../api";
import type { TandemSocket } from "../realtime";
import { PresenceTracker, type PresenceState } from "./presence";

export type SyncStatus = "connecting" | "live" | "reconnecting" | "gone";

export interface SyncSnapshot {
  status: SyncStatus;
  /** Bảng người dùng nhìn thấy (đã gồm cập nhật lạc quan). null khi chưa tải xong. */
  board: BoardSnapshot | null;
  /** Số thao tác của mình chưa được server xác nhận. */
  pending: number;
  /** Lý do khi status = "gone" (không có quyền, bảng bị xóa…). */
  error: string | null;
  /** Ai đang ở trên bảng (gồm cả mình). Rỗng khi chưa vào được phòng hoặc đang mất kết nối. */
  presence: PresenceUser[];
}

export interface SyncEvents {
  /** Server từ chối một thao tác của mình (bản lạc quan đã được bỏ). */
  onRejected: (req: OpRequest, error: SocketErrorBody) => void;
  /** Thao tác của NGƯỜI KHÁC vừa được áp dụng. */
  onRemoteOp: (op: BoardOp) => void;
}

const ACK_TIMEOUT_MS = 15_000;
/** seq nhảy cóc mà sau chừng này phần thiếu vẫn chưa tới thì đi lấy bù. */
const GAP_WAIT_MS = 300;

/**
 * Đồng bộ một bảng qua Socket.IO, bọc lõi BoardReplica (packages/shared).
 *
 *  - Vào phòng bằng `board.join` kèm lastSeq: lần đầu (null) nhận ảnh chụp; kết nối lại thì nhận phần thiếu.
 *  - Thao tác của mình: hiện ngay (lạc quan), gửi LẦN LƯỢT từng cái (chờ ack mới gửi cái sau), vì cái sau
 *    có thể phụ thuộc cái trước (thêm thẻ rồi kéo nó). Mất kết nối thì giữ lại, kết nối lại thì gửi tiếp;
 *    gửi lại cùng opId là an toàn vì server chống ghi trùng.
 *  - Tuần 6 sẽ lưu hàng chờ vào IndexedDB; hiện tại tải lại trang là mất phần chưa gửi.
 */
export class BoardSync {
  private replica: BoardReplica | null = null;
  private early: BoardOp[] = [];
  private status: SyncStatus = "connecting";
  private error: string | null = null;
  private snapshot: SyncSnapshot = { status: "connecting", board: null, pending: 0, error: null, presence: [] };
  private listeners = new Set<() => void>();
  private stopped = false;
  private sending = false;
  /**
   * Tăng mỗi lần bắt đầu gửi và mỗi lần mất kết nối. Lần gửi cũ (đã bị bỏ vì mất kết nối) khi hết thời
   * gian chờ sẽ thấy số này đã đổi và KHÔNG đụng vào `sending` của lần gửi mới — nếu không, hai thao tác
   * có thể được gửi cùng lúc và cái sau (vd. kéo một thẻ) tới server trước cái nó phụ thuộc (thêm thẻ đó).
   */
  private sendGeneration = 0;
  /** opId đã được ack nhưng bản phát chưa áp dụng được (đang thiếu seq): không gửi lại nữa. */
  private acked = new Set<string>();
  private gapTimer: ReturnType<typeof setTimeout> | undefined;
  private joining = false;
  private offs: (() => void)[] = [];
  private readonly presence: PresenceTracker;

  constructor(
    readonly boardId: string,
    private readonly socket: TandemSocket,
    private readonly userId: string,
    private readonly events: SyncEvents,
  ) {
    this.presence = new PresenceTracker(boardId, socket, () => this.notify());
  }

  // ---------- Cho React (useSyncExternalStore) ----------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): SyncSnapshot => this.snapshot;

  private notify() {
    const board = this.replica?.view ?? null;
    const pending = this.replica?.pendingOps.length ?? 0;
    const presence = this.presence.list;
    const s = this.snapshot;
    if (
      s.board === board &&
      s.status === this.status &&
      s.pending === pending &&
      s.error === this.error &&
      s.presence === presence
    ) {
      return;
    }
    this.snapshot = { status: this.status, board, pending, error: this.error, presence };
    for (const fn of this.listeners) fn();
  }

  // ---------- Vòng đời ----------

  start() {
    const s = this.socket;
    const onOp = (op: BoardOp) => this.onOp(op);
    const onConnect = () => void this.join();
    const onDisconnect = () => {
      this.presence.left();
      if (this.status === "live") this.setStatus("reconnecting");
      // Lần gửi đang chờ ack trên kết nối cũ coi như bỏ; kết nối lại sẽ gửi lại cùng opId.
      this.sendGeneration++;
      this.sending = false;
    };
    const onRevoked = ({ boardIds }: { boardIds: string[] }) => {
      if (boardIds.includes(this.boardId)) this.gone("You were removed from this workspace.");
    };
    const onDeleted = ({ boardId }: { boardId: string }) => {
      if (boardId === this.boardId) this.gone("This board was deleted.");
    };
    const onRole = ({ workspaceId, role }: { workspaceId: string; role: Role }) => {
      if (this.replica?.state.board.workspaceId !== workspaceId) return;
      this.replica.patch({ role });
      this.notify();
    };
    const onMembers = ({ workspaceId }: { workspaceId: string }) => {
      if (this.replica?.state.board.workspaceId === workspaceId) void this.reloadMembers(workspaceId);
    };
    s.on("op", onOp);
    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    s.on("access.revoked", onRevoked);
    s.on("board.deleted", onDeleted);
    s.on("access.role", onRole);
    s.on("members.changed", onMembers);
    this.offs = [
      () => s.off("op", onOp),
      () => s.off("connect", onConnect),
      () => s.off("disconnect", onDisconnect),
      () => s.off("access.revoked", onRevoked),
      () => s.off("board.deleted", onDeleted),
      () => s.off("access.role", onRole),
      () => s.off("members.changed", onMembers),
    ];
    this.presence.start();

    if (s.connected) void this.join();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.gapTimer);
    this.presence.stop();
    for (const off of this.offs) off();
    this.offs = [];
    if (this.socket.connected) this.socket.emit("board.leave", { boardId: this.boardId });
  }

  private setStatus(status: SyncStatus) {
    this.status = status;
    this.notify();
  }

  private gone(message: string) {
    this.presence.left();
    this.error = message;
    this.setStatus("gone");
  }

  /** Vào phòng (hoặc vào lại) và lấy phần còn thiếu. Cũng dùng để lấy bù khi seq nhảy cóc. */
  private async join() {
    if (this.stopped || this.joining || this.status === "gone") return;
    this.joining = true;
    try {
      const res = await this.socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck("board.join", { boardId: this.boardId, lastSeq: this.replica?.seq ?? null })
        .catch(() => null);
      if (this.stopped) return;
      if (res === null) {
        // Hết thời gian chờ: thử lại khi kết nối lại (hoặc ngay nếu vẫn đang kết nối).
        if (this.socket.connected) setTimeout(() => void this.join(), 1000);
        return;
      }
      if (!res.ok) {
        // Bị giới hạn tốc độ chỉ là tạm thời: chờ rồi vào lại, đừng coi như mất quyền vào bảng.
        if (res.error.code === "rate_limited") {
          setTimeout(() => void this.join(), 1500);
          return;
        }
        this.gone(res.error.status === 404 ? "This board doesn't exist or you don't have access." : res.error.message);
        return;
      }
      const { catchUp } = res;
      if (!this.replica) {
        if (catchUp.kind !== "snapshot") throw new Error("Expected a snapshot on first join");
        this.replica = new BoardReplica(catchUp.snapshot);
        for (const op of this.early) this.replica.receive(op);
        this.early = [];
      } else if (catchUp.kind === "snapshot") {
        this.replica.reset(catchUp.snapshot);
        this.forgetSettledAcks();
      } else {
        for (const op of catchUp.ops) this.replica.receive(op);
      }
      this.replica.patch({ role: res.role });
      this.status = "live";
      this.presence.joined();
      this.notify();
      void this.flush();
    } finally {
      this.joining = false;
    }
  }

  private onOp(op: BoardOp) {
    if (op.boardId !== this.boardId) return;
    if (!this.replica) {
      this.early.push(op);
      return;
    }
    const result = this.replica.receive(op);
    if (result === "applied" && op.actorId !== this.userId) this.events.onRemoteOp(op);
    if (this.replica.hasGap) this.scheduleCatchUp();
    this.notify();
  }

  /** Thiếu seq: chờ một chút (có thể chỉ là tới lệch thứ tự), vẫn thiếu thì vào lại phòng để lấy bù. */
  private scheduleCatchUp() {
    clearTimeout(this.gapTimer);
    this.gapTimer = setTimeout(() => {
      if (this.replica?.hasGap) void this.join();
    }, GAP_WAIT_MS);
  }

  private async reloadMembers(workspaceId: string) {
    const detail = await api<WorkspaceDetail>(`/workspaces/${workspaceId}`).catch(() => null);
    if (detail && this.replica && !this.stopped) {
      this.replica.patch({ members: detail.members });
      this.notify();
    }
  }

  // ---------- Presence ----------

  /** Tab hiện/ẩn, mở/đóng hộp thoại thẻ: báo cho người khác (chỉ gửi khi thật sự đổi). */
  setPresence(patch: Partial<PresenceState>) {
    this.presence.set(patch);
  }

  // ---------- Gửi thao tác ----------

  /** Hiện kết quả ngay rồi xếp hàng gửi lên server. */
  submit(req: OpRequest, ctx: Partial<OptimisticContext> = {}) {
    const r = this.replica;
    if (!r || this.status === "gone") return;
    r.add({ request: req, apply: optimisticUpdate(r.view, req, { userId: this.userId, ...ctx }) });
    this.notify();
    void this.flush();
  }

  private async flush() {
    if (this.sending || this.stopped || this.status !== "live" || !this.socket.connected || !this.replica) return;
    const next = this.replica.pendingOps.find((p) => !this.acked.has(p.request.opId));
    if (!next) return;
    const req = next.request;
    const generation = ++this.sendGeneration;
    this.sending = true;
    let retry = false;
    try {
      const ack = await this.socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck("op", { ...req, boardId: this.boardId })
        .catch(() => null);
      // Bị bỏ giữa chừng (mất kết nối, hoặc đã có lần gửi mới): kết quả này không còn là của mình nữa.
      if (generation !== this.sendGeneration) return;
      if (this.stopped || !this.replica) return;
      if (ack === null) {
        retry = true; // không có ack: gửi lại (cùng opId) — server sẽ không ghi trùng
      } else if (ack.ok) {
        this.acked.add(req.opId);
        this.replica.acknowledge(ack.op);
        if (this.replica.hasGap) this.scheduleCatchUp();
      } else {
        this.replica.reject(req.opId);
        this.events.onRejected(req, ack.error);
      }
      this.forgetSettledAcks();
      this.notify();
    } finally {
      if (generation === this.sendGeneration) this.sending = false;
    }
    if (generation !== this.sendGeneration) return;
    if (retry) setTimeout(() => void this.flush(), 1000);
    else void this.flush();
  }

  /** Dọn opId đã ack mà nay đã rời hàng chờ (đã áp dụng, hoặc đã nằm trong ảnh chụp mới). */
  private forgetSettledAcks() {
    const live = new Set(this.replica?.pendingOps.map((p) => p.request.opId) ?? []);
    for (const id of this.acked) if (!live.has(id)) this.acked.delete(id);
  }
}
