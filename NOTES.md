# Tandem — Nhật ký kỹ thuật

> Ghi trong lúc làm, sau này đưa vào tpath và README. Ghi ngắn, ghi ngay, kèm ngày.

## 1. Số liệu đo được

| Chỉ số | Giá trị | Cách đo | Ngày |
|---|---|---|---|
| Thời gian server xử lý 1 thao tác (DB cùng máy) | p50 7 ms, p95 9 ms | 40 lần `card.create`, Postgres Docker | 10/11/2026 |
| Độ trễ đồng bộ giữa 2 tab, DB ở Supabase Tokyo, server chạy ở VN | 0,8–2,0 s (trung vị ~1,5 s) | 6 lần thêm thẻ, đo trong trình duyệt | 10/11/2026 |
| Độ trễ đồng bộ p50 / p95 (server đặt cùng vùng với DB) | | k6 / Playwright (tuần 7–8) | |
| Số kết nối đồng thời đã thử | | k6 | |
| Số test (unit / e2e) | 47 unit + 109 API & realtime (gồm 20 test presence) / 0 e2e | Vitest | 10/11/2026 |
| Số lần chạy test hội tụ thành công | 3/3 lần (bản nhỏ: 3 client × 40 thao tác) | fast-check seed 20261109, Socket.IO thật | 09/11/2026 |

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
- BIGSERIAL cấp số lúc gọi `nextval`, không phải lúc commit. Thao tác lấy 1201 có thể commit **sau** thao tác lấy 1202. Client nhận 1202 trước, đặt `lastSeq = 1202`, rồi bỏ qua 1201 mãi mãi (lúc lấy bù cũng chỉ hỏi `seq > 1202`).
- Cách làm: `UPDATE boards SET last_seq = last_seq + 1 … RETURNING` ở **đầu** transaction. Dòng của bảng bị khóa tới khi COMMIT, nên ai lấy N+1 cũng phải chờ N commit xong → thứ tự commit trùng thứ tự seq, và seq liên tục không lỗ (thao tác bị từ chối thì rollback, seq được trả lại).
- Đổi lại, mọi thao tác trên **cùng một bảng** chạy lần lượt. Một bảng chỉ có vài người cùng sửa, mỗi thao tác vài ms, nên không đáng kể. Lợi thêm: hai thao tác trên cùng bảng không thể deadlock nữa.
- Thứ tự khóa trong cả server: **bảng → cột (id tăng dần) → thẻ**.

### Vì sao cần Redis?
-

### Vì sao chọn WebSocket (Socket.IO) mà không dùng polling hay SSE?
- Polling: chậm (phải chờ tới lượt hỏi) và tốn (hỏi liên tục kể cả khi không có gì mới). Muốn dưới 0,5 giây thì phải hỏi rất dày.
- SSE chỉ chiều server → client; client gửi thao tác vẫn phải qua HTTP, mất thứ tự giữa hai kênh và không có ack gắn với thao tác.
- WebSocket hai chiều trên một kết nối: thao tác gửi lên kèm ack, bản phát và ack đi trên cùng kết nối nên **người gửi luôn nhận bản phát trước ack**.
- Socket.IO thêm: phòng (`board:{id}`, `user:{id}`), ack có timeout, tự kết nối lại, và adapter Redis cho tuần 8.
- Chỉ bật transport `websocket` (không long-polling) để sau này chạy nhiều server không cần sticky session.

## 3. Lỗi “đau nhất”

| Ngày | Triệu chứng | Nguyên nhân | Cách tìm ra | Cách sửa |
|---|---|---|---|---|
| 09/11 | Kéo thả lúc chạm ngưỡng sắp xếp lại → lỗi 500, thẻ nhảy về chỗ cũ | Deadlock khi hai người kéo chéo giữa hai cột (xem tuần 2) | Viết test đặt sẵn vị trí dài ở cả hai cột rồi kéo chéo song song | Khóa cả cột nguồn lẫn cột đích theo id tăng dần; `withTx` tự chạy lại khi gặp 40P01 |
| 09/11 | (Bẫy thấy khi thiết kế, không phải sự cố thật) Hai lần gửi cùng opId song song → lần sau báo `id_taken` thay vì trả kết quả cũ | Chỉ kiểm tra opId trùng **trước** khi khóa bảng: cả hai cùng thấy "chưa có" | Test "gửi lại song song"; tắt bước kiểm tra lại thì test fail đúng như vậy | Kiểm tra lại **sau** khi giữ khóa bảng (lúc đó lần trước đã commit) |

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

