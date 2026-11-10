import {
  PRESENCE_ACTIVE_TTL_MS,
  PRESENCE_AWAY_TTL_MS,
  type PresenceStatus,
  type PresenceUser,
} from "@tandem/shared";

/*
 * Ai đang ở trên bảng nào — chỉ trong bộ nhớ của tiến trình, không lưu DB (PLAN: "❌ Lưu trạng thái
 * online vào database"). Server khởi động lại thì mất hết, nhưng heartbeat kế tiếp của mỗi tab
 * (tối đa 15 giây) dựng lại được.
 *
 * Lưu theo TỪNG KẾT NỐI (mỗi tab một socket), rồi gộp theo người khi đọc: một người mở 2 tab, đóng
 * một tab thì vẫn online; ẩn một tab nhưng tab kia đang hiện thì vẫn "active".
 *
 * Lớp này không biết gì về Socket.IO và nhận thời gian từ ngoài vào, để test được bằng đồng hồ giả.
 * Tuần 8 (nhiều server): thay bằng Redis (hash theo bảng + hạn sống), giữ nguyên cách gộp.
 */

interface Entry {
  userId: string;
  status: PresenceStatus;
  cardId: string | null;
  /** Đang gõ ghi chú của cardId (tuần 5). */
  typing: boolean;
  /** Lần cuối nghe tin từ kết nối này. */
  lastSeen: number;
  /** Lúc vào bảng: dùng để xếp thứ tự avatar cho ổn định. */
  joinedAt: number;
  /** Lúc cardId đổi lần cuối: một người mở thẻ ở nhiều tab thì lấy tab mở gần nhất. */
  cardAt: number;
}

export interface PresenceTtl {
  active: number;
  away: number;
}

export class PresenceStore {
  /** boardId → socketId → trạng thái của kết nối đó. */
  private boards = new Map<string, Map<string, Entry>>();

  constructor(private readonly ttl: PresenceTtl = { active: PRESENCE_ACTIVE_TTL_MS, away: PRESENCE_AWAY_TTL_MS }) {}

  /**
   * Ghi trạng thái của một kết nối (thông báo thay đổi lẫn heartbeat đều đi qua đây).
   * Trả về true nếu danh sách của bảng (sau khi gộp theo người) đổi, tức là cần phát cho cả phòng.
   */
  set(
    boardId: string,
    socketId: string,
    userId: string,
    state: { status: PresenceStatus; cardId: string | null; typing?: boolean },
    now: number,
  ): boolean {
    return this.change(boardId, () => {
      let entries = this.boards.get(boardId);
      if (!entries) this.boards.set(boardId, (entries = new Map()));
      const old = entries.get(socketId);
      entries.set(socketId, {
        userId,
        status: state.status,
        cardId: state.cardId,
        // Chỉ "đang gõ" khi đang mở một thẻ.
        typing: state.cardId !== null && state.typing === true,
        lastSeen: now,
        joinedAt: old?.joinedAt ?? now,
        cardAt: old && old.cardId === state.cardId ? old.cardAt : now,
      });
    });
  }

  /** Như `set` nhưng không đè trạng thái đã có (lúc vào bảng, client có thể đã kịp gửi trạng thái thật). */
  ensure(boardId: string, socketId: string, userId: string, now: number): boolean {
    if (this.boards.get(boardId)?.has(socketId)) return false;
    return this.set(boardId, socketId, userId, { status: "active", cardId: null, typing: false }, now);
  }

  /** Kết nối rời bảng (rời phòng, mất kết nối, bị xóa khỏi nhóm). */
  remove(boardId: string, socketId: string): boolean {
    const entries = this.boards.get(boardId);
    if (!entries?.has(socketId)) return false;
    return this.change(boardId, () => {
      entries.delete(socketId);
      if (entries.size === 0) this.boards.delete(boardId);
    });
  }

  /**
   * Bỏ các kết nối quá hạn không gửi heartbeat (tab bị treo, mạng rớt mà socket chưa kịp phát hiện).
   * Trả về các bảng có danh sách đổi.
   */
  sweep(now: number): string[] {
    const changed: string[] = [];
    for (const [boardId, entries] of this.boards) {
      const stale = [...entries].filter(([, e]) => now - e.lastSeen > this.ttl[e.status]).map(([id]) => id);
      if (stale.length === 0) continue;
      const didChange = this.change(boardId, () => {
        for (const id of stale) entries.delete(id);
        if (entries.size === 0) this.boards.delete(boardId);
      });
      if (didChange) changed.push(boardId);
    }
    return changed;
  }

  /** Danh sách người trên bảng, mỗi người một dòng, xếp theo lúc vào bảng. */
  list(boardId: string): PresenceUser[] {
    const entries = [...(this.boards.get(boardId)?.values() ?? [])];
    const byUser = new Map<string, { user: PresenceUser; joinedAt: number; cardAt: number }>();
    for (const e of entries) {
      const cur = byUser.get(e.userId);
      if (!cur) {
        byUser.set(e.userId, {
          user: { userId: e.userId, status: e.status, cardId: e.cardId, typing: false },
          joinedAt: e.joinedAt,
          cardAt: e.cardId ? e.cardAt : -Infinity,
        });
        continue;
      }
      if (e.status === "active") cur.user.status = "active";
      cur.joinedAt = Math.min(cur.joinedAt, e.joinedAt);
      if (e.cardId && e.cardAt > cur.cardAt) {
        cur.user.cardId = e.cardId;
        cur.cardAt = e.cardAt;
      }
    }
    // Đang gõ: có tab nào của người đó đang gõ ĐÚNG thẻ được hiện (thẻ mở gần nhất).
    for (const { user } of byUser.values()) {
      user.typing = user.cardId !== null && entries.some((e) => e.userId === user.userId && e.cardId === user.cardId && e.typing);
    }
    return [...byUser.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt || (a.user.userId < b.user.userId ? -1 : 1))
      .map((x) => x.user);
  }

  /** Số bảng đang có người (để test kiểm tra không rò bộ nhớ). */
  get boardCount(): number {
    return this.boards.size;
  }

  private change(boardId: string, mutate: () => void): boolean {
    const before = JSON.stringify(this.list(boardId));
    mutate();
    return JSON.stringify(this.list(boardId)) !== before;
  }
}
