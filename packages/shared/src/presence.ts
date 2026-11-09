import { z } from "zod";

/*
 * Ai đang online trên một bảng (tuần 4).
 *
 *  - Dữ liệu tạm thời: server chỉ giữ trong bộ nhớ, KHÔNG lưu DB (tuần 8 chuyển sang Redis).
 *  - Client gửi TOÀN BỘ trạng thái của mình (đang nhìn hay đã ẩn tab, đang mở thẻ nào) mỗi khi đổi và
 *    định kỳ làm heartbeat. Gửi cả trạng thái chứ không gửi phần thay đổi, nên mất một tin cũng không sao:
 *    tin sau sửa lại. Server bị khởi động lại thì heartbeat kế tiếp dựng lại được ngay.
 *  - Server gửi lại CẢ danh sách của bảng mỗi khi nó đổi (một bảng chỉ vài người, danh sách rất nhỏ).
 *    Heartbeat không làm đổi gì thì không phát.
 */

/** active = tab đang hiện; away = tab bị ẩn (Page Visibility API), người đó vẫn mở bảng. */
export const presenceStatus = z.enum(["active", "away"]);
export type PresenceStatus = z.infer<typeof presenceStatus>;

export const presenceUpdateInput = z.object({
  boardId: z.string().uuid(),
  status: presenceStatus,
  /** Thẻ đang mở để sửa (hộp thoại thẻ), null nếu không mở thẻ nào. */
  cardId: z.string().uuid().nullable(),
});
export type PresenceUpdateInput = z.infer<typeof presenceUpdateInput>;

/** Một người trên bảng: gộp mọi tab/kết nối của người đó. */
export interface PresenceUser {
  userId: string;
  /** active nếu ít nhất một tab đang hiện. */
  status: PresenceStatus;
  /** Thẻ người đó đang mở (tab nào mở gần nhất thì lấy tab đó), hoặc null. */
  cardId: string | null;
}

export interface BoardPresence {
  boardId: string;
  /** Xếp theo thứ tự vào bảng, để dãy avatar không nhảy lung tung. */
  users: PresenceUser[];
}

/** Client gửi heartbeat mỗi chừng này. */
export const PRESENCE_HEARTBEAT_MS = 15_000;
/** Quá chừng này không nghe heartbeat của một tab đang hiện thì coi tab đó đã offline. */
export const PRESENCE_ACTIVE_TTL_MS = 30_000;
/**
 * Tab bị ẩn thì trình duyệt được phép làm chậm hẹn giờ (Chrome: tới một lần mỗi phút), nên heartbeat
 * 15 giây có thể thành 60 giây. Nếu vẫn dùng 30 giây thì người chỉ chuyển sang tab khác sẽ bị coi là
 * offline nhầm. Vì vậy tab "away" được chờ lâu hơn.
 */
export const PRESENCE_AWAY_TTL_MS = 150_000;