### Tuần 3 — `feature/dong-bo-realtime` (09/11/2026)
- Migration 003: `boards.last_seq`, bảng `operations (board_id, seq, op_id UNIQUE, actor_id, type, payload JSONB)` (có RLS), `cards.field_versions`.
- **Một đường cho mọi thay đổi**: `executeOp` (apps/server/src/ops.ts). REST vẫn giữ nhưng chỉ là lớp mỏng gọi vào đó, nên thay đổi qua REST cũng có seq và cũng được phát. Thứ tự: suy ra bảng từ thẻ/cột trong DB (không tin `boardId` client gửi) → kiểm tra quyền → `last_seq + 1` → làm → `INSERT operations` → COMMIT → phát cho phòng (chỉ sau commit).
- `payload` trong operations là **kết quả** server đã quyết định (thẻ sau khi sửa, vị trí server tính, danh sách sắp xếp lại), không phải ý định client gửi. Nhờ vậy client nào áp dụng cùng dãy thao tác cũng ra cùng một bảng; `applyOp` là hàm thuần trong `packages/shared`.
- **Chống ghi trùng**: gửi lại cùng `opId` → trả đúng kết quả cũ, không chạy lại, không phát lại. Có đường tắt trước transaction (để gửi lại được cả khi thẻ đã bị xóa hẳn) và kiểm tra lại sau khi khóa bảng (cho trường hợp gửi song song). `opId` của người khác / loại thao tác khác / bảng khác → `op_id_taken`, để không ai gửi lại opId nghe được nhằm đọc kết quả. REST nhận header `X-Op-Id`.
- **Xung đột theo từng trường**: `field_versions` lưu `{ v, by }` cho title, dueDate, assigneeId, columnId. Chỉ báo 409 khi chính trường đang sửa bị **người khác** sửa sau `baseVersion`. Có `by` vì nếu không, người dùng sửa tiêu đề hai lần liên tiếp (lần trước còn đang trên đường) sẽ xung đột với chính mình. Kéo thẻ không đụng tới tiêu đề nên không còn làm hỏng lần sửa đang dở như tuần 1.
- **Ảnh chụp bảng nhất quán**: trước đây 4 truy vấn chạy song song trên 4 kết nối, một thao tác commit xen giữa sẽ làm thẻ đã đổi mà seq vẫn cũ. Nay đọc trong một transaction `REPEATABLE READ READ ONLY`.
- **Gửi bù**: `board.join { boardId, lastSeq }` trả các thao tác `seq > lastSeq`, hoặc ảnh chụp nếu thiếu quá 500 (hay lastSeq vô lý). Vào phòng **trước** rồi mới đọc phần thiếu (không lọt thao tác ở giữa), và kiểm tra quyền **sau** khi vào phòng (không lọt khi đúng lúc đó bị xóa khỏi nhóm). Cũng có `GET /boards/:id/ops?after=`.
- **Socket**: xác thực bằng access token lúc bắt tay; hẹn giờ ngắt đúng lúc token hết hạn (`session.expired`), client gửi `auth.refresh` để gia hạn (token phải cùng người). Quyền kiểm tra lại từ DB ở **mỗi** thao tác. Bị xóa khỏi nhóm → `socketsLeave` khỏi phòng các bảng của nhóm ngay + `access.revoked`. Đổi vai trò → `access.role`; thêm/bớt thành viên → `members.changed`; xóa bảng → `board.deleted`. Giới hạn 20 thao tác/giây (dồn tối đa 40) mỗi người, gói tối đa 64 KB.
- **Client**: lõi `BoardReplica` (packages/shared, không I/O): trạng thái đã xác nhận + hàng chờ lạc quan + buffer khi seq nhảy cóc. `view` luôn tính lại = đã xác nhận + áp lần lượt các thao tác đang chờ, nên thao tác người khác tới lúc mình đang chờ không bị đè, và bị từ chối thì chỉ cần bỏ thao tác chờ là bảng tự về đúng (không phải tự viết thao tác ngược). Vị trí lạc quan tính **một lần** lúc người dùng thao tác rồi đóng gói, vì `view` bị tính lại nhiều lần mà jitter thì ngẫu nhiên.
- Web (`apps/web/src/sync`): gửi thao tác **lần lượt** (thêm thẻ rồi kéo nó thì cái sau phụ thuộc cái trước); mất ack thì gửi lại cùng opId; kết nối lại thì vào lại phòng với lastSeq rồi gửi tiếp phần chưa gửi. Thiếu seq quá 300 ms thì đi lấy bù. Làm mới token chủ động 1 phút trước khi hết hạn. Huy hiệu "Live / Saving… / Reconnecting…". Bị từ chối có thông báo: thẻ đã bị xóa → "Restore"; xung đột → "Use mine" (gửi lại không kèm baseVersion). Thẻ đang mở bị người khác xóa → hộp thoại đóng, báo ai xóa, cho khôi phục.
- Test: 30 test realtime (Socket.IO + Postgres thật) cho các ca ở PLAN mục 6, và test hội tụ: 3 client dùng đúng `BoardReplica` của web, 40 thao tác ngẫu nhiên mỗi người cùng lúc (fast-check, seed cố định), cuối cùng cả 3 thấy bảng giống hệt ảnh chụp server và `operations` liên tục 1..N.
- Đã thử bằng trình duyệt: An trên trình duyệt, Bình là script nối socket thật. Thêm/đổi tên/kéo của Bình hiện ngay bên An; thêm/kéo (bằng bàn phím) của An tới Bình với seq liên tục; xóa cột còn thẻ bị từ chối thì cột hiện lại kèm thông báo.
- Bẫy gặp phải: unit test của `applyOp` bắt được một lỗi — khi cột bị sắp xếp lại, code bỏ qua vị trí mới của chính thẻ vừa kéo. Dữ liệu thật không lộ ra (server đọc thẻ sau khi sắp xếp lại) nhưng `rebalanced` mới là nguồn đúng cho cả cột.
- Bẫy gặp phải: xóa thẻ đang mở rồi "Undo" thì hộp thoại tự bật lại. Hộp thoại bị gỡ khỏi cây (thẻ biến mất) trước khi sự kiện `close` của `<dialog>` kịp chạy, nên `openCardId` không được xóa. Sửa: thẻ đang mở biến khỏi bảng thì quên luôn.
- Test cũ "gửi baseVersion cũ thì báo xung đột" được thay bằng 6 test xung đột theo từng trường (luật đã đổi có chủ đích).
- Chưa làm (để tuần 6): hàng chờ chưa lưu IndexedDB nên tải lại trang khi đang offline là mất phần chưa gửi.

