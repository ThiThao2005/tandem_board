/*
 * Ghi chú còn chữ chưa tới server (tuần 6, sửa lúc review).
 *
 * Chữ gõ lúc offline nằm an toàn trong IndexedDB (y-indexeddb), nhưng trước đây chỉ được gửi lên khi người dùng MỞ LẠI
 * đúng ghi chú đó: người khác không bao giờ thấy, mặt thẻ không báo có ghi chú, và đăng xuất (xóa IndexedDB) thì mất hẳn
 * mà không hỏi — vì cảnh báo trước khi đăng xuất chỉ đếm hàng đợi thao tác của bảng.
 *
 * Danh sách nhỏ này (localStorage, theo người dùng): cardId → boardId của các ghi chú còn chữ chưa gửi. BoardSync dùng nó
 * để tự đồng bộ ở nền khi vào bảng; trang đăng xuất dùng nó để cảnh báo. Đánh dấu khi có chữ chưa gửi, chỉ bỏ dấu khi
 * server đã xác nhận đồng bộ xong (không bỏ chỉ vì ghi chú vừa được mở lại lúc còn offline).
 */

const PREFIX = "tandem-pending-notes:";

function read(userId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(PREFIX + userId);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function write(userId: string, value: Record<string, string>) {
  try {
    if (Object.keys(value).length === 0) localStorage.removeItem(PREFIX + userId);
    else localStorage.setItem(PREFIX + userId, JSON.stringify(value));
  } catch {
    // localStorage bị chặn: chỉ mất phần "tự gửi ở nền" và cảnh báo; chữ vẫn nằm trong IndexedDB.
  }
}

export function markPendingNote(userId: string, cardId: string, boardId: string) {
  const all = read(userId);
  if (all[cardId] === boardId) return;
  write(userId, { ...all, [cardId]: boardId });
}

export function clearPendingNote(userId: string, cardId: string) {
  const all = read(userId);
  if (!(cardId in all)) return;
  delete all[cardId];
  write(userId, all);
}

export function pendingNotesOfBoard(userId: string, boardId: string): string[] {
  return Object.entries(read(userId))
    .filter(([, b]) => b === boardId)
    .map(([cardId]) => cardId);
}

export function countPendingNotes(userId: string): number {
  return Object.keys(read(userId)).length;
}

/** Đăng xuất: xóa danh sách của mọi người dùng trên trình duyệt này. */
export function wipePendingNotes() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Không có localStorage thì cũng không có gì để xóa.
  }
}
