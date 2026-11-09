import { describe, expect, it } from "vitest";
import {
  applyOp,
  BoardReplica,
  optimisticUpdate,
  type BoardOp,
  type BoardSnapshot,
  type Card,
  type OpRequest,
} from "../src";

const BOARD = "00000000-0000-4000-8000-000000000000";
const TODO = "00000000-0000-4000-8000-0000000000c1";
const DONE = "00000000-0000-4000-8000-0000000000c2";
const ME = "00000000-0000-4000-8000-00000000000a";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function card(n: number, position: string, columnId = TODO, extra: Partial<Card> = {}): Card {
  return {
    id: id(n),
    boardId: BOARD,
    columnId,
    title: `Thẻ ${n}`,
    dueDate: null,
    assigneeId: null,
    position,
    version: 1,
    deletedAt: null,
    updatedAt: "2026-11-09T00:00:00.000Z",
    updatedBy: null,
    ...extra,
  };
}

function snapshot(cards: Card[] = [], seq = 0): BoardSnapshot {
  return {
    seq,
    board: { id: BOARD, workspaceId: id(999), title: "Bảng" },
    role: "editor",
    columns: [
      { id: TODO, boardId: BOARD, title: "To do", position: "a0" },
      { id: DONE, boardId: BOARD, title: "Done", position: "a1" },
    ],
    cards,
    members: [],
  };
}

let opCounter = 0;
function op(seq: number, result: Pick<BoardOp, "type" | "payload">, opId = id(100_000 + ++opCounter)): BoardOp {
  return { seq, opId, boardId: BOARD, actorId: null, createdAt: "2026-11-09T00:00:00.000Z", ...result } as BoardOp;
}
const upsertOp = (seq: number, k: Card, opId?: string) => op(seq, { type: "card.update", payload: { card: k } }, opId);

const titles = (s: { cards: Card[] }) => s.cards.map((k) => k.title);

describe("applyOp", () => {
  it("giữ thẻ sắp theo (position, id) như server, kể cả khi trùng vị trí", () => {
    const s = [op(1, { type: "card.create", payload: { card: card(2, "a1") } }), op(2, { type: "card.create", payload: { card: card(1, "a1") } })]
      .reduce(applyOp, snapshot());
    expect(s.cards.map((k) => k.id)).toEqual([id(1), id(2)]);
    expect(s.seq).toBe(2);
  });

  it("thẻ có deletedAt thì bị bỏ khỏi bảng; khôi phục thì quay lại", () => {
    const k = card(1, "a0");
    let s = snapshot([k]);
    s = applyOp(s, op(1, { type: "card.delete", payload: { card: { ...k, deletedAt: "2026-11-09T01:00:00Z" } } }));
    expect(s.cards).toEqual([]);
    s = applyOp(s, op(2, { type: "card.restore", payload: { card: k } }));
    expect(s.cards).toEqual([k]);
  });

  it("card.move áp dụng cả vị trí mới của các thẻ bị sắp xếp lại", () => {
    const s = applyOp(
      snapshot([card(1, "a0"), card(2, "a0V"), card(3, "a1", DONE)]),
      op(1, {
        type: "card.move",
        payload: {
          card: card(3, "a0VVVV", TODO),
          rebalanced: [
            { id: id(1), position: "a0" },
            { id: id(3), position: "a1" },
            { id: id(2), position: "a2" },
          ],
        },
      }),
    );
    expect(s.cards.map((k) => [k.id, k.position])).toEqual([
      [id(1), "a0"],
      [id(3), "a1"],
      [id(2), "a2"],
    ]);
  });

  it("xóa cột thì bỏ luôn thẻ của cột đó", () => {
    const s = applyOp(snapshot([card(1, "a0", DONE)]), op(1, { type: "column.delete", payload: { columnId: DONE } }));
    expect(s.columns.map((c) => c.id)).toEqual([TODO]);
    expect(s.cards).toEqual([]);
  });

  it("áp dụng hai lần cũng như một lần", () => {
    const o = op(1, { type: "card.create", payload: { card: card(1, "a0") } });
    const once = applyOp(snapshot(), o);
    expect(applyOp(once, o)).toEqual(once);
  });
});

