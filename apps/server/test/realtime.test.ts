import { randomUUID } from "node:crypto";
import {
  applyOp,
  boardState,
  MAX_CATCHUP_OPS,
  type BoardOp,
  type BoardSnapshot,
  type Card,
} from "@tandem/shared";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import { pool } from "../src/db";
import { addMember, createBoard, registerUser, type TestUser } from "./helpers";
import {
  connect,
  errorCode,
  join,
  okOp,
  refreshToken,
  sendOp,
  sleep,
  useRealtimeServer,
  waitFor,
  type ClientSocket,
} from "./socket-helpers";

useRealtimeServer();

async function snapshotOf(u: TestUser, boardId: string): Promise<BoardSnapshot> {
  return (await u.get(`/api/boards/${boardId}`).expect(200)).body as BoardSnapshot;
}

/** Chủ bảng + một người sửa, cả hai đã mở socket và vào phòng của bảng. */
async function twoPeople() {
  const a = await registerUser("An");
  const b = await registerUser("Bình");
  await addMember(a, b, "editor");
  const snap = await createBoard(a);
  const boardId = snap.board.id;
  const [todo, doing, done] = snap.columns.map((c) => c.id) as [string, string, string];
  const sa = await connect(a.token);
  const sb = await connect(b.token);
  expect((await join(sa, boardId)).ok).toBe(true);
  expect((await join(sb, boardId)).ok).toBe(true);
  return { a, b, sa, sb, boardId, todo, doing, done, snap };
}

const createCard = (columnId: string, title: string, id = randomUUID()) => ({
  opId: randomUUID(),
  type: "card.create" as const,
  payload: { columnId, id, title },
});

describe("phát thao tác qua WebSocket", () => {
  it("A thêm thẻ → B nhận ngay; A cũng nhận bản phát TRƯỚC ack", async () => {
    const { sa, sb, boardId, todo } = await twoPeople();
    const req = createCard(todo, "Thẻ mới");
    const ack = await sendOp(sa, boardId, req);
    const op = okOp(ack);

    expect(op).toMatchObject({ seq: 1, opId: req.opId, type: "card.create", boardId });
    expect(ack.ok && ack.duplicate).toBe(false);
    // Cùng một kết nối: bản phát được gửi trước ack nên đã nằm sẵn trong danh sách nhận được.
    expect(sa.received.map((o) => o.opId)).toEqual([req.opId]);
    await waitFor(() => sb.received.length === 1, 2000, "B nhận thao tác");
    expect(sb.received[0]).toEqual(op);
  });

  it("thao tác qua REST cũng được phát cho phòng, cùng dãy seq", async () => {
    const { a, sb, boardId, todo } = await twoPeople();
    const card = (await a.post(`/api/columns/${todo}/cards`, { title: "Qua REST" }).expect(201)).body as Card;
    await a.patch(`/api/cards/${card.id}`, { title: "Đổi tên" }).expect(200);
    await waitFor(() => sb.received.length === 2, 2000, "B nhận 2 thao tác");
    expect(sb.received.map((o) => [o.seq, o.type])).toEqual([
      [1, "card.create"],
      [2, "card.update"],
    ]);
  });

  it("ảnh chụp có seq; áp dụng các thao tác sau đó lên ảnh chụp thì ra đúng ảnh chụp mới", async () => {
    const { a, sa, boardId, todo, doing } = await twoPeople();
    const before = await snapshotOf(a, boardId);
    expect(before.seq).toBe(0);

    const c1 = okOp(await sendOp(sa, boardId, createCard(todo, "Một"))).payload as { card: Card };
    okOp(await sendOp(sa, boardId, createCard(todo, "Hai")));
    okOp(
      await sendOp(sa, boardId, {
        opId: randomUUID(),
        type: "card.move",
        payload: { cardId: c1.card.id, columnId: doing },
      }),
    );
    okOp(await sendOp(sa, boardId, { opId: randomUUID(), type: "column.update", payload: { columnId: todo, title: "Việc" } }));

    const replayed = sa.received.reduce(applyOp, boardState(before));
    expect(replayed).toEqual(boardState(await snapshotOf(a, boardId)));
  });

  it("người chưa vào phòng (hoặc đã rời phòng) không nhận thao tác", async () => {
    const { a, sa, sb, boardId, todo } = await twoPeople();
    const outsider = await connect(a.token); // cùng người nhưng chưa vào phòng
    sb.emit("board.leave", { boardId });
    await sleep(50);
    okOp(await sendOp(sa, boardId, createCard(todo, "X")));
    await sleep(100);
    expect(outsider.received).toEqual([]);
    expect(sb.received).toEqual([]);
  });
});