#### Review tuần 3 (10/11/2026) — các lỗi tìm ra và đã sửa
- **Hàng chờ kẹt sau khi lấy bù bằng ảnh chụp** (`BoardReplica.reset`). Ack của thao tác mình tới lúc đang thiếu seq → nằm trong buffer; lấy bù trả ẢNH CHỤP (lỡ > 500) → `reset` bỏ nó khỏi buffer nhưng quên bỏ khỏi hàng chờ, mà bên gửi đã đánh dấu "đã ack" nên không gửi lại. Hậu quả: "Saving…" treo mãi và bản lạc quan cũ che thay đổi của người khác (giao diện "Của tôi", server "Của Bình"). Sửa: thao tác nằm trong ảnh chụp thì bỏ khỏi hàng chờ; `BoardSync` dọn danh sách đã ack sau `reset`. Có 2 unit test (test fail với code cũ).
- **Lần gửi cũ đặt lại cờ `sending`**: mất kết nối giữa lúc chờ ack → kết nối lại gửi lại → 15 s sau lần gửi cũ hết hạn và đặt `sending = false` trong khi lần mới còn chạy → hai thao tác có thể đi song song, cái sau (kéo thẻ) tới trước cái nó phụ thuộc (thêm thẻ). Sửa: số thế hệ (`sendGeneration`), lần gửi cũ không đụng vào cờ nữa.
- **`board.join` không bị giới hạn tốc độ**, mà mỗi lần là một lần đọc cả bảng. Sửa: xô riêng (2/giây, dồn 10) — không dùng chung xô với thao tác, để người vừa sửa dồn dập rồi kết nối lại vẫn vào lại được. Client gặp `rate_limited` khi vào phòng thì chờ rồi thử lại (trước đây coi như mất quyền vào bảng). Bộ giới hạn dọn xô đã đầy để Map không phình theo số người.
- **Xóa cả nhóm không báo cho người đang mở bảng**: thêm `board.deleted` cho từng bảng của nhóm (lấy danh sách bảng ngay trong câu `DELETE … RETURNING` bằng CTE). Có test.
- **Bớt lượt gọi DB mỗi thao tác** (DB ở xa thì mỗi lượt 100–300 ms): bỏ tra opId trước transaction (chỉ tra ở nhánh lỗi 404, cho trường hợp thẻ/cột đã bị xóa hẳn), gộp "tìm bảng + kiểm tra quyền" thành một truy vấn, `RETURNING` thay cho đọc lại thẻ, `field_versions` đọc cùng lúc khóa thẻ, khóa cột + lấy vị trí cuối cột trong một truy vấn. Thêm thẻ 12 → 8 lượt, sửa 12 → 8, kéo 14 → 11, xóa 11 → 8.
- **Bài học về độ trễ**: server xử lý một thao tác chỉ ~7 ms; 1–2 giây đo được là do mỗi lượt gọi DB phải đi từ máy ở VN sang Tokyo. Khi deploy (tuần 8) phải đặt server CÙNG VÙNG với DB, rồi mới đo p50/p95 cho README.
- Đã thử trên trình duyệt với người thứ hai thật (script Socket.IO "Bot"): Bot thêm/đổi tên → hiện ngay; Bot xóa thẻ mình đang mở → hộp thoại đóng, báo "Bot Tester deleted …" kèm Restore; chủ nhóm xóa Bot → Bot nhận `access.revoked`, thao tác sau đó bị từ chối. Khởi động lại server khi đang thêm thẻ → "Offline · 1 unsent" → "Saving…" → "Live", thẻ lên server đúng một lần.
- Dev: công cụ preview đặt `PORT=5173` cho cả tiến trình nên API cũng nghe 5173 → cấu hình chạy thử phải đặt `API_PORT=4000`.

