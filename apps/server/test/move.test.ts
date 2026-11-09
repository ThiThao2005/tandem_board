import { POSITION_REBALANCE_LENGTH, type BoardSnapshot, type Card, type CardMoveResult } from "@tandem/shared";
import { describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { addMember, createBoard, registerUser, type TestUser } from "./helpers";

async function addCards(u: TestUser, columnId: string, titles: string[]): Promise<Card[]> {
  const cards: Card[] = [];
  for (const title of titles) cards.push((await u.post(`/api/columns/${columnId}/cards`, { title }).expect(201)).body);
  return cards;
}

/** Tiêu đề thẻ theo thứ tự hiển thị, nhóm theo cột. */
async function layout(u: TestUser, boardId: string): Promise<string[][]> {
  const snap = (await u.get(`/api/boards/${boardId}`).expect(200)).body as BoardSnapshot;
  return snap.columns.map((col) => snap.cards.filter((k) => k.columnId === col.id).map((k) => k.title));
}

/** Tiền tố dài sát ngưỡng sắp xếp lại. */
const LONG = "a0" + "V".repeat(POSITION_REBALANCE_LENGTH - 3);

async function setPositions(positions: Record<string, string>) {
  for (const [id, position] of Object.entries(positions)) {
    await pool.query("UPDATE cards SET position = $2 WHERE id = $1", [id, position]);
  }
}

async function setup(titles = ["A", "B", "C"]) {
  const u = await registerUser();
  const snap = await createBoard(u);
  const [todo, doing, done] = snap.columns.map((c) => c.id) as [string, string, string];
  const cards = await addCards(u, todo, titles);
  const byTitle = Object.fromEntries(cards.map((k) => [k.title, k])) as Record<string, Card>;
  return { u, boardId: snap.board.id, todo, doing, done, byTitle };
}

describe("kéo thả thẻ", () => {
  it("kéo xuống giữa hai thẻ trong cùng cột", async () => {
    const { u, boardId, todo, byTitle } = await setup();
    const res = await u
      .post(`/api/cards/${byTitle.A!.id}/move`, { columnId: todo, afterCardId: byTitle.B!.id, beforeCardId: byTitle.C!.id })
      .expect(200);
    const body = res.body as CardMoveResult;
    expect(body.card.position > byTitle.B!.position && body.card.position < byTitle.C!.position).toBe(true);
    expect(body.card.version).toBe(2);
    expect(body.rebalanced).toEqual([]);
    expect(await layout(u, boardId)).toEqual([["B", "A", "C"], [], []]);
  });

  it("kéo lên đầu cột và xuống cuối cột", async () => {
    const { u, boardId, todo, byTitle } = await setup();
    await u.post(`/api/cards/${byTitle.C!.id}/move`, { columnId: todo, beforeCardId: byTitle.A!.id }).expect(200);
    expect((await layout(u, boardId))[0]).toEqual(["C", "A", "B"]);
    await u.post(`/api/cards/${byTitle.C!.id}/move`, { columnId: todo, afterCardId: byTitle.B!.id }).expect(200);
    expect((await layout(u, boardId))[0]).toEqual(["A", "B", "C"]);
  });

  it("kéo sang cột khác: vào cột trống, rồi vào giữa hai thẻ", async () => {
    const { u, boardId, doing, byTitle } = await setup(["A", "B", "C", "D"]);
    await u.post(`/api/cards/${byTitle.A!.id}/move`, { columnId: doing }).expect(200);
    await u.post(`/api/cards/${byTitle.B!.id}/move`, { columnId: doing, afterCardId: byTitle.A!.id }).expect(200);
    await u
      .post(`/api/cards/${byTitle.D!.id}/move`, { columnId: doing, afterCardId: byTitle.A!.id, beforeCardId: byTitle.B!.id })
      .expect(200);
    expect(await layout(u, boardId)).toEqual([["C"], ["A", "D", "B"], []]);
  });

  it("hàng xóm đã bị người khác chèn thẻ vào giữa: vẫn đặt ngay sau thẻ 'after'", async () => {
    const { u, boardId, todo, byTitle } = await setup(["A", "B", "C", "X"]);
    // Client thấy A, B kề nhau và thả X vào giữa. Trước đó người khác đã chèn C vào giữa A và B.
    await u.post(`/api/cards/${byTitle.C!.id}/move`, { columnId: todo, afterCardId: byTitle.A!.id }).expect(200);
    await u
      .post(`/api/cards/${byTitle.X!.id}/move`, { columnId: todo, afterCardId: byTitle.A!.id, beforeCardId: byTitle.B!.id })
      .expect(200);
    expect((await layout(u, boardId))[0]).toEqual(["A", "X", "C", "B"]);
  });

  it("hàng xóm 'after' đã bị xóa: dùng 'before'; cả hai đều mất: xuống cuối cột", async () => {
    const { u, boardId, todo, doing, byTitle } = await setup(["A", "B", "C", "D"]);
    await u.del(`/api/cards/${byTitle.A!.id}`).expect(200);
    await u
      .post(`/api/cards/${byTitle.D!.id}/move`, { columnId: todo, afterCardId: byTitle.A!.id, beforeCardId: byTitle.C!.id })
      .expect(200);
    expect((await layout(u, boardId))[0]).toEqual(["B", "D", "C"]);

    // Cả hai hàng xóm đều đã sang cột khác.
    await u.post(`/api/cards/${byTitle.B!.id}/move`, { columnId: doing }).expect(200);
    await u.post(`/api/cards/${byTitle.C!.id}/move`, { columnId: doing }).expect(200);
    await addCards(u, todo, ["E"]);
    await u
      .post(`/api/cards/${byTitle.D!.id}/move`, { columnId: todo, afterCardId: byTitle.B!.id, beforeCardId: byTitle.C!.id })
      .expect(200);
    expect((await layout(u, boardId))[0]).toEqual(["E", "D"]);
  });

  it("thả lên đầu cột mà thẻ đầu đã bị xóa: vẫn lên đầu cột", async () => {
    const { u, boardId, todo, byTitle } = await setup(["A", "B", "C"]);
    await u.del(`/api/cards/${byTitle.A!.id}`).expect(200);
    await u.post(`/api/cards/${byTitle.C!.id}/move`, { columnId: todo, afterCardId: null, beforeCardId: byTitle.A!.id }).expect(200);
    expect((await layout(u, boardId))[0]).toEqual(["C", "B"]);
  });

  it("anchor là chính thẻ đang kéo hoặc thẻ ở cột khác thì bị bỏ qua", async () => {
    const { u, boardId, todo, doing, byTitle } = await setup(["A", "B", "C"]);
    await u.post(`/api/cards/${byTitle.C!.id}/move`, { columnId: doing }).expect(200);
    // afterCardId = C nằm ở cột "doing", không phải cột đích → bỏ qua, dùng before = B.
    await u
      .post(`/api/cards/${byTitle.A!.id}/move`, { columnId: todo, afterCardId: byTitle.C!.id, beforeCardId: byTitle.B!.id })
      .expect(200);
    expect((await layout(u, boardId))[0]).toEqual(["A", "B"]);
    await u.post(`/api/cards/${byTitle.A!.id}/move`, { columnId: todo, afterCardId: byTitle.A!.id }).expect(200);
    expect((await layout(u, boardId))[0]).toEqual(["B", "A"]);
  });

  it("nhiều người cùng thả vào một khe: không trùng vị trí, tất cả nằm giữa hai hàng xóm", async () => {
    const { u, boardId, todo, doing, byTitle } = await setup(["A", "B"]);
    const movers = await addCards(u, doing, Array.from({ length: 8 }, (_, i) => `M${i}`));
    const results = await Promise.all(
      movers.map((m) =>
        u.post(`/api/cards/${m.id}/move`, { columnId: todo, afterCardId: byTitle.A!.id, beforeCardId: byTitle.B!.id }),
      ),
    );
    const positions = results.map((r) => {
      expect(r.status).toBe(200);
      return (r.body as CardMoveResult).card.position;
    });
    expect(new Set(positions).size).toBe(movers.length);
    for (const p of positions) expect(p > byTitle.A!.position && p < byTitle.B!.position).toBe(true);
    const order = (await layout(u, boardId))[0]!;
    expect(order[0]).toBe("A");
    expect(order.at(-1)).toBe("B");
    expect(order).toHaveLength(10);
  });

  it("kéo qua lại giữa hai cột song song không gây deadlock", async () => {
    const { u, boardId, todo, doing } = await setup([]);
    const left = await addCards(u, todo, ["L0", "L1", "L2", "L3"]);
    const right = await addCards(u, doing, ["R0", "R1", "R2", "R3"]);
    const results = await Promise.all([
      ...left.map((k) => u.post(`/api/cards/${k.id}/move`, { columnId: doing })),
      ...right.map((k) => u.post(`/api/cards/${k.id}/move`, { columnId: todo })),
      ...left.map((k) => u.patch(`/api/cards/${k.id}`, { columnId: todo })),
    ]);
    for (const r of results) expect(r.status).toBe(200);
    const [a, b] = await layout(u, boardId);
    expect(a!.length + b!.length).toBe(8);
  });

  // Trước đây chỉ khóa cột đích: X (B→A) sắp xếp lại A phải sửa Y đang bị giữ, Y (A→B)
  // sắp xếp lại B phải sửa X đang bị giữ → Postgres báo "deadlock detected" (40P01) → lỗi 500.
  it("hai người kéo chéo nhau mà cả hai cột cùng phải sắp xếp lại: không deadlock", async () => {
    for (let round = 0; round < 8; round++) {
      const { u, boardId, todo, doing } = await setup([]);
      const [a1, a2, y] = await addCards(u, todo, ["A1", "A2", "Y"]);
      const [b1, b2, x] = await addCards(u, doing, ["B1", "B2", "X"]);
      await setPositions({ [a1!.id]: LONG + "1", [a2!.id]: LONG + "2", [b1!.id]: LONG + "1", [b2!.id]: LONG + "2" });

      const [rx, ry] = await Promise.all([
        u.post(`/api/cards/${x!.id}/move`, { columnId: todo, afterCardId: a1!.id, beforeCardId: a2!.id }),
        u.post(`/api/cards/${y!.id}/move`, { columnId: doing, afterCardId: b1!.id, beforeCardId: b2!.id }),
      ]);
      expect([rx.status, ry.status]).toEqual([200, 200]);
      expect(await layout(u, boardId)).toEqual([["A1", "X", "A2"], ["B1", "Y", "B2"], []]);
    }
  });

  it("nhiều người cùng kéo một thẻ sang các cột khác nhau: thẻ nằm đúng ở một cột", async () => {
    const { u, boardId, todo, doing, done, byTitle } = await setup(["A", "B"]);
    const targets = [doing, done, todo, doing, done, todo];
    const results = await Promise.all(targets.map((columnId) => u.post(`/api/cards/${byTitle.A!.id}/move`, { columnId })));
    for (const r of results) expect(r.status).toBe(200);
    const all = (await layout(u, boardId)).flat();
    expect(all.filter((t) => t === "A")).toHaveLength(1);
    expect(all).toHaveLength(2);
  });

  it("chuỗi vị trí quá dài thì tự sắp xếp lại cả cột, giữ nguyên thứ tự", async () => {
    const { u, boardId, todo, doing, byTitle } = await setup(["A", "B", "C"]);
    // Giả lập cột đã bị chèn rất nhiều lần vào cùng một khe: A và B có chung một tiền tố
    // dài sát ngưỡng, nên vị trí nằm giữa chúng chắc chắn vượt ngưỡng.
    await setPositions({ [byTitle.A!.id]: LONG + "1", [byTitle.B!.id]: LONG + "2" });
    const [x] = await addCards(u, doing, ["X"]);

    const res = await u
      .post(`/api/cards/${x!.id}/move`, { columnId: todo, afterCardId: byTitle.A!.id, beforeCardId: byTitle.B!.id })
      .expect(200);
    const body = res.body as CardMoveResult;
    expect(body.rebalanced.map((r) => r.position)).toEqual(["a0", "a1", "a2", "a3"]);
    expect(body.card.position).toBe("a1");
    expect(await layout(u, boardId)).toEqual([["A", "X", "B", "C"], [], []]);

    // Thẻ khác không bị tăng version (đổi vị trí không phải sửa nội dung).
    const snap = (await u.get(`/api/boards/${boardId}`).expect(200)).body as BoardSnapshot;
    expect(snap.cards.find((k) => k.title === "B")!.version).toBe(1);
  });

  it("sắp xếp lại giữ chỗ của thẻ đã xóa mềm: khôi phục thì về đúng chỗ cũ", async () => {
    const { u, boardId, todo, doing, byTitle } = await setup(["A", "B", "C"]);
    await setPositions({ [byTitle.A!.id]: LONG + "1", [byTitle.B!.id]: LONG + "2", [byTitle.C!.id]: LONG + "3" });
    await u.del(`/api/cards/${byTitle.B!.id}`).expect(200);
    const [x] = await addCards(u, doing, ["X"]);
    // X thả ngay trước C → nằm giữa A và C, tức là sau B (đã xóa).
    const res = await u.post(`/api/cards/${x!.id}/move`, { columnId: todo, beforeCardId: byTitle.C!.id }).expect(200);
    expect((res.body as CardMoveResult).rebalanced).toHaveLength(4);

    await u.post(`/api/cards/${byTitle.B!.id}/restore`).expect(200);
    expect((await layout(u, boardId))[0]).toEqual(["A", "B", "X", "C"]);
  });

  it("thẻ đã bị xóa thì không kéo được, báo ai đã xóa", async () => {
    const owner = await registerUser("Chủ");
    const lan = await registerUser("Lan");
    await addMember(owner, lan, "editor");
    const snap = await createBoard(owner);
    const [card] = await addCards(owner, snap.columns[0]!.id, ["X"]);
    await lan.del(`/api/cards/${card!.id}`).expect(200);
    const res = await owner.post(`/api/cards/${card!.id}/move`, { columnId: snap.columns[1]!.id }).expect(410);
    expect(res.body.error.message).toContain("Lan");
  });
});

describe("kéo thả thẻ — phân quyền và dữ liệu đầu vào", () => {
  it("viewer không kéo được", async () => {
    const owner = await registerUser();
    const viewer = await registerUser();
    await addMember(owner, viewer, "viewer");
    const snap = await createBoard(owner);
    const [card] = await addCards(owner, snap.columns[0]!.id, ["X"]);
    await viewer.post(`/api/cards/${card!.id}/move`, { columnId: snap.columns[1]!.id }).expect(403);
  });

  it("người ngoài nhóm nhận 404; không kéo được thẻ sang cột của bảng khác", async () => {
    const owner = await registerUser();
    const attacker = await registerUser();
    const a = await createBoard(owner, "A");
    const b = await createBoard(owner, "B");
    const [card] = await addCards(owner, a.columns[0]!.id, ["X"]);
    await attacker.post(`/api/cards/${card!.id}/move`, { columnId: a.columns[1]!.id }).expect(404);
    // Kẻ tấn công kéo thẻ của mình vào cột của bảng người khác.
    const theirs = await createBoard(attacker);
    const [mine] = await addCards(attacker, theirs.columns[0]!.id, ["Y"]);
    await attacker.post(`/api/cards/${mine!.id}/move`, { columnId: a.columns[0]!.id }).expect(404);
    // Chủ bảng cũng không được kéo thẻ sang bảng khác của chính mình.
    await owner.post(`/api/cards/${card!.id}/move`, { columnId: b.columns[0]!.id }).expect(404);
  });

  it("dữ liệu sai định dạng trả 400", async () => {
    const { u, byTitle } = await setup(["A"]);
    await u.post(`/api/cards/${byTitle.A!.id}/move`, {}).expect(400);
    await u.post(`/api/cards/${byTitle.A!.id}/move`, { columnId: "khong-phai-uuid" }).expect(400);
  });
});