describe("chống ghi trùng bằng opId", () => {
  it("gửi lại cùng opId → trả lại đúng kết quả cũ, không chạy lại, không phát lại", async () => {
    const { sa, sb, boardId, todo } = await twoPeople();
    const req = createCard(todo, "Một lần thôi");
    const first = okOp(await sendOp(sa, boardId, req));
    const again = await sendOp(sa, boardId, req);
    expect(again.ok && again.duplicate).toBe(true);
    expect(okOp(again)).toEqual(first);

    await sleep(100);
    expect(sb.received).toHaveLength(1);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM cards WHERE board_id = $1", [boardId]);
    expect(rows[0].n).toBe(1);
  });

  it("gửi lại cùng opId SONG SONG (mạng chập chờn) → chỉ một lần được ghi, ai cũng nhận cùng seq", async () => {
    const { sa, boardId, todo } = await twoPeople();
    const req = createCard(todo, "Song song");
    const acks = await Promise.all(Array.from({ length: 6 }, () => sendOp(sa, boardId, req)));
    const seqs = acks.map((ack) => okOp(ack).seq);
    expect(new Set(seqs)).toEqual(new Set([1]));
    expect(acks.filter((ack) => ack.ok && !ack.duplicate)).toHaveLength(1);
    const { rows } = await pool.query("SELECT last_seq AS seq FROM boards WHERE id = $1", [boardId]);
    expect(rows[0].seq).toBe(1);
  });

  it("gửi lại opId SAU KHI thẻ đã bị xóa hẳn (xóa cột) → vẫn trả kết quả cũ", async () => {
    const { a, sa, boardId } = await twoPeople();
    const col = (await a.post(`/api/boards/${boardId}/columns`, { title: "Tạm" }).expect(201)).body as { id: string };
    const req = createCard(col.id, "Sẽ mất");
    const first = okOp(await sendOp(sa, boardId, req));
    const cardId = (first.payload as { card: Card }).card.id;
    await a.del(`/api/cards/${cardId}`).expect(200);
    await a.del(`/api/columns/${col.id}`).expect(204);
    expect(okOp(await sendOp(sa, boardId, req))).toEqual(first);
  });

  it("dùng opId của người khác → op_id_taken (không lộ kết quả của người khác)", async () => {
    const { sa, sb, boardId, todo } = await twoPeople();
    const req = createCard(todo, "Của An");
    okOp(await sendOp(sa, boardId, req));
    expect(errorCode(await sendOp(sb, boardId, req))).toBe("op_id_taken");
  });

  it("REST nhận X-Op-Id: gửi lại thì trả kết quả cũ", async () => {
    const { a, boardId, todo } = await twoPeople();
    const opId = randomUUID();
    const send = () =>
      a.post(`/api/columns/${todo}/cards`, { title: "REST" }).set("X-Op-Id", opId).expect(201);
    const r1 = await send();
    const r2 = await send();
    expect(r2.body).toEqual(r1.body);
    expect((await snapshotOf(a, boardId)).cards).toHaveLength(1);
  });
});