### Tuần 4 — `feature/online-presence` (10/11/2026)
- **Chỉ trong bộ nhớ, không lưu DB** (`apps/server/src/presence.ts`): `PresenceStore` lưu theo TỪNG KẾT NỐI (mỗi tab một socket) rồi gộp theo người khi đọc — mở 2 tab, đóng 1 tab vẫn online; một tab hiện là "active". Mở thẻ ở nhiều tab thì lấy tab mở gần nhất. Lớp thuần, nhận thời gian từ ngoài nên test được bằng đồng hồ giả. Tuần 8 thay bằng Redis, giữ cách gộp.
- **Gửi cả trạng thái, không gửi phần thay đổi**: `presence.update { boardId, status, cardId }` vừa là thông báo vừa là heartbeat (15 s). Mất một tin, hay server khởi động lại (mất hết bộ nhớ), thì tin kế tiếp dựng lại được. Server phát lại **cả danh sách** của bảng mỗi khi nó đổi (vài người, rất nhỏ); heartbeat không đổi gì thì **không phát** — 5 người × 4 heartbeat/phút không thành 20 tin phát/phút.
- **Một chỗ dọn duy nhất**: rời phòng vì bất kỳ lý do gì (`board.leave`, mất kết nối, bị xóa khỏi nhóm, bảng bị xóa) đều đi qua sự kiện `leave-room` của adapter Socket.IO, nên không phải nhớ dọn presence ở từng chỗ. Mất kết nối → người khác thấy ngay, không phải chờ hết hạn heartbeat.
- **Hết hạn heartbeat**: tab "active" im quá 30 s thì bị dọn (bộ quét chạy mỗi 5 s). Tab "away" được chờ **150 s**: tab ẩn thì trình duyệt làm chậm hẹn giờ (Chrome tới 1 lần/phút), heartbeat 15 s thành 60 s; dùng chung 30 s thì người chỉ chuyển sang tab khác sẽ bị coi là offline nhầm (ca ở PLAN mục 6, có test chạy 30 phút heartbeat thưa bằng đồng hồ giả). Tab ẩn được báo bằng Page Visibility API. Socket vẫn mở mà bị dọn (vd. tab bị đóng băng rồi tỉnh lại) thì heartbeat kế tiếp đưa người đó trở lại.
- **Bẫy bảo mật tìm ra lúc thiết kế**: `board.join` cho socket vào phòng TRƯỚC rồi mới kiểm tra quyền (để không lỡ thao tác, xem tuần 3). Nếu presence chỉ kiểm tra `socket.rooms`, người ngoài nhóm gửi `board.join` rồi gửi ngay `presence.update` trong lúc server đang kiểm tra quyền thì vẫn chen được vào danh sách của bảng nhóm khác. Sửa: `socket.data.boards` chỉ được thêm **sau** khi kiểm tra quyền xong (và socket vẫn còn trong phòng), bị bỏ khi rời phòng. Thử bỏ chốt chặn này thì 3 test fail.
- **Vào lại phòng không xóa trạng thái**: BoardSync gọi lại `board.join` để lấy bù khi seq nhảy cóc; nếu lúc đó đặt lại presence về mặc định thì người đang mở thẻ sẽ mất viền. `ensure` chỉ thêm khi chưa có; danh sách không đổi thì vẫn gửi riêng cho socket vừa vào.
- **Không tra DB** khi nhận presence (gửi mỗi 15 s, DB ở xa mỗi lượt 100–300 ms): quyền đã kiểm tra lúc vào phòng, bị xóa khỏi nhóm thì bị đưa ra khỏi phòng. `cardId` không được kiểm tra có thuộc bảng không — id lạ thì người khác chỉ không thấy thẻ nào để tô viền, server không trả gì về nên không lộ được gì. Giới hạn 5 tin/giây (dồn 20) mỗi người.
- **Web**: `PresenceTracker` (apps/web/src/sync/presence.ts) do BoardSync điều khiển: chỉ gửi sau khi vào phòng thành công; mất kết nối thì xóa danh sách (không hiện thông tin cũ), gửi bằng `volatile` (đang mất kết nối thì bỏ, vào lại phòng sẽ gửi bản mới). Mở hộp thoại thẻ (khi có quyền sửa) → gửi `cardId`.
- **Giao diện**: dãy avatar thành viên — chấm xanh (đang xem), chấm vàng (tab ẩn), mờ (không mở bảng), người online đứng trước theo thứ tự vào bảng; nhãn cho trình đọc màn hình "2 of 3 members online". Thẻ có người khác đang mở: viền theo màu avatar của người đó (bóng đổ vào trong, để cột `overflow: auto` không cắt mất viền) + avatar nhỏ ở góc; người đó ẩn tab thì viền nhạt. Trong hộp thoại thẻ: "Bình is also editing this card" — báo trước khả năng xung đột theo trường của tuần 3.
- Test: 11 unit test cho `PresenceStore` (đồng hồ giả) + 9 test qua Socket.IO thật: vào bảng nhận ngay danh sách, mở thẻ/ẩn tab, heartbeat không phát lại, 2 tab, mất kết nối, người ngoài nhóm/chưa vào bảng, dữ liệu sai, bị xóa khỏi nhóm, bảng bị xóa, hết hạn heartbeat.
- Đã thử trên trình duyệt với script Socket.IO "Bình Bot": Bot mở thẻ → viền tím + avatar BB ở góc thẻ; mình mở cùng thẻ → "Bình Bot is also editing this card", Bot thấy mình đang mở thẻ; Bot ẩn tab → chấm vàng, viền nhạt, "(away)"; mình ẩn tab (giả lập `visibilitychange`) → Bot thấy away rồi active; Bot thoát → avatar mờ, viền biến mất.
- Bẫy nhỏ: thêm "(you)" vào tên để làm chú thích thì chữ viết tắt thành "L(" — tách chú thích khỏi tên.
- Chưa làm: dòng "Lan đang gõ…" cho ghi chú (tuần 5, dùng Yjs Awareness); viền khi người khác đang **kéo** thẻ (hiện chỉ khi mở hộp thoại).

