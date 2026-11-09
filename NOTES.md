# Tandem — Nhật ký kỹ thuật

> Ghi trong lúc làm, sau này đưa vào tpath và README. Ghi ngắn, ghi ngay, kèm ngày.

## 1. Số liệu đo được

| Chỉ số | Giá trị | Cách đo | Ngày |
|---|---|---|---|
| Độ trễ đồng bộ p50 | | k6 / Playwright | |
| Độ trễ đồng bộ p95 | | | |
| Số kết nối đồng thời đã thử | | k6 | |
| Số test (unit / e2e) | 28 unit + 49 API / 0 e2e | Vitest | 09/11/2026 |
| Số lần chạy test hội tụ thành công | | fast-check, 5 client × 200 thao tác | |

## 2. Quyết định kỹ thuật

### Vì sao dùng vị trí kiểu phân số mà không dùng số nguyên?
- Số nguyên: chèn vào giữa phải đánh số lại mọi thẻ phía sau, tức là ghi nhiều dòng. Hai người kéo cùng lúc thì hai lần đánh số lại đè lên nhau.
- Vị trí phân số (chuỗi): chèn vào giữa A và B chỉ cần sinh một chuỗi nằm giữa, **ghi đúng 1 dòng**. Các thẻ khác không đổi, nên thao tác kéo trở thành một op nhỏ, dễ phát qua WebSocket (tuần 3) và dễ xếp hàng khi offline (tuần 6).
- Tự viết hàm sinh (`packages/shared/src/position.ts`), dùng đúng định dạng của thư viện `fractional-indexing` nên dữ liệu tuần 1 vẫn dùng được. Có test so chéo với thư viện bằng fast-check.
- **Jitter**: nếu chỉ lấy điểm giữa thì hai người chèn cùng một khe sẽ sinh **cùng** một chuỗi. Nối thêm 4 chữ số base 62 ngẫu nhiên (62⁴ ≈ 14,8 triệu khả năng). Bẫy nhỏ: nếu điểm giữa là tiền tố của B (vd. "a1" và "a1V") thì nối đuôi có thể vượt quá B, nên phải lấy tiếp điểm giữa cho tới khi hết là tiền tố.
- **Sắp xếp lại**: chèn mãi vào một khe thì chuỗi dài thêm khoảng 1 ký tự sau mỗi 5–6 lần. Vị trí mới dài quá 32 ký tự thì server gán lại "a0", "a1", … cho cả cột, giữ nguyên thứ tự, tính cả thẻ đã xóa mềm để khi khôi phục chúng về đúng chỗ cũ. Việc này không tăng `version` của các thẻ khác, vì đổi vị trí không phải là sửa nội dung.
- Client chỉ gửi **ý định** (`afterCardId`, `beforeCardId`). Server tính vị trí từ hàng xóm hiện tại khi đang khóa cột, nên hàng xóm bị dời hay bị xóa vẫn đặt được thẻ vào chỗ hợp lý. Client vẫn tự tính vị trí bằng cùng một hàm để cập nhật lạc quan.

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