describe("seq theo từng bảng", () => {
  it("40 thao tác song song từ 2 người: seq 1..40 liên tục, ai cũng nhận đủ, áp dụng ra đúng bảng", async () => {
    const { a, sa, sb, boardId, todo, doing, done } = await twoPeople();
    const before = await snapshotOf(a, boardId);
    const cols = [todo, doing, done];
    const acks = await Promise.all(
      Array.from({ length: 40 }, (_, i) => sendOp(i % 2 ? sa : sb, boardId, createCard(cols[i % 3]!, `Thẻ ${i}`))),
    );
    expect(acks.map((ack) => okOp(ack).seq).sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));

    await waitFor(() => sa.received.length === 40 && sb.received.length === 40, 3000, "nhận đủ 40 thao tác");
    const { rows } = await pool.query<{ seq: number }>("SELECT seq FROM operations WHERE board_id = $1 ORDER BY seq", [
      boardId,
    ]);
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));

    const after = boardState(await snapshotOf(a, boardId));
    for (const s of [sa, sb]) {
      const ordered = [...s.received].sort((x, y) => x.seq - y.seq);
      expect(ordered.reduce(applyOp, boardState(before))).toEqual(after);
    }
  });

  it("mỗi bảng có dãy seq riêng", async () => {
    const { a, sa, boardId, todo } = await twoPeople();
    const other = await createBoard(a, "Bảng khác");
    await join(sa, other.board.id);
    okOp(await sendOp(sa, boardId, createCard(todo, "1")));
    okOp(await sendOp(sa, boardId, createCard(todo, "2")));
    const op = okOp(await sendOp(sa, other.board.id, createCard(other.columns[0]!.id, "khác")));
    expect(op.seq).toBe(1);
  });

  it("thao tác bị từ chối không tiêu mất seq (không để lại lỗ)", async () => {
    const { sa, boardId, todo } = await twoPeople();
    okOp(await sendOp(sa, boardId, createCard(todo, "1")));
    const bad = await sendOp(sa, boardId, { opId: randomUUID(), type: "card.delete", payload: { cardId: randomUUID() } });
    expect(errorCode(bad)).toBe("not_found");
    expect(okOp(await sendOp(sa, boardId, createCard(todo, "2"))).seq).toBe(2);
  });

  it("hai người kéo CÙNG một thẻ sang hai cột khác nhau cùng lúc: cả hai được xếp hàng, thao tác sau thắng", async () => {
    const { a, sa, sb, boardId, todo, doing, done } = await twoPeople();
    const card = (okOp(await sendOp(sa, boardId, createCard(todo, "Tranh nhau"))).payload as { card: Card }).card;
    const [ackA, ackB] = await Promise.all([
      sendOp(sa, boardId, { opId: randomUUID(), type: "card.move", payload: { cardId: card.id, columnId: doing } }),
      sendOp(sb, boardId, { opId: randomUUID(), type: "card.move", payload: { cardId: card.id, columnId: done } }),
    ]);
    const [opA, opB] = [okOp(ackA), okOp(ackB)];
    const last = opA.seq > opB.seq ? opA : opB;
    const winner = (last.payload as { card: Card }).card.columnId;

    const snap = await snapshotOf(a, boardId);
    expect(snap.cards.find((k) => k.id === card.id)?.columnId).toBe(winner);
    await waitFor(() => sa.received.length === 3 && sb.received.length === 3, 2000, "nhận đủ");
    for (const s of [sa, sb]) {
      const view = s.received.reduce(applyOp, boardState({ ...snap, seq: 0, cards: [] }));
      expect(view.cards).toEqual(snap.cards);
    }
  });
});

