# Tandem — Kế hoạch dự án

> Bảng Kanban cộng tác realtime. Tên sản phẩm: **Tandem**. Giao diện tự thiết kế, không sao chép Trello.

## 1. Thế nào là làm xong (bản đầu tiên)

Một nhóm 3–5 người cùng mở một bảng. Ai thêm thẻ, kéo thẻ, sửa tiêu đề hay viết ghi chú thì những người còn lại thấy ngay, **dưới 0,5 giây**. Không ai mất dữ liệu của người khác. Ai mất mạng vẫn làm tiếp được, có mạng lại thì tự đồng bộ.

| Làm trong bản đầu | Để sau |
|---|---|
| Đăng nhập | Đính kèm file |
| Workspace + mời thành viên | Thông báo qua email |
| Bảng → cột → thẻ | App mobile (có thể làm bằng Flutter, dùng chung giao thức) |
| Ghi chú trong thẻ | Tích hợp bên ngoài |
| Thấy ai đang online | |
| Lịch sử thay đổi | |

## 2. Ba bài toán cốt lõi

### A. Nhiều người sửa cùng lúc mà không ghi đè

| Dữ liệu | Xung đột hay gặp | Cách xử lý |
|---|---|---|
| Vị trí thẻ | 2 người cùng kéo vào giữa 2 thẻ | **Fractional indexing**: `position` là chuỗi (`"a0"`, `"a0V"`), chèn vào giữa thì sinh chuỗi nằm giữa. Thêm phần ngẫu nhiên (jitter) để 2 lần chèn cùng khe không trùng. Thỉnh thoảng sắp xếp lại cả cột khi chuỗi quá dài. |
| Trường ngắn (tiêu đề, nhãn, người phụ trách, hạn) | 2 người cùng sửa tiêu đề | Bản sửa đến server sau cùng được giữ, **xét riêng từng trường**. Chỉ báo xung đột khi *chính trường đó* bị sửa sau `baseVersion`. |
| Ghi chú dài | 2 người gõ cùng đoạn | **Yjs** (CRDT), không tự viết thuật toán trộn. |
| Xóa | A xóa khi B đang sửa | Xóa mềm bằng `deleted_at`. B lưu vào thẻ đã xóa thì hiện “Thẻ đã bị A xóa – Khôi phục?” |

**Nguyên tắc: server là trọng tài.** Trình duyệt chỉ gửi yêu cầu thao tác. Server kiểm tra quyền → chạy transaction → đánh `seq` tăng dần → phát cho mọi người. Không bao giờ tin giờ của máy người dùng.

**Cập nhật lạc quan (optimistic UI):** người kéo thấy thẻ dời chỗ ngay. Nếu server từ chối thì trả thẻ về chỗ cũ kèm thông báo.

### B. Thấy ai đang online

- Dữ liệu tạm thời: chỉ giữ trong bộ nhớ hoặc Redis, **không lưu DB**.
- Heartbeat khoảng 15 giây một lần, quá 30 giây không thấy thì coi là offline.
- Hiển thị: dãy avatar trên đầu bảng, viền màu quanh thẻ đang có người sửa, dòng “Lan đang gõ…”.
- Ghi chú dùng Yjs Awareness.
- Tab bị ẩn: dùng Page Visibility API để chuyển trạng thái sang *away* thay vì *offline*, tránh bị coi là offline nhầm.

### C. Mất mạng rồi có mạng lại

1. Khi offline, mỗi thao tác được lưu vào hàng đợi **IndexedDB**, kèm `opId` (UUID).
2. Khi có mạng lại, trình duyệt gửi `lastSeq`. Server gửi bù các thao tác có `seq > lastSeq`. Nếu thiếu quá nhiều (ví dụ > 500) thì gửi **ảnh chụp toàn bộ bảng**.
3. Trình duyệt gửi lại hàng đợi. Server bỏ qua `opId` đã nhận rồi (chống ghi trùng).
4. Thao tác bị từ chối (ví dụ sửa thẻ đã bị xóa) thì hiện danh sách “N thay đổi không áp dụng được”. **Không âm thầm bỏ đi.**

