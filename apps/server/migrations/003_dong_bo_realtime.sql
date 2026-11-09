-- Tuần 3: đồng bộ realtime.
--
-- 1. seq đánh riêng cho từng bảng (boards.last_seq), KHÔNG dùng BIGSERIAL toàn cục.
--    Mỗi thao tác chạy `UPDATE boards SET last_seq = last_seq + 1 ... RETURNING last_seq` ở đầu
--    transaction. Dòng của bảng bị khóa tới khi COMMIT, nên thao tác lấy seq N luôn commit trước
--    thao tác lấy seq N+1. Với BIGSERIAL, seq 1201 có thể commit SAU 1202 → client đã đặt
--    lastSeq = 1202 sẽ bỏ qua 1201 mãi mãi.
-- 2. operations: nhật ký thao tác của từng bảng. Dùng để gửi bù khi client bị lỡ (seq > lastSeq),
--    chống ghi trùng (op_id UNIQUE), và hiển thị lịch sử. payload là KẾT QUẢ server đã quyết định
--    (thẻ sau khi sửa, vị trí server tính…), không phải ý định client gửi lên, nên client nào áp dụng
--    lại cũng ra cùng một bảng.
-- 3. cards.field_versions: lần cuối từng trường (title, due_date, assignee, column) được sửa ở
--    version nào và bởi ai, để chỉ báo xung đột khi CHÍNH trường đó bị người khác sửa sau baseVersion.

ALTER TABLE boards ADD COLUMN last_seq BIGINT NOT NULL DEFAULT 0;

ALTER TABLE cards ADD COLUMN field_versions JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE operations (
  board_id   UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  seq        BIGINT NOT NULL,
  op_id      UUID NOT NULL,
  actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, seq),
  CONSTRAINT operations_op_id_key UNIQUE (op_id)
);

-- Quy ước từ migration 002: bảng mới phải bật RLS để REST API của Supabase không đọc được.
ALTER TABLE operations ENABLE ROW LEVEL SECURITY;