describe("gửi bù khi lỡ thao tác", () => {
  it("vào lại phòng với lastSeq → nhận đúng các thao tác seq > lastSeq", async () => {
    const { a, sa, boardId, todo } = await twoPeople();
    for (let i = 0; i < 5; i++) okOp(await sendOp(sa, boardId, createCard(todo, `${i}`)));

    const late = await connect(a.token);
    const res = await join(late, boardId, 2);
    if (!res.ok || res.catchUp.kind !== "ops") throw new Error("Phải nhận danh sách thao tác");
    expect(res.catchUp.ops.map((o) => o.seq)).toEqual([3, 4, 5]);

    const rest = await a.get(`/api/boards/${boardId}/ops?after=4`).expect(200);
    expect(rest.body.ops.map((o: BoardOp) => o.seq)).toEqual([5]);
  });

  it(`lỡ hơn ${MAX_CATCHUP_OPS} thao tác (hoặc lastSeq vô lý) → nhận ảnh chụp cả bảng`, async () => {
    const { a, sa, boardId, todo } = await twoPeople();
    okOp(await sendOp(sa, boardId, createCard(todo, "x")));
    // Giả lập bảng đã đi xa: không cần chạy thật 500 thao tác.
    await pool.query("UPDATE boards SET last_seq = last_seq + $2 WHERE id = $1", [boardId, MAX_CATCHUP_OPS + 5]);

    const res = await join(sa, boardId, 0);
    if (!res.ok || res.catchUp.kind !== "snapshot") throw new Error("Phải nhận ảnh chụp");
    expect(res.catchUp.snapshot.seq).toBe(MAX_CATCHUP_OPS + 6);
    expect(res.catchUp.snapshot.cards.map((k) => k.title)).toEqual(["x"]);

    const ahead = await join(sa, boardId, 10_000);
    expect(ahead.ok && ahead.catchUp.kind).toBe("snapshot");
    void a;
  });
});