### Tuần 2 — `feature/thu-tu-the` (09/11/2026)
- Hàm sinh vị trí dùng chung cho server và web: `keyBetween` (tất định), `positionBetween` (có jitter), `evenPositions` (sắp xếp lại), `needsRebalance`. 28 unit test: các ca biết trước, so chéo với thư viện `fractional-indexing` (fast-check, seed cố định), thuộc tính "chèn ngẫu nhiên thì danh sách luôn tăng dần, không trùng", ca tiền tố, chạm ngưỡng sắp xếp lại.
- API `POST /cards/:id/move` nhận `{ columnId, afterCardId, beforeCardId }`. Hàng xóm không còn thì lần lượt thử before → đầu cột (nếu người dùng thả lên đầu) → cuối cột. Trả về `{ card, rebalanced }`.
- **Thứ tự khóa: cột trước, thẻ sau** ở mọi chỗ (kể cả PATCH đổi cột). Lý do: sắp xếp lại phải cập nhật mọi thẻ trong cột khi đang giữ khóa cột. Nếu có chỗ khóa thẻ X trước rồi mới chờ cột D, còn chỗ khác giữ D và chờ X, thì hai bên chờ nhau mãi (deadlock). Có test kéo qua lại song song giữa hai cột.
- Snapshot sắp theo `position, id` để hai thẻ trùng vị trí (rất hiếm) vẫn hiện cùng một thứ tự cho mọi người. Client sắp xếp bằng `comparePositioned` cho khớp với server.
- Giao diện dùng dnd-kit: chuột (kéo quá 6px mới tính là kéo, nên bấm vẫn mở thẻ), cảm ứng (nhấn giữ 200ms, để vuốt vẫn cuộn được), bàn phím (Space nhấc, mũi tên dời, Space/Enter thả, Esc hủy), có lời đọc cho trình đọc màn hình bằng tên thẻ. `DragOverlay` để thẻ không bị cột (`overflow: auto`) cắt mất khi kéo sang cột khác.
- Cập nhật lạc quan: ghi vào cache react-query **cùng lúc** với việc bỏ trạng thái kéo, và hủy lần tải đang chạy dở, nếu không thẻ sẽ nháy về chỗ cũ một khung hình.
- Bẫy gặp phải: test "2000 lần chèn cùng khe thì không trùng" thỉnh thoảng fail. Không phải hàm sai mà là nghịch lý ngày sinh: 2000 khóa trong 14,8 triệu khả năng có ~13% xác suất có một cặp trùng. Sửa test để đo đúng tình huống thật (mỗi lượt 2 người, 10.000 lượt, seed cố định).
- Bẫy gặp phải: test sắp xếp lại đặt **một** thẻ có vị trí dài thì không chạm ngưỡng, vì điểm giữa chỉ dài khi **hai hàng xóm có chung tiền tố dài**.
- **Lỗi đau nhất tuần 2 — deadlock khi kéo chéo (tìm ra lúc review):** ban đầu chỉ khóa **cột đích**. Người 1 kéo X từ B sang A, người 2 kéo Y từ A sang B cùng lúc, và cả hai lần thả đều chạm ngưỡng sắp xếp lại: bên 1 sắp xếp lại A phải sửa Y (bên 2 đang giữ), bên 2 sắp xếp lại B phải sửa X (bên 1 đang giữ) → Postgres báo `deadlock detected` (40P01) → lỗi 500, thẻ nhảy về chỗ cũ. Test "kéo qua lại song song" không bắt được vì không lượt nào chạm ngưỡng sắp xếp lại.
  - Cách tìm: viết test đặt sẵn vị trí dài ở cả hai cột rồi kéo chéo song song 15 lượt → gặp 40P01 nhiều lần.
  - Cách sửa: khóa **cả cột nguồn lẫn cột đích**, theo **id tăng dần** (`SELECT … WHERE id = ANY($1) ORDER BY id FOR UPDATE`), rồi mới khóa thẻ. Thẻ bị người khác chuyển cột trong lúc chờ khóa thì ném `RetryTransaction` để chạy lại với cột nguồn mới.
  - Lưới an toàn: `withTx` tự chạy lại tối đa 3 lần khi gặp 40P01/40001 (chờ ngẫu nhiên giữa các lần); hết lượt thì trả 409 `busy` thay vì 500. Hệ quả: hàm truyền vào `withTx` không được có tác dụng phụ ngoài DB (phát WebSocket ở tuần 3 phải làm SAU khi transaction xong).
  - Đã kiểm chứng test mới **fail** với cách khóa cũ (không chạy lại) và **pass** với cách mới.
- Giao diện: `order` chụp lúc bắt đầu kéo; cột được thêm trong lúc kéo (tuần 3, qua realtime) sẽ không có trong đó → `order[col.id]!` làm sập trang. Đã đổi sang dùng thứ tự đã lưu khi không có.
- Dev: `API_PORT` / `WEB_PORT` để chạy bản thứ hai song song (vd. nối Postgres Docker trong khi bản kia nối Supabase). Công cụ preview tự đặt `PORT` cho cả tiến trình nên không dùng `PORT` cho việc này được.