Bổ sung:
- **Client tự sinh UUID cho thẻ/cột mới**, nên khi offline không cần đổi ID tạm sang ID thật về sau.
- **Thao tác kéo thẻ gửi kèm ý định** (`afterCardId`, `beforeCardId`). Nếu hai thẻ hàng xóm đã đổi chỗ, server tự tính lại vị trí thay vì từ chối.
- **Mở nhiều tab:** chỉ một tab gửi hàng đợi, dùng Web Locks API hoặc BroadcastChannel.

## 3. Công nghệ

**Frontend:** React (Vite) hoặc Next.js · dnd-kit · Yjs + y-indexeddb · idb

**Backend:** Node.js · Socket.IO · PostgreSQL · Redis · Hocuspocus (server Yjs)

**Kiểm thử:** Vitest · fast-check · Playwright · k6 · GitHub Actions

Redis dùng để chuyển tin giữa nhiều server (`@socket.io/redis-adapter`, `@hocuspocus/extension-redis`): người nối vào server 1 vẫn nhận được thao tác của người ở server 2.

## 4. Mô hình dữ liệu

```
users
workspaces
workspace_members  (workspace_id, user_id, role: owner | editor | viewer)
invitations        (workspace_id, token, email, role, expires_at)
boards             (workspace_id, title, last_seq BIGINT DEFAULT 0)
columns            (board_id, title, position TEXT COLLATE "C", wip_limit INT NULL)
cards              (column_id, title, due_date, assignee_id, position TEXT COLLATE "C",
                    version INT, deleted_at, created_by, updated_by, updated_at)
card_notes         (card_id, ydoc BYTEA, updated_at)
labels, card_labels
comments
operations         (board_id, seq BIGINT, op_id UUID, actor_id, type, payload JSONB, created_at,
                    PRIMARY KEY (board_id, seq), UNIQUE (op_id))
```

> ⚠️ **Hai điểm dễ sai:**
> - `position` phải dùng `COLLATE "C"`. Nếu không, PostgreSQL so chuỗi theo ngôn ngữ (locale) và xếp sai thứ tự.
> - **`seq` đánh riêng cho từng bảng**, không dùng `BIGSERIAL` toàn cục. Với BIGSERIAL, thao tác lấy seq 1201 có thể commit *sau* thao tác 1202. Client nhận 1202 trước, đặt `lastSeq = 1202`, và thao tác 1201 bị bỏ qua mãi mãi.
>   Cách làm: trong transaction chạy `UPDATE boards SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`. Dòng của bảng bị khóa, nên các thao tác trên cùng một bảng tự xếp hàng.

Bảng `operations` là xương sống, phục vụ 3 việc: gửi bù khi có mạng lại, chống ghi trùng, hiển thị lịch sử (“Lan đã chuyển thẻ X sang Done lúc 10:05”).

## 5. Giao thức trao đổi

```
Trình duyệt → server:  { opId, boardId, type: "card.move",
                         payload: { cardId, toColumnId, afterCardId, beforeCardId, position },
                         baseVersion }

Server:  kiểm tra quyền (lấy boardId từ thẻ, KHÔNG tin boardId client gửi)
         → BEGIN → last_seq + 1 → INSERT operations → UPDATE cards → COMMIT
         → phát cho phòng board:{id}   (chỉ phát SAU khi commit)

Server → mọi người:  { seq, opId, actor, type, payload }

Người gửi:   thấy opId của mình → xác nhận, bỏ khỏi hàng đợi
Người khác:  seq == lastSeq + 1 thì áp dụng ngay
             seq nhảy cóc thì gọi lấy bù phần còn thiếu
```

- **`opId` bị trùng:** trả lại đúng kết quả cũ (seq cũ), không báo lỗi.
- **Kiểm tra dữ liệu đầu vào** bằng zod, giới hạn số thao tác mỗi giây cho từng người.
- **Token hết hạn:** client gửi `auth.refresh` qua socket. Hết hạn mà không làm mới thì server ngắt kết nối với mã riêng.
- **Bị xóa khỏi nhóm:** server đá các socket của người đó ra khỏi phòng ngay. Quyền được cache trong Redis và bị xóa cache khi thành viên thay đổi.

## 6. Các trường hợp dễ lỗi (mỗi dòng là một test case)