describe("phân quyền trên socket", () => {
  it("không có token / token sai → từ chối kết nối", async () => {
    await expect(connect(undefined)).rejects.toMatchObject({ data: { code: "unauthorized" } });
    await expect(connect("khong-phai-jwt")).rejects.toMatchObject({ data: { code: "unauthorized" } });
  });

  it("vào phòng bảng của nhóm khác → not_found, và không nhận được gì từ bảng đó", async () => {
    const { sa, boardId, todo } = await twoPeople();
    const stranger = await registerUser("Người lạ");
    const ss = await connect(stranger.token);
    expect(errorCode(await join(ss, boardId))).toBe("not_found");
    okOp(await sendOp(sa, boardId, createCard(todo, "bí mật")));
    await sleep(100);
    expect(ss.received).toEqual([]);
  });

  it("IDOR: boardId của bảng mình + cardId của nhóm khác → not_found", async () => {
    const { a, sa, boardId } = await twoPeople();
    const stranger = await registerUser("Người lạ");
    const theirs = await createBoard(stranger);
    const theirCard = (await stranger.post(`/api/columns/${theirs.columns[0]!.id}/cards`, { title: "của họ" }).expect(201))
      .body as Card;

    for (const op of [
      { opId: randomUUID(), type: "card.update" as const, payload: { cardId: theirCard.id, title: "hack" } },
      { opId: randomUUID(), type: "card.delete" as const, payload: { cardId: theirCard.id } },
      createCard(theirs.columns[0]!.id, "chen vao"),
    ]) {
      expect(errorCode(await sendOp(sa, boardId, op))).toBe("not_found");
    }
    // Gửi kèm boardId của chính bảng họ cũng vậy (không phải thành viên).
    expect(errorCode(await sendOp(sa, theirs.board.id, createCard(theirs.columns[0]!.id, "x")))).toBe("not_found");
    expect((await snapshotOf(stranger, theirs.board.id)).cards.map((k) => k.title)).toEqual(["của họ"]);
    void a;
  });

  it("boardId không khớp với thẻ (thẻ thuộc bảng khác của mình) → not_found", async () => {
    const { a, sa, boardId } = await twoPeople();
    const other = await createBoard(a, "Bảng 2");
    expect(errorCode(await sendOp(sa, boardId, createCard(other.columns[0]!.id, "lạc bảng")))).toBe("not_found");
  });

  it("viewer nhận được thao tác nhưng gửi thao tác thì bị từ chối", async () => {
    const { a, sa, boardId, todo } = await twoPeople();
    const v = await registerUser("Xem");
    await addMember(a, v, "viewer");
    const sv = await connect(v.token);
    const joined = await join(sv, boardId);
    expect(joined.ok && joined.role).toBe("viewer");
    okOp(await sendOp(sa, boardId, createCard(todo, "cho viewer xem")));
    await waitFor(() => sv.received.length === 1, 2000, "viewer nhận thao tác");
    expect(errorCode(await sendOp(sv, boardId, createCard(todo, "viewer thêm")))).toBe("forbidden");
  });

  it("bị xóa khỏi nhóm khi đang kết nối → bị đưa ra khỏi phòng ngay, không nhận/gửi được nữa", async () => {
    const { a, b, sa, sb, boardId, todo } = await twoPeople();
    const revoked = new Promise<{ workspaceId: string; boardIds: string[] }>((r) => sb.once("access.revoked", r));
    await a.del(`/api/workspaces/${a.workspaceId}/members/${b.id}`).expect(204);
    expect(await revoked).toEqual({ workspaceId: a.workspaceId, boardIds: [boardId] });

    okOp(await sendOp(sa, boardId, createCard(todo, "sau khi bị xóa")));
    await sleep(100);
    expect(sb.received).toEqual([]);
    expect(errorCode(await sendOp(sb, boardId, createCard(todo, "vẫn cố gửi")))).toBe("not_found");
    expect(errorCode(await join(sb, boardId))).toBe("not_found");
  });

  it("bị hạ quyền editor → viewer: thao tác tiếp theo bị từ chối ngay (quyền kiểm tra lại mỗi lần)", async () => {
    const { a, b, sb, boardId, todo } = await twoPeople();
    okOp(await sendOp(sb, boardId, createCard(todo, "lúc còn quyền")));
    const role = new Promise((r) => sb.once("access.role", r));
    await a.patch(`/api/workspaces/${a.workspaceId}/members/${b.id}`, { role: "viewer" }).expect(200);
    expect(await role).toEqual({ workspaceId: a.workspaceId, role: "viewer" });
    expect(errorCode(await sendOp(sb, boardId, createCard(todo, "hết quyền")))).toBe("forbidden");
  });

  it("có người mới vào nhóm → mọi người đang mở bảng được báo để tải lại danh sách thành viên", async () => {
    const { a, sb, boardId } = await twoPeople();
    const changed = new Promise((r) => sb.once("members.changed", r));
    await addMember(a, await registerUser("Mới"), "editor");
    expect(await changed).toEqual({ workspaceId: a.workspaceId });
    void boardId;
  });

  it("bảng bị xóa → mọi người được báo và bị đưa ra khỏi phòng", async () => {
    const { a, sb, boardId } = await twoPeople();
    const deleted = new Promise((r) => sb.once("board.deleted", r));
    await a.del(`/api/boards/${boardId}`).expect(204);
    expect(await deleted).toEqual({ boardId });
  });

  it("cả nhóm bị xóa → người đang mở bảng của nhóm được báo board.deleted, không nhận gì thêm", async () => {
    const { a, sb, boardId } = await twoPeople();
    const deleted = new Promise((r) => sb.once("board.deleted", r));
    await a.del(`/api/workspaces/${a.workspaceId}`).expect(204);
    expect(await deleted).toEqual({ boardId });
    // Đã bị đưa ra khỏi phòng: vào lại thì bảng không còn.
    expect(errorCode(await join(sb, boardId))).toBe("not_found");
  });
});

