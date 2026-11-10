import {
  NOTE_MAX_UPDATE_BYTES,
  type NoteAwarenessState,
  type NoteClosedReason,
  type SocketErrorBody,
} from "@tandem/shared";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import type { TandemSocket } from "../realtime";

/*
 * Đồng bộ ghi chú của MỘT thẻ (tuần 5) qua kết nối Socket.IO dùng chung với bảng.
 *
 *  - Mở (và mở lại sau khi kết nối lại): gửi state vector, nhận phần mình thiếu + state vector của server,
 *    gửi ngược phần server thiếu. Yjs là CRDT nên không cần hàng chờ thao tác như bảng: bản Y.Doc trong
 *    trình duyệt CHÍNH LÀ hàng chờ, mất kết nối bao lâu cũng chỉ cần một lần đồng bộ là đủ.
 *  - Gõ: gom các thay đổi (Y.mergeUpdates) và gửi lần lượt, một lần gửi tại một thời điểm (đang chờ ack thì
 *    thay đổi mới dồn vào lần sau) — gõ nhanh không thành hàng trăm gói tin.
 *  - Con trỏ (awareness): gửi tối đa ~10 lần/giây; tên/màu do server điền lại theo tài khoản.
 *  - Server từ chối (bị hạ xuống viewer, ghi chú quá dài, dữ liệu hỏng): bản của mình đã lệch khỏi server mà
 *    CRDT không "rút lại" được thay đổi, nên bỏ Y.Doc cũ, tạo Y.Doc mới rồi tải lại từ server (`docVersion` tăng,
 *    editor được tạo lại).
 */

export type NoteStatus = "connecting" | "synced" | "saving" | "offline" | "closed";

/** Người khác đang mở ghi chú (từ awareness). */
export interface NotePeer {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  typing: boolean;
}

export interface NoteSnapshot {
  status: NoteStatus;
  /** Có thay đổi của mình chưa được server nhận. */
  unsynced: boolean;
  /** Server cho sửa không (viewer thì không). null = chưa biết (chưa mở xong). */
  canEdit: boolean | null;
  peers: NotePeer[];
  /** Tăng mỗi khi phải bỏ Y.Doc cũ để tải lại từ server: editor phải gắn vào `doc` mới. */
  docVersion: number;
  closedReason: NoteClosedReason | null;
}

export interface NoteHooks {
  /** Bảng đang "live" (đã vào phòng và qua kiểm tra quyền) — chỉ khi đó server mới cho mở ghi chú. */
  isBoardLive(): boolean;
  /** Đăng ký nghe mỗi lần vào (lại) phòng bảng thành công. */
  onBoardJoined(fn: () => void): () => void;
  /** Mình bắt đầu/ngừng gõ (để mặt thẻ bên người khác hiện "đang gõ…"). */
  onTyping(typing: boolean): void;
  /** Server từ chối thay đổi của mình: phần chưa lưu bị bỏ. */
  onRejected(error: SocketErrorBody): void;
}

/** Origin của thay đổi đến từ server: không gửi ngược lên. */
const REMOTE = "remote";
const ACK_TIMEOUT_MS = 15_000;
const AWARENESS_THROTTLE_MS = 100;
/** Ngừng gõ chừng này thì hết "đang gõ". */
const TYPING_IDLE_MS = 2_000;

export class NoteSync {
  doc = new Y.Doc();
  awareness = new Awareness(this.doc);

  private status: NoteStatus = "connecting";
  private canEdit: boolean | null = null;
  private docVersion = 0;
  private closedReason: NoteClosedReason | null = null;
  private snapshot: NoteSnapshot;
  private listeners = new Set<() => void>();
  private settledListeners = new Set<() => void>();

