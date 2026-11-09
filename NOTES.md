# Tandem — Nhật ký kỹ thuật

> Ghi trong lúc làm, sau này đưa vào tpath và README. Ghi ngắn, ghi ngay, kèm ngày.

## 1. Số liệu đo được

| Chỉ số | Giá trị | Cách đo | Ngày |
|---|---|---|---|
| Độ trễ đồng bộ p50 | | k6 / Playwright | |
| Độ trễ đồng bộ p95 | | | |
| Số kết nối đồng thời đã thử | | k6 | |
| Số test (unit / e2e) | | Vitest / Playwright | |
| Số lần chạy test hội tụ thành công | | fast-check, 5 client × 200 thao tác | |

## 2. Quyết định kỹ thuật

### Vì sao dùng vị trí kiểu phân số mà không dùng số nguyên?
-

### Vì sao chỉ dùng Yjs cho ghi chú mà không dùng cho cả bảng?
-

### Vì sao đánh seq riêng cho từng bảng mà không dùng BIGSERIAL?
-

### Vì sao cần Redis?
-

### Vì sao chọn WebSocket (Socket.IO) mà không dùng polling hay SSE?
-

## 3. Lỗi “đau nhất”

| Ngày | Triệu chứng | Nguyên nhân | Cách tìm ra | Cách sửa |
|---|---|---|---|---|
| | | | | |

## 4. Nhật ký theo tuần

### Tuần 1 — `feature/nen-tang` (09/11/2026)
- Monorepo npm workspaces: `apps/server`, `apps/web`, `packages/shared` (schema zod dùng chung).
- SQL thuần với `pg` + migration tự viết (khóa advisory để 2 tiến trình không chạy cùng lúc), không dùng ORM, để kiểm soát transaction và `FOR UPDATE`.
- Access token JWT 15 phút để trong bộ nhớ; refresh token trong cookie httpOnly, xoay vòng mỗi lần làm mới. Token cũ bị dùng lại thì thu hồi cả chuỗi (nghi bị đánh cắp). Có 10 giây ân hạn cho trường hợp 2 tab cùng làm mới.
- Kiểm tra quyền luôn suy ra workspace từ DB (thẻ → bảng → nhóm). Người ngoài nhóm nhận 404 thay vì 403.
- Thêm thẻ song song: khóa dòng cột (`FOR UPDATE`) trước khi tính vị trí cuối, nên không trùng vị trí (có test 10 request song song).
- Không cho xóa cột còn thẻ, để không xóa dây chuyền mất thẻ người khác vừa thêm.
- Bẫy gặp phải: kiểu `DATE` của Postgres bị `pg` đổi thành `Date` theo múi giờ máy chủ, dễ lệch một ngày → đặt type parser trả chuỗi.
- Bẫy gặp phải: vitest kéo Vite 7 trong khi web dùng Vite 6 → hai bản Vite, lỗi kiểu plugin → thống nhất dùng Vite 7.
- Test: 31 test API (auth, nhóm/lời mời, bảng/cột/thẻ, phân quyền, IDOR) chạy với Postgres thật.
- Chuyển DB chạy app sang Supabase (chỉ dùng làm nơi chứa Postgres, Session pooler cổng 5432; transaction pooler 6543 sẽ làm hỏng advisory lock của migration).
  - Bẫy: Supabase tự mở schema `public` qua REST API cho anon key → bảng `users` (có password_hash) có thể bị đọc. Đã sửa bằng migration 002: bật RLS mọi bảng + thu hồi quyền `anon`/`authenticated`. Có test bảo đảm bảng mới luôn bật RLS.
  - SSL tự bật cho DB không ở local; có thể xác minh chứng chỉ bằng `DATABASE_CA_FILE`.
  - Test vẫn chạy trên Docker, có chốt chặn từ chối chạy vào DB từ xa (vì test xóa sạch schema).