#### Review tuần 4 (10/11/2026) — lỗ hổng tìm ra và đã sửa
- **Người ngoài nhóm nghe lén được thao tác của bảng** (lỗi từ tuần 3, tuần 4 mới chặn được nửa phần presence). `board.join` cho socket vào phòng TRƯỚC rồi mới kiểm tra quyền; với DB ở xa, trong 100–300 ms chờ đó người ngoài nhóm ở trong phòng nên nhận mọi thao tác được phát. Gọi `board.join` liên tục (2 lần/giây) là nghe được phần lớn thời gian.
  - Vì sao test cũ không bắt được: test kiểm tra SAU khi join bị từ chối, và DB trên máy trả lời trong vài ms nên khoảng hở gần như không có.
  - Cách tìm: test mới `join-race.test.ts` làm bước kiểm tra quyền chậm 200 ms (mock `requireBoard`, như DB ở xa) rồi phát thao tác đúng lúc đó → người lạ nhận được thẻ "bí mật". (Mock `catchUp` không ăn vì vòng import ops → routes/workspaces → realtime → ops.)
  - Cách sửa: kiểm tra quyền TRƯỚC khi vào phòng, vẫn kiểm tra lại sau khi vào phòng (trong `catchUp`) cho trường hợp bị xóa khỏi nhóm đúng lúc đó. Tốn thêm một lượt gọi DB mỗi lần vào phòng (hiếm). Có test thứ hai bảo đảm thành viên vào phòng lúc đang có thao tác vẫn không lỡ thao tác nào.
