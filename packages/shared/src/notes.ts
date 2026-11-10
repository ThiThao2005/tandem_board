import * as Y from "yjs";
import { z } from "zod";

/*
 * Ghi chú nhiều người cùng gõ (tuần 5).
 *
 * Mỗi thẻ có một Y.Doc. Nội dung nằm trong Y.XmlFragment tên NOTE_FIELD, đúng cấu trúc tài liệu
 * ProseMirror mà TipTap (extension Collaboration) đọc/ghi. Yjs là CRDT: hai người gõ cùng một đoạn thì
 * mọi bản sao tự hội tụ về cùng một nội dung, không cần server "trộn" gì cả — server chỉ:
 *   1. kiểm tra quyền (chỉ editor được gửi thay đổi; viewer chỉ xem),
 *   2. giữ một bản Y.Doc trong bộ nhớ để trả lời bước đồng bộ cho người mới mở,
 *   3. phát thay đổi cho người khác đang mở cùng thẻ,
 *   4. lưu trạng thái Yjs vào DB (card_notes.ydoc) sau một khoảng ngắn.
 *
 * Giao thức (trên cùng kết nối Socket.IO với thao tác bảng, nên dùng lại xác thực, phòng và đá ra):
 *
 *   note.open   { cardId, stateVector }  → ack { update, stateVector, awareness, canEdit }
 *                 server trả phần client còn thiếu (update) và state vector của server, client gửi ngược lại
 *                 phần server còn thiếu bằng note.update — đồng bộ hai chiều trong MỘT vòng.
 *   note.update { cardId, update }       → ack {}   (server phát cho người khác: note.update)
 *   note.awareness { cardId, update }               (con trỏ, vùng chọn, "đang gõ"; server phát lại)
 *   note.close  { cardId }
 *   server → client: note.closed { cardId, reason } khi mất quyền, bảng bị xóa, thẻ bị xóa hẳn…
 *
 * Vì Yjs tự hội tụ, mất kết nối giữa chừng không cần hàng chờ phức tạp: kết nối lại thì note.open với
 * state vector hiện có là hai bên tự bù cho nhau phần còn thiếu.
 */

/** Tên Y.XmlFragment chứa nội dung (mặc định của @tiptap/extension-collaboration). */
export const NOTE_FIELD = "default";

/** Một lần gửi tối đa chừng này byte (dán một đoạn rất dài). Lớn hơn thì bị từ chối. */
export const NOTE_MAX_UPDATE_BYTES = 256 * 1024;
/** Trạng thái Yjs của một ghi chú tối đa chừng này byte (~ vài trăm nghìn ký tự). */
export const NOTE_MAX_DOC_BYTES = 1024 * 1024;

/** Binary qua Socket.IO: Node nhận Buffer (là Uint8Array), trình duyệt có thể gửi ArrayBuffer. */
const bytes = z
  .custom<Uint8Array | ArrayBuffer>((v) => v instanceof Uint8Array || v instanceof ArrayBuffer, "Expected binary data")
  .transform((b): Uint8Array => (b instanceof Uint8Array ? b : new Uint8Array(b)));

const cardId = z.string().uuid();

export const noteOpenInput = z.object({
  cardId,
  /** Y.encodeStateVector của bản client đang có (rỗng nếu chưa có gì). */
  stateVector: bytes.refine((b) => b.byteLength <= 64 * 1024, "State vector too large"),
});
export type NoteOpenInput = z.input<typeof noteOpenInput>;

export const noteUpdateInput = z.object({
  cardId,
  update: bytes.refine((b) => b.byteLength > 0 && b.byteLength <= NOTE_MAX_UPDATE_BYTES, "Update too large"),
});
export type NoteUpdateInput = z.input<typeof noteUpdateInput>;

export const noteAwarenessInput = z.object({
  cardId,
  update: bytes.refine((b) => b.byteLength <= 8 * 1024, "Awareness update too large"),
});
export type NoteAwarenessInput = z.input<typeof noteAwarenessInput>;

export const noteCloseInput = z.object({ cardId });

export interface NoteOpenResult {
  /** Phần client còn thiếu so với server (Y.encodeStateAsUpdate(serverDoc, clientStateVector)). */
  update: Uint8Array;
  /** State vector của server: client gửi lại Y.encodeStateAsUpdate(clientDoc, stateVector). */
  stateVector: Uint8Array;
  /** Con trỏ của những người đang mở thẻ này (y-protocols awareness), null nếu chưa ai. */
  awareness: Uint8Array | null;
  /** Người này được sửa ghi chú hay chỉ xem. */
  canEdit: boolean;
}

/** board_left: rời phòng bảng (bị xóa khỏi nhóm, bảng bị xóa, rời trang). card_deleted: thẻ bị xóa hẳn. */
export type NoteClosedReason = "board_left" | "card_deleted";

/**
 * Trạng thái awareness của một người trong ghi chú. `user` do SERVER ghi đè theo tài khoản đang đăng
 * nhập (client không mạo danh người khác được); `cursor` là vị trí con trỏ (y-prosemirror tự quản).
 */
export interface NoteAwarenessState {
  user: { id: string; name: string; color: string };
  /** Vừa gõ trong ~2 giây gần đây. */
  typing?: boolean;
  cursor?: unknown;
}

// ---------- Tóm tắt ghi chú (hiện trên mặt thẻ) ----------

/**
 * Tóm tắt ghi chú để hiện trên mặt thẻ mà không phải tải cả Y.Doc: có chữ hay không và tiến độ checklist.
 * Cố ý KHÔNG có số ký tự hay đoạn trích: những thứ đó đổi theo từng phím gõ, mà mỗi lần tóm tắt đổi là
 * một thao tác có seq trên bảng. Tiến độ checklist chỉ đổi khi tick/thêm/bớt việc.
 */
export interface NoteSummary {
  hasText: boolean;
  /** Số việc đã tick trong checklist. */
  done: number;
  /** Tổng số việc trong checklist. */
  total: number;
}

const TASK_ITEM = "taskItem";

/** Thuộc tính boolean trong y-prosemirror có thể là true hoặc chuỗi "true" tùy phiên bản. */
const isChecked = (v: unknown) => v === true || v === "true";

/**
 * Đọc tóm tắt từ Y.Doc (server gọi khi lưu, test gọi để kiểm tra). null = ghi chú trống.
 * Duyệt cây XML: phần tử `taskItem` (TipTap TaskItem) có thuộc tính `checked`.
 */
export function noteSummary(doc: Y.Doc): NoteSummary | null {
  let hasText = false;
  let done = 0;
  let total = 0;
  const walk = (node: Y.XmlElement | Y.XmlFragment | Y.XmlText | Y.XmlHook) => {
    if (node instanceof Y.XmlText) {
      if (!hasText && node.toString().replace(/<[^>]*>/g, "").trim().length > 0) hasText = true;
      return;
    }
    if (node instanceof Y.XmlElement && node.nodeName === TASK_ITEM) {
      total += 1;
      if (isChecked(node.getAttribute("checked"))) done += 1;
    }
    if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
      for (const child of node.toArray()) walk(child);
    }
  };
  walk(doc.getXmlFragment(NOTE_FIELD));
  return hasText || total > 0 ? { hasText, done, total } : null;
}

/** So sánh hai tóm tắt (null = trống). */
export function sameNoteSummary(a: NoteSummary | null, b: NoteSummary | null): boolean {
  if (a === null || b === null) return a === b;
  return a.hasText === b.hasText && a.done === b.done && a.total === b.total;
}