describe("token hết hạn khi socket còn mở", () => {
  const shortToken = (userId: string, seconds: number) =>
    jwt.sign({}, config.jwtSecret, { subject: userId, expiresIn: seconds });

  it("không làm mới → server báo session.expired rồi ngắt kết nối", async () => {
    const u = await registerUser();
    const s = await connect(shortToken(u.id, 1));
    const expired = new Promise<void>((r) => s.once("session.expired", () => r()));
    const disconnected = new Promise<string>((r) => s.once("disconnect", r));
    await expired;
    expect(await disconnected).toBe("io server disconnect");
  });

  it("gửi auth.refresh với token mới trước khi hết hạn → vẫn giữ kết nối", async () => {
    const u = await registerUser();
    const s = await connect(shortToken(u.id, 1));
    expect((await refreshToken(s, u.token)).ok).toBe(true);
    await sleep(1600);
    expect(s.connected).toBe(true);
  });

  it("auth.refresh bằng token của người khác → từ chối, vẫn hết hạn như cũ", async () => {
    const u = await registerUser();
    const other = await registerUser();
    const s = await connect(shortToken(u.id, 1));
    expect(errorCode(await refreshToken(s, other.token))).toBe("unauthorized");
    await waitFor(() => !s.connected, 2500, "bị ngắt");
  });

  it("token đã hết hạn thì không kết nối được, mã lỗi token_expired để client biết mà làm mới", async () => {
    const u = await registerUser();
    const token = jwt.sign({ exp: Math.floor(Date.now() / 1000) - 10 }, config.jwtSecret, { subject: u.id });
    await expect(connect(token)).rejects.toMatchObject({ data: { code: "token_expired" } });
  });
});

describe("đầu vào xấu", () => {
  it("thao tác sai định dạng → invalid_input, server vẫn chạy bình thường", async () => {
    const { sa, boardId, todo } = await twoPeople();
    const bad = [
      { type: "card.create", payload: { columnId: todo, id: randomUUID(), title: "thiếu opId" } },
      { opId: randomUUID(), type: "card.explode", payload: {} },
      { opId: randomUUID(), type: "card.create", payload: { columnId: todo, id: "khong-phai-uuid", title: "x" } },
      { opId: randomUUID(), type: "card.create", payload: { columnId: todo, id: randomUUID(), title: "x".repeat(501) } },
      { opId: randomUUID(), type: "card.update", payload: { cardId: randomUUID() } },
    ];
    for (const op of bad) {
      expect(errorCode(await sendOp(sa, boardId, op as never))).toBe("invalid_input");
    }
    expect(errorCode(await sa.emitWithAck("op", "rác" as never))).toBe("invalid_input");
    expect(errorCode(await sa.emitWithAck("board.join", { boardId: 42 } as never))).toBe("invalid_input");
    okOp(await sendOp(sa, boardId, createCard(todo, "vẫn chạy")));
  });

  it("gửi dồn dập quá nhiều thao tác → một phần bị từ chối rate_limited", async () => {
    const { sa, boardId } = await twoPeople();
    const acks = await Promise.all(
      Array.from({ length: 80 }, () =>
        sendOp(sa, boardId, { opId: randomUUID(), type: "card.delete", payload: { cardId: randomUUID() } }),
      ),
    );
    const limited = acks.filter((ack) => errorCode(ack) === "rate_limited").length;
    expect(limited).toBeGreaterThan(0);
    expect(limited).toBeLessThan(80);
  });

  // Mỗi lần vào phòng là một lần đọc cả bảng: không giới hạn thì gọi liên tục sẽ làm nặng DB.
  it("vào phòng dồn dập → bị rate_limited, nhưng thao tác sửa bảng vẫn chạy (xô riêng)", async () => {
    const { sa, boardId, todo } = await twoPeople();
    const acks = await Promise.all(Array.from({ length: 30 }, () => join(sa, boardId, 0)));
    expect(acks.filter((ack) => errorCode(ack) === "rate_limited").length).toBeGreaterThan(0);
    okOp(await sendOp(sa, boardId, createCard(todo, "vẫn sửa được")));
  });
});

export type { ClientSocket };