  /** Thay đổi của mình chưa gửi (đã gom). */
  private queue: Uint8Array[] = [];
  private inFlight = false;
  /** Có thay đổi của mình mà server chưa xác nhận (kể cả phần đang gửi). */
  private unsynced = false;
  /** Đã mở xong trên kết nối hiện tại (server có phiên cho socket này). */
  private opened = false;
  private opening = false;
  /** Tăng mỗi lần mất kết nối / tải lại doc: kết quả của lần gửi cũ bị bỏ qua. */
  private generation = 0;
  private stopped = false;
  private typing = false;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  private awarenessTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAwarenessAt = 0;
  private offs: (() => void)[] = [];
  private docOffs: (() => void)[] = [];

  constructor(
    readonly cardId: string,
    private readonly socket: TandemSocket,
    private readonly me: { id: string; name: string; color: string },
    private readonly hooks: NoteHooks,
  ) {
    this.snapshot = this.makeSnapshot();
  }

  // ---------- Cho React ----------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): NoteSnapshot => this.snapshot;

  /** Gọi một lần khi mọi thay đổi của mình đã tới server (để đóng hẳn ghi chú sau khi đã lưu xong). */
  onSettled(fn: () => void): () => void {
    this.settledListeners.add(fn);
    return () => this.settledListeners.delete(fn);
  }

  get hasUnsynced(): boolean {
    return this.unsynced;
  }

  private makeSnapshot(): NoteSnapshot {
    return {
      status: this.status,
      unsynced: this.unsynced,
      canEdit: this.canEdit,
      peers: this.peers(),
      docVersion: this.docVersion,
      closedReason: this.closedReason,
    };
  }

  private notify() {
    const next = this.makeSnapshot();
    const s = this.snapshot;
    if (
      s.status === next.status &&
      s.unsynced === next.unsynced &&
      s.canEdit === next.canEdit &&
      s.docVersion === next.docVersion &&
      s.closedReason === next.closedReason &&
      JSON.stringify(s.peers) === JSON.stringify(next.peers)
    ) {
      return;
    }
    this.snapshot = next;
    for (const fn of this.listeners) fn();
    if (!this.unsynced) for (const fn of [...this.settledListeners]) fn();
  }

  private peers(): NotePeer[] {
    const result: NotePeer[] = [];
    for (const [clientId, raw] of this.awareness.getStates()) {
      if (clientId === this.doc.clientID) continue;
      const state = raw as Partial<NoteAwarenessState>;
      if (!state.user) continue;
      result.push({ clientId, userId: state.user.id, name: state.user.name, color: state.user.color, typing: state.typing === true });
    }
    return result.sort((a, b) => a.clientId - b.clientId);
  }

  // ---------- Vòng đời ----------

  start() {
    const s = this.socket;
    const onUpdate = ({ cardId, update }: { cardId: string; update: Uint8Array }) => {
      if (cardId !== this.cardId || !this.opened) return;
      Y.applyUpdate(this.doc, new Uint8Array(update), REMOTE);
    };
    const onAwareness = ({ cardId, update }: { cardId: string; update: Uint8Array }) => {
      if (cardId !== this.cardId || !this.opened) return;
      applyAwarenessUpdate(this.awareness, new Uint8Array(update), REMOTE);
    };
    const onClosed = ({ cardId, reason }: { cardId: string; reason: NoteClosedReason }) => {
      if (cardId !== this.cardId) return;
      this.opened = false;
      this.closedReason = reason;
      this.dropPeers();
      this.setStatus("closed");
    };
    const onDisconnect = () => {
      this.opened = false;
      this.inFlight = false;
      this.generation++;
      // Phần đang gửi/chưa gửi vẫn nằm trong Y.Doc: lần mở lại sẽ tính đúng phần server còn thiếu.
      this.queue = [];
      // Không còn biết ai đang mở nữa: bỏ con trỏ của người khác thay vì để con trỏ "đứng hình".
      this.dropPeers();
      if (this.status !== "closed") this.setStatus("offline");
    };
    s.on("note.update", onUpdate);
    s.on("note.awareness", onAwareness);
    s.on("note.closed", onClosed);
    s.on("disconnect", onDisconnect);
    this.offs = [
      () => s.off("note.update", onUpdate),
      () => s.off("note.awareness", onAwareness),
      () => s.off("note.closed", onClosed),
      () => s.off("disconnect", onDisconnect),
      this.hooks.onBoardJoined(() => {
        if (!this.opened && this.status !== "closed") void this.open();
      }),
    ];
    this.bindDoc();
    if (this.hooks.isBoardLive()) void this.open();
  }

