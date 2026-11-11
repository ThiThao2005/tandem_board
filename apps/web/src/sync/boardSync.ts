import {
  BoardReplica,
  describeRequest,
  isTransientError,
  optimisticUpdate,
  Outbox,
  retryOption,
  type BoardOp,
  type BoardSnapshot,
  type FailedOp,
  type OpRequest,
  type OptimisticContext,
  type OutboxStorage,
  type PresenceUser,
  type Role,
  type SocketErrorBody,
  type WorkspaceDetail,
} from "@tandem/shared";
import { api } from "../api";
import type { TandemSocket } from "../realtime";
import { drainInBackground } from "./drain";
import { NoteSync } from "./noteSync";
import { clearPendingNote, markPendingNote, pendingNotesOfBoard } from "./pendingNotes";

/** Đồng bộ nền một ghi chú còn chữ chưa gửi: quá chừng này thì thả ra, lần vào phòng sau thử lại. */
const BACKGROUND_NOTE_TIMEOUT_MS = 60_000;
import { createOfflineStorage } from "./offlineStore";
import { PresenceTracker, type PresenceState } from "./presence";
import { liveTabs, registerTab, tabId } from "./tabs";

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
  /** Thay đổi của mình mà server từ chối (tuần 6): chờ người dùng xem, thử lại hoặc bỏ qua. */
  failed: readonly FailedOp[];
  /** false khi không ghi được hàng đợi xuống đĩa: thay đổi chưa gửi sẽ mất nếu tải lại trang. */
  durable: boolean;
}

export interface SyncEvents {
  /** Server từ chối thay đổi ghi chú của mình (tuần 5): phần chưa lưu của ghi chú đó bị bỏ. */
  onNoteRejected: (cardId: string, error: SocketErrorBody) => void;
  /** Thao tác của NGƯỜI KHÁC vừa được áp dụng. */
  onRemoteOp: (op: BoardOp) => void;
}

const ACK_TIMEOUT_MS = 15_000;
/** seq nhảy cóc mà sau chừng này phần thiếu vẫn chưa tới thì đi lấy bù. */
const GAP_WAIT_MS = 300;
/** Lỗi server (5xx) lặp lại chừng này lần cho cùng một thao tác thì coi là bị từ chối, để nó không chặn cả hàng. */
const MAX_SERVER_ERRORS = 5;
/** Chừng này thì xem lại đĩa có thay đổi của tab đã chết cần nhận về không. */
const ADOPT_INTERVAL_MS = 20_000;

/** Một nơi lưu dùng chung cho mọi BoardSync của tab này. */
let storage: OutboxStorage | null = null;

/** Mô tả + thẻ kèm theo của một thao tác đang chờ (chụp lúc người dùng thao tác). */
interface PendingMeta {
  label: string;
  restoreCard?: OptimisticContext["restoreCard"];
}

/**
 * Đồng bộ một bảng qua Socket.IO, bọc lõi BoardReplica (packages/shared).
 *
 *  - Vào phòng bằng `board.join` kèm lastSeq: lần đầu (null) nhận ảnh chụp; kết nối lại thì nhận phần thiếu
 *    (hoặc cả ảnh chụp nếu lỡ quá nhiều — mất mạng 2 ngày cũng vào lại được).
 *  - Thao tác của mình: hiện ngay (lạc quan), ghi xuống IndexedDB (tuần 6), gửi LẦN LƯỢT từng cái (chờ ack mới gửi
 *    cái sau), vì cái sau có thể phụ thuộc cái trước (thêm thẻ rồi kéo nó). Mất kết nối, đóng tab, tải lại trang thì
 *    vẫn còn trên đĩa, mở lại bảng là gửi tiếp; gửi lại cùng opId là an toàn vì server chống ghi trùng.
 *  - Server từ chối (thẻ đã bị xóa, xung đột…) thì ghi vào danh sách `failed` để người dùng xem, không âm thầm bỏ đi.
 *  - Rời trang khi còn thao tác chưa gửi: gửi nốt ở nền (drain.ts).
 */