- Đã thử trên trình duyệt với người thứ hai thật (script "Review Bot"): "2 of 2 members online"; Bot mở thẻ → viền + nhãn "Review Bot editing"; mình mở cùng thẻ → "Review Bot is also editing this card", Bot thấy mình đang mở thẻ rồi đóng thẻ; Bot ẩn tab → "away" + viền nhạt; Bot thoát → "offline", viền biến mất.
- Giao diện thẻ đang có người sửa làm đậm và sống động hơn (trước chỉ ~2 px, nhìn thu nhỏ khó thấy): viền 2 px + quầng màu "thở" (2,4 s), nền ngả màu người sửa, nhãn "● editing" treo trên mép thẻ với avatar và chấm nhấp nháy; người sửa ẩn tab thì viền đứt nét, nhãn "away", hết chuyển động. Danh sách thẻ được chừa đệm để quầng sáng và nhãn không bị cột (`overflow: auto`) cắt. Tắt chuyển động khi máy bật "giảm chuyển động".
- Làm rõ toàn bộ giao diện (góp ý: thẻ và ô còn nhạt): mọi thẻ viền 2 px theo màu cột, vạch trái 6 px, "mép dưới" đậm như tấm thẻ giấy; cột viền 2 px + đường kẻ dưới tiêu đề; ô nhóm/bảng viền 2 px + dải màu 6 px trên đầu. Thẻ đang có người sửa: viền 3 px + vòng màu đặc 4 px + quầng sáng "thở" (2 s), nhãn "editing" to hơn; người sửa ẩn tab thì viền nét đứt 3 px. Các kiểu này đặt ở cuối styles.css để đè lên kiểu cũ.