describe("BoardReplica: thứ tự seq", () => {
  it("seq nhảy cóc thì giữ lại, có đủ phần thiếu thì áp dụng theo đúng thứ tự", () => {
    const r = new BoardReplica(snapshot([card(1, "a0")]));
    expect(r.receive(upsertOp(3, card(1, "a0", TODO, { title: "ba" })))).toBe("gap");
    expect(r.receive(upsertOp(2, card(1, "a0", TODO, { title: "hai" })))).toBe("gap");
    expect(r.hasGap).toBe(true);
    expect(r.seq).toBe(0);
    expect(r.receive(upsertOp(1, card(1, "a0", TODO, { title: "một" })))).toBe("applied");
    expect(r.seq).toBe(3);
    expect(r.hasGap).toBe(false);
    expect(titles(r.view)).toEqual(["ba"]);
  });

  it("nhận lại thao tác đã có (seq ≤ seq hiện tại) thì bỏ qua", () => {
    const r = new BoardReplica(snapshot([card(1, "a0")], 5));
    expect(r.receive(upsertOp(5, card(1, "a0", TODO, { title: "cũ" })))).toBe("stale");
    expect(titles(r.view)).toEqual(["Thẻ 1"]);
  });

  it("ảnh chụp mới thay trạng thái, bỏ phần buffer cũ hơn, áp tiếp phần mới hơn", () => {
    const r = new BoardReplica(snapshot([card(1, "a0")]));
    r.receive(upsertOp(4, card(1, "a0", TODO, { title: "bốn" })));
    r.receive(upsertOp(7, card(1, "a0", TODO, { title: "bảy" })));
    r.reset(snapshot([card(1, "a0", TODO, { title: "sáu" })], 6));
    expect(r.seq).toBe(7);
    expect(titles(r.view)).toEqual(["bảy"]);
    expect(r.hasGap).toBe(false);
  });
});

