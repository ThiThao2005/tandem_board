-- Tuần 5: ghi chú nhiều người cùng gõ (Yjs).
--
-- 1. card_notes.ydoc: trạng thái Yjs ĐÃ GỘP của ghi chú (Y.encodeStateAsUpdate), không phải HTML.
--    Lưu dạng CRDT để người mở sau vẫn đồng bộ được với người đang sửa dở (offline rồi kết nối lại):
--    hai bên trao đổi state vector và chỉ gửi cho nhau phần còn thiếu.
--    Mỗi lần lưu: khóa dòng → gộp trạng thái trong DB với trạng thái trong bộ nhớ → ghi lại. Gộp (không
--    ghi đè) nên tuần 8 có nhiều server cùng lưu một ghi chú cũng không mất thay đổi của nhau. Nạp vào
--    Y.Doc rồi mã hóa lại còn dọn luôn nội dung đã xóa (GC), nên ydoc không phình theo lịch sử gõ.
-- 2. cards.note_summary: tóm tắt để hiện trên mặt thẻ (có chữ không, tiến độ checklist) mà không phải
--    tải Y.Doc. Đổi tóm tắt là một thao tác "card.notes" có seq như mọi thao tác khác, nên gửi bù / ảnh
--    chụp bảng vẫn đúng.

CREATE TABLE card_notes (
  card_id    UUID PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  -- Lặp lại board_id để kiểm tra quyền/xóa theo bảng không cần JOIN (thẻ không bao giờ đổi bảng).
  board_id   UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  ydoc       BYTEA NOT NULL,
  -- Ai lưu lần cuối (người gõ gần nhất trước lần lưu).
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX card_notes_board_idx ON card_notes (board_id);

-- Quy ước từ migration 002: bảng mới phải bật RLS để REST API của Supabase không đọc được.
ALTER TABLE card_notes ENABLE ROW LEVEL SECURITY;

ALTER TABLE cards ADD COLUMN note_summary JSONB;
