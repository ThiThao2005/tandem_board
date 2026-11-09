# Tandem

Bảng Kanban cộng tác realtime: nhiều người cùng sửa một bảng, thấy thay đổi của nhau ngay, mất mạng vẫn làm tiếp được.

**Công nghệ:** React · Node.js (Express) · Socket.IO · PostgreSQL · Redis · Yjs

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

## Tiến độ

- [x] Tuần 1: đăng nhập, nhóm + mời thành viên, bảng → cột → thẻ
- [x] Tuần 2: kéo thả, vị trí kiểu phân số (có jitter), tự sắp xếp lại cột
- [ ] Tuần 3: đồng bộ realtime qua WebSocket
- [ ] Tuần 4: thấy ai đang online
- [ ] Tuần 5: ghi chú nhiều người cùng gõ (Yjs)
- [ ] Tuần 6: chế độ offline
- [ ] Tuần 7: kiểm thử hội tụ, kiểm thử tải, CI
- [ ] Tuần 8: Redis pub/sub, deploy