describe("BoardReplica: cập nhật lạc quan", () => {
  function pending(r: BoardReplica, req: OpRequest) {
    r.add({ request: req, apply: optimisticUpdate(r.view, req, { userId: ME }) });
    return req.opId;
  }
  const rename = (cardId: string, title: string): OpRequest => ({
    opId: id(200_000 + ++opCounter),
    type: "card.update",
    payload: { cardId, title },
  });

  it("thấy ngay kết quả; server từ chối thì bỏ đi là bảng tự về như cũ", () => {
    const r = new BoardReplica(snapshot([card(1, "a0")]));
    const opId = pending(r, rename(id(1), "lạc quan"));
    expect(titles(r.view)).toEqual(["lạc quan"]);
    expect(titles(r.state)).toEqual(["Thẻ 1"]);
    r.reject(opId);
    expect(titles(r.view)).toEqual(["Thẻ 1"]);
  });

  it("thao tác của người khác tới trong lúc chờ không bị bản lạc quan đè mất (và ngược lại)", () => {
    const r = new BoardReplica(snapshot([card(1, "a0"), card(2, "a1")]));
    pending(r, rename(id(1), "của tôi"));
    r.receive(upsertOp(1, card(2, "a1", TODO, { title: "của người khác" })));
    expect(titles(r.view)).toEqual(["của tôi", "của người khác"]);
  });

  it("bản phát của chính thao tác mình tới → bỏ bản lạc quan, dùng kết quả server", () => {
    const r = new BoardReplica(snapshot([card(1, "a0")]));
    const opId = pending(r, rename(id(1), "  gửi lên"));
    r.receive(upsertOp(1, card(1, "a0", TODO, { title: "server đã cắt khoảng trắng" }), opId));
    expect(r.pendingOps).toEqual([]);
    expect(titles(r.view)).toEqual(["server đã cắt khoảng trắng"]);
  });

  it("ack tới trước bản phát (đang thiếu seq ở giữa): vẫn hiện bản lạc quan tới khi đủ seq, không nháy về chỗ cũ", () => {
    const r = new BoardReplica(snapshot([card(1, "a0")]));
    const opId = pending(r, rename(id(1), "mới"));
    r.acknowledge(upsertOp(2, card(1, "a0", TODO, { title: "mới" }), opId));
    expect(r.hasGap).toBe(true);
    expect(titles(r.view)).toEqual(["mới"]);
    r.receive(upsertOp(1, card(1, "a0", TODO, { title: "ai đó sửa trước" })));
    expect(r.pendingOps).toEqual([]);
    expect(titles(r.view)).toEqual(["mới"]);
  });

  // Lỗi tìm ra lúc review tuần 3: reset() bỏ thao tác khỏi buffer nhưng quên bỏ khỏi hàng chờ, nên
  // bản lạc quan cũ đè lên ảnh chụp mãi mãi ("Saving…" treo, thay đổi của người khác bị che).
  it("ack tới lúc đang thiếu seq, rồi lấy bù bằng ẢNH CHỤP → hàng chờ sạch, thấy đúng bản của server", () => {
    const r = new BoardReplica(snapshot([card(1, "a0")]));
    const opId = pending(r, rename(id(1), "của tôi"));
    r.acknowledge(upsertOp(600, card(1, "a0", TODO, { title: "của tôi", version: 2 }), opId));
    expect(r.hasGap).toBe(true);

    // Sau thao tác của mình, người khác đã đổi tiêu đề; ảnh chụp đã gồm cả hai.
    r.reset(snapshot([card(1, "a0", TODO, { title: "của người khác", version: 3 })], 700));
    expect(r.pendingOps).toEqual([]);
    expect(r.hasGap).toBe(false);
    expect(titles(r.view)).toEqual(["của người khác"]);
  });

  it("ảnh chụp cũ hơn thao tác của mình thì vẫn giữ bản lạc quan trong hàng chờ", () => {
    const r = new BoardReplica(snapshot([card(1, "a0")]));
    const opId = pending(r, rename(id(1), "của tôi"));
    r.acknowledge(upsertOp(600, card(1, "a0", TODO, { title: "của tôi", version: 2 }), opId));
    r.reset(snapshot([card(1, "a0")], 550));
    expect(r.pendingOps.map((p) => p.request.opId)).toEqual([opId]);
    expect(titles(r.view)).toEqual(["của tôi"]);
  });

  it("ack của opId gửi lại (seq cũ đã áp dụng từ lâu) → bỏ khỏi hàng chờ", () => {
    const r = new BoardReplica(snapshot([card(1, "a0", TODO, { title: "mới" })], 9));
    const opId = pending(r, rename(id(1), "mới"));
    r.acknowledge(upsertOp(3, card(1, "a0", TODO, { title: "mới" }), opId));
    expect(r.pendingOps).toEqual([]);
  });

  it("kéo thả lạc quan: vị trí tính một lần, view tính lại nhiều lần vẫn cùng thứ tự", () => {
    const r = new BoardReplica(snapshot([card(1, "a0"), card(2, "a1"), card(3, "a2")]));
    pending(r, {
      opId: id(300_001),
      type: "card.move",
      payload: { cardId: id(3), columnId: TODO, afterCardId: id(1), beforeCardId: id(2) },
    });
    const first = r.view.cards.map((k) => k.position);
    r.receive(upsertOp(1, card(9, "a5", DONE)));
    expect(r.view.cards.filter((k) => k.columnId === TODO).map((k) => k.position)).toEqual(first);
    expect(titles(r.view).slice(0, 3)).toEqual(["Thẻ 1", "Thẻ 3", "Thẻ 2"]);
  });

  it("bản lạc quan chịu được thẻ đã bị người khác xóa", () => {
    const k = card(1, "a0");
    const r = new BoardReplica(snapshot([k]));
    pending(r, rename(id(1), "đang sửa"));
    r.receive(op(1, { type: "card.delete", payload: { card: { ...k, deletedAt: "2026-11-09T01:00:00Z" } } }));
    expect(r.view.cards).toEqual([]);
  });

  it("thêm thẻ lạc quan nằm cuối cột; khôi phục lạc quan dùng dữ liệu thẻ đã có", () => {
    const k = card(1, "a0");
    const r = new BoardReplica(snapshot([k]));
    pending(r, { opId: id(300_002), type: "card.create", payload: { id: id(5), columnId: TODO, title: "mới" } });
    expect(titles(r.view)).toEqual(["Thẻ 1", "mới"]);
    pending(r, { opId: id(300_003), type: "card.delete", payload: { cardId: id(1) } });
    expect(titles(r.view)).toEqual(["mới"]);
    r.add({
      request: { opId: id(300_004), type: "card.restore", payload: { cardId: id(1) } },
      apply: optimisticUpdate(r.view, { opId: id(300_004), type: "card.restore", payload: { cardId: id(1) } }, { userId: ME, restoreCard: k }),
    });
    expect(titles(r.view)).toEqual(["Thẻ 1", "mới"]);
  });

  it("view giữ nguyên object khi không có gì đổi", () => {
    const r = new BoardReplica(snapshot([card(1, "a0")]));
    expect(r.view).toBe(r.view);
  });
});
