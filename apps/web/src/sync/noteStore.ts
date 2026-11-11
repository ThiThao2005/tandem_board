import { IndexeddbPersistence } from "y-indexeddb";
import type * as Y from "yjs";

/**
 * Lưu Y.Doc của ghi chú xuống IndexedDB (tuần 6, y-indexeddb): đóng tab hay tải lại trang lúc đang offline cũng
 * không mất chữ vừa gõ — lần mở lại ghi chú, NoteSync tính phần server còn thiếu từ chính Y.Doc này (state vector)
 * và gửi bù, như mọi lần kết nối lại.
 *
 * Mỗi ghi chú một cơ sở dữ liệu, tên gồm cả userId để hai người dùng chung một trình duyệt không đọc của nhau.
 */
export const NOTE_DB_PREFIX = "tandem-note:";
const LOAD_TIMEOUT_MS = 3_000;

export interface NotePersistence {
  /** Origin của thay đổi do việc nạp từ đĩa (không phải gõ phím): NoteSync không coi là "của mình chưa gửi". */
  readonly origin: unknown;
  /** Xong khi nội dung đã lưu được nạp vào Y.Doc. Không bao giờ từ chối (lỗi → coi như không có gì để nạp). */
  loaded: Promise<void>;
  /** Xóa dữ liệu đã lưu của ghi chú này (khi bản của mình bị server từ chối và phải bỏ). */
  clear(): Promise<void>;
  destroy(): void;
}

export function persistNote(userId: string, cardId: string, doc: Y.Doc): NotePersistence | null {
  if (typeof indexedDB === "undefined") return null;
  try {
    const p = new IndexeddbPersistence(`${NOTE_DB_PREFIX}${userId}:${cardId}`, doc);
    return {
      origin: p,
      // Không chờ vô hạn: IndexedDB treo (bị chặn, đang nâng cấp ở tab khác) thì vẫn phải mở được ghi chú.
      loaded: Promise.race([
        p.whenSynced.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS)),
      ]),
      clear: () => p.clearData().catch(() => {}),
      destroy: () => void p.destroy().catch(() => {}),
    };
  } catch {
    // Chế độ riêng tư / bị chặn: ghi chú vẫn dùng được, chỉ là không lưu xuống máy.
    return null;
  }
}