  /** Đóng ghi chú: báo server xóa con trỏ của mình, bỏ hết. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.typingTimer);
    clearTimeout(this.awarenessTimer);
    if (this.typing) this.hooks.onTyping(false);
    for (const off of this.offs) off();
    this.offs = [];
    if (this.opened && this.socket.connected) this.socket.emit("note.close", { cardId: this.cardId });
    this.opened = false;
    this.listeners.clear();
    this.settledListeners.clear();
    // Hủy sau khi editor (component con) đã gỡ khỏi doc.
    const { doc, awareness } = this;
    setTimeout(() => {
      awareness.destroy();
      doc.destroy();
    }, 0);
    for (const off of this.docOffs) off();
  }

  private setStatus(status: NoteStatus) {
    this.status = status;
    this.notify();
  }

  /** Nghe thay đổi của Y.Doc / awareness hiện tại (gọi lại khi đổi doc). */
  private bindDoc() {
    for (const off of this.docOffs) off();
    const doc = this.doc;
    const awareness = this.awareness;
    const onDocUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      this.queue.push(update);
      this.unsynced = true;
      this.pulseTyping();
      if (this.status === "synced") this.status = "saving";
      this.notify();
      void this.flush();
    };
    const onAwarenessChange = (_: unknown, origin: unknown) => {
      if (origin === "local") this.scheduleAwareness();
      this.notify();
    };
    doc.on("update", onDocUpdate);
    awareness.on("change", onAwarenessChange);
    // "update" (khác "change") cũng phát khi chỉ gia hạn trạng thái mỗi 15 s: server cần bản gia hạn đó,
    // nếu không sau 30 s server coi con trỏ của mình là cũ.
    const onAwarenessUpdate = (_: unknown, origin: unknown) => {
      if (origin === "local") this.scheduleAwareness();
    };
    awareness.on("update", onAwarenessUpdate);
    this.docOffs = [
      () => doc.off("update", onDocUpdate),
      () => awareness.off("change", onAwarenessChange),
      () => awareness.off("update", onAwarenessUpdate),
    ];
  }

  // ---------- Mở / đồng bộ ----------

  private async open() {
    if (this.stopped || this.opening || this.opened || !this.socket.connected) return;
    this.opening = true;
    const generation = this.generation;
    const doc = this.doc;
    try {
      const res = await this.socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck("note.open", { cardId: this.cardId, stateVector: Y.encodeStateVector(doc) })
        .catch(() => null);
      if (this.stopped || generation !== this.generation || doc !== this.doc) return;
      if (res === null) {
        if (this.socket.connected) setTimeout(() => void this.open(), 1000);
        return;
      }
      if (!res.ok) {
        if (res.error.code === "rate_limited") setTimeout(() => void this.open(), 1500);
        else if (res.error.code === "card_deleted") {
          this.closedReason = "card_deleted";
          this.setStatus("closed");
        }
        // not_found: chưa vào lại phòng bảng — onBoardJoined sẽ mở lại.
        return;
      }
      Y.applyUpdate(doc, new Uint8Array(res.update), REMOTE);
      if (res.awareness) applyAwarenessUpdate(this.awareness, new Uint8Array(res.awareness), REMOTE);
      this.canEdit = res.canEdit;
      this.opened = true;
      this.closedReason = null;
      // Phần server còn thiếu (gõ lúc offline, hoặc đang gửi dở lúc mất kết nối) — gộp mọi thứ chưa gửi.
      const missing = Y.encodeStateAsUpdate(doc, new Uint8Array(res.stateVector));
      this.queue = missing.byteLength > 2 ? [missing] : [];
      this.unsynced = this.queue.length > 0;
      this.status = this.unsynced ? "saving" : "synced";
      this.notify();
      this.sendAwarenessNow();
      void this.flush();
    } finally {
      this.opening = false;
    }
  }

  private async flush() {
    if (this.stopped || this.inFlight || !this.opened || !this.socket.connected || this.queue.length === 0) return;
    const update = this.queue.length === 1 ? this.queue[0]! : Y.mergeUpdates(this.queue);
    this.queue = [];
    if (update.byteLength > NOTE_MAX_UPDATE_BYTES) {
      this.reload({ status: 413, code: "note_too_large", message: "That change is too large to sync" });
      return;
    }
    const generation = this.generation;
    this.inFlight = true;
    const ack = await this.socket
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck("note.update", { cardId: this.cardId, update })
      .catch(() => null);
    if (generation !== this.generation || this.stopped) return;
    this.inFlight = false;
    if (ack === null) {
      // Không có ack: gửi lại (Yjs bỏ bản trùng nên gửi hai lần cũng không sao).
      this.queue.unshift(update);
      setTimeout(() => void this.flush(), 1000);
      return;
    }
    if (!ack.ok) {
      if (ack.error.code === "note_not_open") {
        // Server không còn phiên của mình (vd. vừa vào lại phòng bảng): mở lại, phần thiếu được tính lại.
        this.opened = false;
        void this.open();
      } else if (ack.error.code === "rate_limited") {
        this.queue.unshift(update);
        setTimeout(() => void this.flush(), 500);
      } else {
        this.reload(ack.error);
      }
      return;
    }
    if (this.queue.length === 0) {
      this.unsynced = false;
      this.status = "synced";
      this.notify();
    }
    void this.flush();
  }

  /**
   * Bản của mình đã lệch khỏi server mà không rút lại được (CRDT chỉ cộng thêm): bỏ Y.Doc cũ, tải lại từ
   * server. Phần chưa được server nhận bị mất — báo cho người dùng.
   */
  private reload(error: SocketErrorBody) {
    this.generation++;
    this.inFlight = false;
    this.queue = [];
    this.unsynced = false;
    this.opened = false;
    this.hooks.onRejected(error);
    if (this.socket.connected) this.socket.emit("note.close", { cardId: this.cardId });
    const old = { doc: this.doc, awareness: this.awareness };
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.bindDoc();
    this.docVersion++;
    this.status = "connecting";
    this.notify();
    setTimeout(() => {
      old.awareness.destroy();
      old.doc.destroy();
    }, 0);
    void this.open();
  }

  // ---------- Con trỏ / đang gõ ----------

  private dropPeers() {
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    if (others.length > 0) removeAwarenessStates(this.awareness, others, REMOTE);
  }

  private pulseTyping() {
    if (!this.typing) {
      this.typing = true;
      this.awareness.setLocalStateField("typing", true);
      this.hooks.onTyping(true);
    }
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => {
      this.typing = false;
      if (!this.stopped) {
        this.awareness.setLocalStateField("typing", false);
        this.hooks.onTyping(false);
      }
    }, TYPING_IDLE_MS);
  }

  private scheduleAwareness() {
    if (this.awarenessTimer) return;
    const wait = Math.max(0, this.lastAwarenessAt + AWARENESS_THROTTLE_MS - Date.now());
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = undefined;
      this.sendAwarenessNow();
    }, wait);
  }

  private sendAwarenessNow() {
    if (!this.opened || !this.socket.connected || this.stopped) return;
    this.lastAwarenessAt = Date.now();
    const update = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
    // volatile: mất kết nối thì bỏ, lần mở lại gửi bản mới.
    this.socket.volatile.emit("note.awareness", { cardId: this.cardId, update });
  }

  /** Tên/màu của mình (để con trỏ hiện ngay bên mình; server vẫn ghi đè bằng thông tin tài khoản). */
  get user() {
    return { name: this.me.name, color: this.me.color };
  }
}
