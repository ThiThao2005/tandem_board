import {
  PRESENCE_HEARTBEAT_MS,
  type BoardPresence,
  type PresenceStatus,
  type PresenceUser,
} from "@tandem/shared";
import type { TandemSocket } from "../realtime";

export interface PresenceState {
  status: PresenceStatus;
  cardId: string | null;
  /** Đang gõ ghi chú của cardId (tuần 5). */
  typing: boolean;
}

/**
 * Presence của một tab trên một bảng (tuần 4). BoardSync tạo và điều khiển lớp này:
 *  - `joined()` sau khi vào phòng thành công (server chỉ nhận presence của socket đã qua kiểm tra quyền),
 *  - `left()` khi mất kết nối hoặc mất quyền vào bảng.
 *
 * Mỗi lần gửi là TOÀN BỘ trạng thái của tab (không phải phần thay đổi), nên heartbeat cũng chính là
 * bản gửi lại: mất một tin, hay server khởi động lại, thì tin kế tiếp sửa lại hết.
 */
export class PresenceTracker {
  private users: PresenceUser[] = [];
  private mine: PresenceState = { status: "active", cardId: null, typing: false };
  private isJoined = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private off: (() => void) | null = null;

  constructor(
    private readonly boardId: string,
    private readonly socket: TandemSocket,
    private readonly onChange: () => void,
  ) {}

  /** Người đang ở trên bảng (gồm cả mình), theo thứ tự vào bảng. */
  get list(): PresenceUser[] {
    return this.users;
  }

  start() {
    const onPresence = (msg: BoardPresence) => {
      if (msg.boardId !== this.boardId) return;
      this.users = msg.users;
      this.onChange();
    };
    this.socket.on("presence", onPresence);
    this.off = () => this.socket.off("presence", onPresence);
  }

  stop() {
    this.left();
    this.off?.();
    this.off = null;
  }

  joined() {
    this.isJoined = true;
    // Trạng thái thật (tab có thể đang ẩn, hộp thoại thẻ có thể đang mở từ trước khi mất kết nối).
    this.send();
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.send(), PRESENCE_HEARTBEAT_MS);
  }

  /** Không còn kết nối tới phòng: không biết ai đang online nữa, nên xóa danh sách thay vì hiện số cũ. */
  left() {
    this.isJoined = false;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (this.users.length > 0) {
      this.users = [];
      this.onChange();
    }
  }

  set(patch: Partial<PresenceState>) {
    const next = { ...this.mine, ...patch };
    // Đóng thẻ thì hết "đang gõ".
    if (next.cardId === null) next.typing = false;
    if (next.status === this.mine.status && next.cardId === this.mine.cardId && next.typing === this.mine.typing) return;
    this.mine = next;
    this.send();
  }

  private send() {
    if (!this.isJoined || !this.socket.connected) return;
    // volatile: đang mất kết nối thì bỏ luôn, không xếp hàng gửi sau (khi kết nối lại, joined() gửi bản mới).
    // Không cần ack: tin sau luôn mang đủ trạng thái.
    this.socket.volatile.emit("presence.update", { boardId: this.boardId, ...this.mine });
  }
}