- [ ] Hai người kéo cùng một thẻ sang hai cột khác nhau cùng lúc
- [ ] Hai người chèn thẻ vào cùng một khe, sinh vị trí trùng (jitter)
- [ ] Kéo thẻ nhiều lần vào cùng một khe làm chuỗi vị trí dài ra (sắp xếp lại cột)
- [ ] Gửi lại một thao tác đã tới server (opId trùng)
- [ ] Tin nhắn đến sai thứ tự hoặc thiếu seq
- [ ] Offline 2 ngày, lỡ hàng nghìn thao tác (gửi ảnh chụp)
- [ ] Bị mất quyền khi vẫn đang kết nối
- [ ] Token hết hạn khi socket còn mở
- [ ] Tab ẩn lâu, heartbeat trễ, bị coi là offline nhầm
- [ ] Gửi thao tác vào bảng của nhóm khác (IDOR: boardId hợp lệ + cardId của nhóm khác)
- [ ] Hai thao tác commit lệch thứ tự seq (lý do phải đánh seq theo từng bảng)
- [ ] Cùng một người mở 2 tab, cả hai cùng gửi hàng đợi

## 7. Kiểm thử

- **Unit:** fractional index, quy tắc xung đột, chống ghi trùng.
- **Hai người dùng:** Playwright mở 2 trình duyệt. A kéo thẻ thì B phải thấy. A offline, sửa, online lại thì B nhận đúng.
- **Hội tụ (điểm cộng lớn):** 5 người, mỗi người 200 thao tác ngẫu nhiên, mạng rớt ngẫu nhiên. Kết thúc thì cả 5 phải thấy bảng giống hệt nhau.
  Dùng fast-check với **seed cố định** để khi test fail có thể chạy lại y hệt. Có thể thêm toxiproxy để giả lập mạng chậm.
- **Tải:** k6 mở 100 kết nối cùng lúc, đo độ trễ p50/p95.
- **CI:** GitHub Actions chạy tất cả mỗi lần push, có service Postgres và Redis.

## 8. Lộ trình 8 tuần

| Tuần | Nhánh | Kết quả |
|---|---|---|
| 1 | `feature/nen-tang` | Đăng nhập, workspace, thêm/sửa/xóa bảng → cột → thẻ (chưa realtime) |
| 2 | `feature/thu-tu-the` | Kéo thả, fractional indexing, unit test |
| 3 | `feature/dong-bo-realtime` | WebSocket, bảng operations, seq theo từng bảng, server làm trọng tài, optimistic UI |
| 4 | `feature/online-presence` | Avatar online, viền màu quanh thẻ đang có người sửa |
| 5 | `feature/ghi-chu-yjs` | Ghi chú nhiều người cùng gõ, lưu trạng thái Yjs |
| 6 | `feature/offline` | Hàng đợi IndexedDB, gửi bù theo lastSeq, chống ghi trùng, màn hình báo xung đột |
| 7 | `feature/kiem-thu` | Playwright 2 người dùng, test hội tụ, test tải, CI |
| 8 | `feature/redis-deploy` | Redis adapter, deploy, README có sơ đồ và số liệu đo được |

Nếu bị trễ: tuần 1–5 là bắt buộc. Cắt tuần 8 trước, sau đó tới test tải.

**Tính năng thêm nếu dư thời gian:** giới hạn WIP cho cột · hoàn tác (undo) của riêng mình bằng thao tác ngược · OpenTelemetry + số liệu đo.

## 9. Câu hỏi phỏng vấn nên chuẩn bị

- WebSocket khác polling và SSE ở điểm nào? Vì sao chọn WebSocket?
- CRDT là gì? Khác gì cách khóa bản ghi khi đang sửa?
- Làm sao đảm bảo mọi người cuối cùng thấy bảng giống nhau?
- Muốn có 10.000 người dùng cùng lúc thì phải thay đổi gì? (Redis adapter, sticky session, chia bảng `operations` theo thời gian, cache quyền, tách Hocuspocus thành dịch vụ riêng)
- Nếu server sập giữa chừng thì có mất dữ liệu không? (Chỉ phát sau khi commit, client tự phát hiện seq bị thiếu)

## 10. Những điều nên tránh

- ❌ Dùng số nguyên cho thứ tự thẻ
- ❌ Tự viết thuật toán trộn văn bản
- ❌ Lưu trạng thái online vào database
- ❌ Chỉ kiểm tra quyền lúc kết nối
- ❌ Dùng `BIGSERIAL` toàn cục làm seq để gửi bù
- ❌ Làm giao diện giống hệt Trello