export class BoardSync {
  private replica: BoardReplica | null = null;
  private early: BoardOp[] = [];
  private status: SyncStatus = "connecting";
  private error: string | null = null;
  private snapshot: SyncSnapshot = {
    status: "connecting",
    board: null,
    pending: 0,
    error: null,
    presence: [],
    failed: [],
    durable: true,
  };
  private readonly outbox: Outbox;
  private failed: readonly FailedOp[] = [];
  /** opId → mô tả (và thẻ kèm theo) của thao tác đang chờ, để ghi vào danh sách bị từ chối nếu cần. */
  private meta = new Map<string, PendingMeta>();
  /** Số lần liên tiếp server báo lỗi 5xx cho từng opId. */
  private serverErrors = new Map<string, number>();
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
  private adoptTimer: ReturnType<typeof setInterval> | undefined;
  private joining = false;
  private offs: (() => void)[] = [];
  private readonly presence: PresenceTracker;
  /** Lắng nghe mỗi lần vào (lại) phòng thành công — ghi chú mở lại sau khi kết nối lại. */
  private joinedListeners = new Set<() => void>();
  /**
   * Ghi chú đang dùng (tuần 5): cardId → đồng bộ + số chỗ đang dùng. Đóng hộp thoại khi ghi chú còn thay đổi
   * chưa tới server (đang mất mạng) thì CHƯA hủy: giữ tới khi gửi xong, để đóng hộp thoại không làm mất chữ.
   */
  private notes = new Map<string, { sync: NoteSync; refs: number; off?: () => void }>();

  constructor(
    readonly boardId: string,
    private readonly socket: TandemSocket,
    private readonly userId: string,
    private readonly events: SyncEvents,
  ) {
    this.presence = new PresenceTracker(boardId, socket, () => this.notify());
    storage ??= createOfflineStorage();
    void registerTab();
    this.outbox = new Outbox({
      storage,
      userId,
      boardId,
      tabId,
      liveTabs,
      onStorageError: (err) => {
        console.warn("Offline queue can't be saved to this browser; unsent changes will be lost on reload.", err);
        this.notify();
      },
    });
  }

  // ---------- Cho React (useSyncExternalStore) ----------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): SyncSnapshot => this.snapshot;

