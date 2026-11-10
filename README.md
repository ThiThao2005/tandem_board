# Tandem

Bảng Kanban cộng tác realtime: nhiều người cùng sửa một bảng, thấy thay đổi của nhau ngay, mất mạng vẫn làm tiếp được.

**Công nghệ:** React · Node.js (Express) · Socket.IO · PostgreSQL · Redis · Yjs + TipTap

> Đang làm theo lộ trình 8 tuần trong [PLAN.md](PLAN.md). Nhật ký kỹ thuật ở [NOTES.md](NOTES.md).

## Cấu trúc

```
apps/server      API Node.js + Express, migration SQL, test với Postgres thật
apps/web         React + Vite
packages/shared  Schema zod và kiểu dữ liệu dùng chung cho server và web
```

## Chạy trên máy

Cần Node.js ≥ 22 và Docker.

```bash
npm install
cp apps/server/.env.example apps/server/.env   # rồi đổi JWT_SECRET
npm run db:up        # Postgres ở cổng 5433
npm run migrate
npm run dev          # API :4000, web http://localhost:5173
```

### Dùng Supabase làm database

Supabase ở đây **chỉ là nơi chứa PostgreSQL**. Đăng nhập, phân quyền và realtime do server tự làm, không dùng Supabase Auth hay Realtime.

1. Trên Supabase bấm **Connect** → chọn **Session pooler** (cổng 5432), chép chuỗi kết nối.
2. Dán vào `DATABASE_URL` trong `apps/server/.env`, thay `[YOUR-PASSWORD]` bằng mật khẩu database. Không thêm `?sslmode=`, vì SSL được bật tự động.
3. `npm run migrate`, rồi `npm run dev`.

Migration `002_khoa_data_api.sql` bật RLS và thu hồi quyền của role `anon`/`authenticated`, để không ai đọc được bảng qua REST API của Supabase bằng anon key.

Chạy test (cần `npm run db:up` trước). Test **luôn** dùng Postgres trong Docker, vì mỗi lần chạy sẽ xóa sạch database test. Nếu `TEST_DATABASE_URL` không trỏ về máy local, test tự dừng.

```bash
npm test
```

Test gồm cả test realtime (mở server Socket.IO thật trên cổng ngẫu nhiên) và test hội tụ: 3 client cùng bắn thao tác ngẫu nhiên, cuối cùng phải thấy bảng giống hệt server.

## Đồng bộ realtime hoạt động thế nào

```
trình duyệt ──{ opId, type, payload }──▶ server (Socket.IO, cùng cổng với API, đường dẫn /socket.io)
                                          BEGIN
                                            suy ra bảng từ thẻ/cột, kiểm tra quyền
                                            last_seq + 1   (khóa dòng của bảng)
                                            làm thao tác, ghi vào operations
                                          COMMIT
mọi người trong phòng board:{id} ◀──{ seq, opId, type, kết quả }──  (chỉ phát sau commit)
```

Client hiện thay đổi ngay (lạc quan); nhận seq liên tục thì áp dụng, thấy seq nhảy cóc thì lấy bù; server từ chối thì bảng tự về đúng trạng thái. Chi tiết trong [NOTES.md](NOTES.md) (tuần 3).

## Ai đang online

```
mỗi tab ──presence.update { status: active|away, cardId }──▶ server (chỉ trong bộ nhớ, không lưu DB)
          (khi đổi + heartbeat 15 s)                          gộp theo người, danh sách đổi thì phát
mọi người trong phòng board:{id} ◀──presence { users: [{ userId, status, cardId }] }──
```

- Dãy avatar trên đầu bảng: chấm xanh = đang xem, chấm vàng = tab đang ẩn, mờ = không mở bảng.
- Thẻ có người khác đang mở để sửa thì có viền theo màu avatar của người đó; trong hộp thoại thẻ hiện "Bình is also editing this card".
- Rời bảng / mất kết nối / bị xóa khỏi nhóm thì biến mất ngay. Tab đang hiện im quá 30 s thì bị dọn; tab ẩn được chờ 150 s vì trình duyệt làm chậm hẹn giờ của tab ẩn.

## Ghi chú nhiều người cùng gõ

```
mở thẻ ──note.open { cardId, stateVector }──▶ server (Y.Doc trong bộ nhớ cho mỗi ghi chú đang mở)
       ◀── { phần mình thiếu, stateVector của server, con trỏ người khác }
       ──note.update { phần server thiếu / phím gõ đã gom }──▶  phát cho phòng note:{cardId}
                                                              lưu gộp vào card_notes.ydoc sau 0,5–3 s
mọi người trong phòng board:{id} ◀── op card.notes (seq) khi tiến độ checklist đổi
```

- Editor TipTap gắn vào Yjs (CRDT): hai người gõ cùng một đoạn thì tự trộn, không ai mất chữ. Con trỏ của người khác có tên + màu, "Lan is typing…" trong hộp thoại và "typing…" trên mặt thẻ.
- Checklist ("[ ] " đầu dòng): tiến độ "☑ 2/3" hiện trên mặt thẻ cho cả bảng.
- Viewer chỉ xem. Mất kết nối vẫn gõ tiếp, có mạng lại thì tự bù hai chiều. Chi tiết trong [NOTES.md](NOTES.md) (tuần 5).

## Tiến độ

- [x] Tuần 1: đăng nhập, nhóm + mời thành viên, bảng → cột → thẻ
- [x] Tuần 2: kéo thả, vị trí kiểu phân số (có jitter), tự sắp xếp lại cột
- [x] Tuần 3: đồng bộ realtime qua WebSocket (seq theo từng bảng, chống ghi trùng, cập nhật lạc quan)
- [x] Tuần 4: thấy ai đang online, viền màu quanh thẻ đang có người sửa
- [x] Tuần 5: ghi chú nhiều người cùng gõ (Yjs), con trỏ + "đang gõ", checklist có tiến độ trên mặt thẻ
- [ ] Tuần 6: chế độ offline
- [ ] Tuần 7: kiểm thử hội tụ, kiểm thử tải, CI
- [ ] Tuần 8: Redis pub/sub, deploy