  private notify() {
    const board = this.replica?.view ?? null;
    const pendingOps = this.replica?.pendingOps ?? [];
    const pending = pendingOps.length;
    // Rời hàng chờ (đã xác nhận / bị từ chối / đã nằm trong ảnh chụp) thì xóa khỏi đĩa.
    if (this.replica) {
      const ids = new Set(pendingOps.map((p) => p.request.opId));
      this.outbox.retain(ids);
      for (const id of this.meta.keys()) if (!ids.has(id)) this.meta.delete(id);
    }
    const presence = this.presence.list;
    const durable = this.outbox.durable;
    const s = this.snapshot;
    if (
      s.board === board &&
      s.status === this.status &&
      s.pending === pending &&
      s.error === this.error &&
      s.presence === presence &&
      s.failed === this.failed &&
      s.durable === durable
    ) {
      return;
    }
    this.snapshot = { status: this.status, board, pending, error: this.error, presence, failed: this.failed, durable };
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
    // Thay đổi bị từ chối từ lần trước (kể cả sau khi tải lại trang) vẫn phải hiện ra.
    void this.refreshFailed();
    // Tab khác của cùng người này đóng/sập khi còn thay đổi chưa gửi: tab còn sống nhận về mà gửi, không chờ ai mở lại bảng.
    this.adoptTimer = setInterval(() => void this.adoptAndFlush(), ADOPT_INTERVAL_MS);

    if (s.connected) void this.join();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.gapTimer);
    clearInterval(this.adoptTimer);
    // Còn thao tác chưa được server nhận: gửi nốt ở nền, không bỏ. (Cái đã ack nhưng chờ bản phát thì không cần.)
    const unsent = (this.replica?.pendingOps ?? [])
      .filter((p) => !this.acked.has(p.request.opId))
      .map((p) => {
        const m = this.meta.get(p.request.opId);
        return { request: p.request, label: m?.label ?? "", restoreCard: m?.restoreCard };
      });
    if (unsent.length > 0 && this.status !== "gone") drainInBackground(this.socket, this.outbox, this.boardId, unsent);
    else this.outbox.retain([]);
    for (const entry of this.notes.values()) {
      entry.off?.();
      entry.sync.stop();
    }
    this.notes.clear();
    this.backgroundNotes.clear();
    this.joinedListeners.clear();
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
      const firstJoin = !this.replica;
      if (!this.replica) {
        if (catchUp.kind !== "snapshot") throw new Error("Expected a snapshot on first join");
        this.replica = new BoardReplica(catchUp.snapshot);
        for (const op of this.early) this.replica.receive(op);
        this.early = [];
        // Thay đổi chưa gửi từ lần trước (tải lại trang, tab đã đóng, rời bảng lúc offline) quay lại hàng chờ.
        await this.adoptQueued();
        if (this.stopped) return;
      } else if (catchUp.kind === "snapshot") {
        this.replica.reset(catchUp.snapshot);
        this.forgetSettledAcks();
      } else {
        for (const op of catchUp.ops) this.replica.receive(op);
      }
      this.replica.patch({ role: res.role });
      // Vào lại phòng (kết nối lại): xem đĩa có thay đổi của tab đã chết cần nhận về không.
      if (!firstJoin) await this.adoptQueued();
      if (this.stopped) return;
      this.status = "live";
      this.presence.joined();
      this.notify();
      for (const fn of [...this.joinedListeners]) fn();
      void this.flush();
      this.flushPendingNotes();
    } finally {
      this.joining = false;
    }
  }

  /** Ghi chú đang được đồng bộ ở nền (không có hộp thoại nào mở). */
  private backgroundNotes = new Set<string>();

  /**
   * Ghi chú của bảng này còn chữ chưa gửi (gõ lúc offline rồi đóng hộp thoại / tải lại trang): đồng bộ ở nền, không chờ
   * người dùng mở lại đúng ghi chú đó. Mở như bình thường (nạp IndexedDB xong mới note.open, nên phần chỉ có trên máy
   * được gửi bù), xong thì đóng. Không hiện con trỏ của mình cho người khác.
   */
  private flushPendingNotes() {
    const view = this.replica?.view;
    const me = view?.members.find((m) => m.id === this.userId);
    if (!view || !me) return;
    for (const cardId of pendingNotesOfBoard(this.userId, this.boardId)) {
      if (this.notes.has(cardId) || this.backgroundNotes.has(cardId)) continue;
      // Thẻ đang bị xóa mềm / chưa thấy: giữ dấu, lần sau (khi khôi phục) gửi tiếp.
      if (!view.cards.some((k) => k.id === cardId)) continue;
      this.backgroundNotes.add(cardId);
      const sync = this.acquireNote(cardId, { id: this.userId, name: me.displayName, color: me.avatarColor });
      sync.awareness.setLocalState(null);
      let off = () => {};
      const done = () => {
        off();
        clearTimeout(timer);
        if (!this.backgroundNotes.delete(cardId)) return;
        this.releaseNote(cardId);
      };
      const check = () => {
        const s = sync.getSnapshot();
        if ((s.status === "synced" && !s.unsynced) || s.status === "closed") done();
      };
      // Chưa xong trong chừng này (mạng chập chờn): thả ra, lần vào phòng sau thử lại (dấu vẫn còn).
      const timer = setTimeout(done, BACKGROUND_NOTE_TIMEOUT_MS);
      off = sync.subscribe(check);
      check();
    }
  }

  /**
   * Nhận lại các thay đổi còn trên đĩa mà tab này được phép gửi (xem OutboxStorage.claim): của lần tải trang
   * trước, hoặc của tab đã đóng. Dựng lại bản lạc quan lần lượt theo đúng thứ tự (thêm thẻ rồi kéo nó thì cái sau
   * dựa vào cái trước). Một opId đã được server nhận trước khi tab cũ kịp xóa nó khỏi đĩa thì cứ gửi lại: server
   * trả kết quả cũ, replica bỏ nó đi (xem BoardReplica.acknowledge).
   */
  private async adoptQueued() {
    const r = this.replica;
    if (!r) return;
    const records = await this.outbox.claim();
    if (this.stopped) return;
    for (const rec of records) {
      if (r.pendingOps.some((p) => p.request.opId === rec.opId)) continue;
      r.add({
        request: rec.request,
        apply: optimisticUpdate(r.view, rec.request, { userId: this.userId, restoreCard: rec.restoreCard }),
      });
      this.meta.set(rec.opId, { label: rec.label, restoreCard: rec.restoreCard });
    }
  }

  private async adoptAndFlush() {
    if (this.stopped || this.status !== "live") return;
    await this.adoptQueued();
    this.notify();
    void this.flush();
  }

  private async refreshFailed() {
    const list = await this.outbox.listFailed();
    if (this.stopped) return;
    // Giữ cả những cái vừa bị từ chối trong phiên này mà chưa kịp ghi xuống đĩa.
    const known = new Set(list.map((f) => f.opId));
    this.failed = [...list, ...this.failed.filter((f) => !known.has(f.opId))];
    this.notify();
  }

  // ---------- Thay đổi bị từ chối (tuần 6) ----------

  /** Bỏ qua các thay đổi này (người dùng đã xem). */
  dismissFailed(opIds: string[]) {
    const gone = new Set(opIds);
    this.failed = this.failed.filter((f) => !gone.has(f.opId));
    this.outbox.dismissFailed(opIds);
    this.notify();
  }

  /** Thử lại một thay đổi bị từ chối theo cách hợp lý nhất (xem retryOption), rồi bỏ nó khỏi danh sách. */
  retryFailed(opId: string) {
    const failed = this.failed.find((f) => f.opId === opId);
    const option = failed && retryOption(failed);
    if (!failed || !option) return;
    // Gửi lại thành thao tác MỚI (opId mới): bản cũ đã bị server rollback nên không có gì để "trả lại kết quả cũ".
    for (const req of option.requests(() => crypto.randomUUID())) this.submit(req, { restoreCard: failed.restoreCard });
    this.dismissFailed([opId]);
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

  // ---------- Ghi chú (tuần 5) ----------

  /** Lấy (hoặc tạo) đồng bộ ghi chú của một thẻ. Mỗi lần acquire phải có một lần release. */
  acquireNote(cardId: string, me: { id: string; name: string; color: string }): NoteSync {
    const existing = this.notes.get(cardId);
    if (existing) {
      existing.refs++;
      existing.off?.();
      existing.off = undefined;
      return existing.sync;
    }
    const sync = new NoteSync(cardId, this.socket, me, {
      isBoardLive: () => this.status === "live" && !this.stopped,
      onBoardJoined: (fn) => {
        this.joinedListeners.add(fn);
        return () => this.joinedListeners.delete(fn);
      },
      onTyping: (typing) => this.presence.set({ typing }),
      onRejected: (error) => this.events.onNoteRejected(cardId, error),
      onPendingChange: (pending) => {
        if (pending) markPendingNote(this.userId, cardId, this.boardId);
        else clearPendingNote(this.userId, cardId);
      },
    });
    this.notes.set(cardId, { sync, refs: 1 });
    sync.start();
    return sync;
  }

  releaseNote(cardId: string) {
    const entry = this.notes.get(cardId);
    if (!entry || --entry.refs > 0) return;
    const close = () => {
      if (this.notes.get(cardId) !== entry || entry.refs > 0) return;
      entry.off?.();
      this.notes.delete(cardId);
      entry.sync.stop();
      this.notify();
    };
    if (!entry.sync.hasUnsynced) {
      close();
      return;
    }
    // Còn chữ chưa tới server: giữ lại tới khi gửi xong.
    entry.off = entry.sync.onSettled(close);
    this.notify();
  }

  /**
   * Số thay đổi chưa tới server mà sẽ MẤT nếu đóng tab ngay (để cảnh báo trước khi đóng). Từ tuần 6 thay đổi bảng và
   * ghi chú đều lưu xuống đĩa nên đóng tab không mất gì; chỉ khi không ghi được xuống đĩa mới cần cảnh báo.
   */
  get unsyncedNotes(): number {
    let n = 0;
    for (const { sync } of this.notes.values()) if (sync.hasUnsynced && !sync.durable) n++;
    return n + (this.outbox.durable ? 0 : (this.replica?.pendingOps.length ?? 0));
  }

  // ---------- Gửi thao tác ----------

  /** Hiện kết quả ngay rồi xếp hàng gửi lên server. */
  submit(req: OpRequest, ctx: Partial<OptimisticContext> = {}) {
    const r = this.replica;
    if (!r || this.status === "gone") return;
    const label = describeRequest(r.view, req, ctx);
    r.add({ request: req, apply: optimisticUpdate(r.view, req, { userId: this.userId, ...ctx }) });
    this.meta.set(req.opId, { label, restoreCard: ctx.restoreCard });
    // Ghi xuống đĩa ngay (không chờ mạng): đóng tab hay mất điện ngay sau đó cũng không mất.
    this.outbox.queue(req, label, ctx.restoreCard);
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
    let retryDelay = 1000;
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
        this.serverErrors.delete(req.opId);
        this.acked.add(req.opId);
        this.replica.acknowledge(ack.op);
        if (this.replica.hasGap) this.scheduleCatchUp();
      } else if (this.isRetryable(req.opId, ack.error)) {
        // Giới hạn tốc độ (gửi bù cả hàng dài), server đang bận, lỗi tạm: KHÔNG phải bị từ chối, gửi lại sau.
        retry = true;
        retryDelay = ack.error.code === "rate_limited" ? 300 : 1000;
      } else {
        this.serverErrors.delete(req.opId);
        const meta = this.meta.get(req.opId);
        const failed: FailedOp = {
          opId: req.opId,
          userId: this.userId,
          boardId: this.boardId,
          request: req,
          label: meta?.label ?? "",
          error: ack.error,
          failedAt: new Date().toISOString(),
          ...(meta?.restoreCard && { restoreCard: meta.restoreCard }),
        };
        // Ghi vào danh sách "không áp dụng được" TRƯỚC khi bỏ khỏi hàng đợi: sập giữa chừng thì còn bản gửi lại.
        this.outbox.fail(failed);
        this.failed = [...this.failed, failed];
        this.replica.reject(req.opId);
      }
      this.forgetSettledAcks();
      this.notify();
    } finally {
      if (generation === this.sendGeneration) this.sending = false;
    }
    if (generation !== this.sendGeneration) return;
    if (retry) setTimeout(() => void this.flush(), retryDelay);
    else void this.flush();
  }

  /** Lỗi tạm thời thì thử lại; lỗi 5xx lặp lại quá MAX_SERVER_ERRORS lần thì thôi, để một thao tác "độc" không chặn cả hàng. */
  private isRetryable(opId: string, error: SocketErrorBody): boolean {
    if (!isTransientError(error)) return false;
    if (error.status < 500) return true;
    const n = (this.serverErrors.get(opId) ?? 0) + 1;
    this.serverErrors.set(opId, n);
    return n < MAX_SERVER_ERRORS;
  }

  /** Dọn opId đã ack mà nay đã rời hàng chờ (đã áp dụng, hoặc đã nằm trong ảnh chụp mới). */
  private forgetSettledAcks() {
    const live = new Set(this.replica?.pendingOps.map((p) => p.request.opId) ?? []);
    for (const id of this.acked) if (!live.has(id)) this.acked.delete(id);
  }
}
