import { describe, expect, it } from "vitest";
import {
  describeRequest,
  isTransientError,
  MemoryOutboxStorage,
  Outbox,
  retryOption,
  type BoardState,
  type Card,
  type FailedOp,
  type OpRequest,
} from "../src";

const BOARD = "00000000-0000-4000-8000-000000000000";
const TODO = "00000000-0000-4000-8000-0000000000c1";
const DONE = "00000000-0000-4000-8000-0000000000c2";
const ME = "00000000-0000-4000-8000-00000000000a";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function card(n: number, extra: Partial<Card> = {}): Card {
  return {
    id: id(n),
    boardId: BOARD,
    columnId: TODO,
    title: `Thẻ ${n}`,
    dueDate: null,
    assigneeId: null,
    position: "a0",
    version: 1,
    deletedAt: null,
    updatedAt: "2026-11-10T00:00:00.000Z",
    updatedBy: null,
    note: null,
    ...extra,
  };
}

const view: BoardState = {
  seq: 5,
  board: { id: BOARD, workspaceId: id(999), title: "Bảng" },
  columns: [
    { id: TODO, boardId: BOARD, title: "To do", position: "a0" },
    { id: DONE, boardId: BOARD, title: "Done", position: "a1" },
  ],
  cards: [card(1), card(2)],
};

let n = 1000;
const opId = () => id(++n);
const rename = (cardId: string, title: string): OpRequest => ({
  opId: opId(),
  type: "card.update",
  payload: { cardId, title, baseVersion: 1 },
});

/** Nhiều "tab" dùng chung một nơi lưu, như nhiều tab dùng chung IndexedDB. */
function setup(live: (tab: string) => ReadonlySet<string> | null = () => null) {
  const storage = new MemoryOutboxStorage();
  const tab = (tabId: string) =>
    new Outbox({ storage, userId: ME, boardId: BOARD, tabId, liveTabs: async () => live(tabId) });
  return { storage, tab };
}

describe("Outbox", () => {
  it("ghi thao tác xuống đĩa theo thứ tự, và xóa khi nó rời hàng chờ", async () => {
    const { storage, tab } = setup();
    const a = tab("A");
    const r1 = rename(id(1), "Một");
    const r2 = rename(id(2), "Hai");
    a.queue(r1, "x");
    a.queue(r2, "y");
    await a.idle();
    expect(storage.all().map((r) => r.opId)).toEqual([r1.opId, r2.opId]);

    a.retain([r2.opId]); // r1 đã được xác nhận
    await a.idle();
    expect(storage.all().map((r) => r.opId)).toEqual([r2.opId]);

    a.retain([]);
    await a.idle();
    expect(storage.all()).toEqual([]);
  });

  it("thêm rồi xóa ngay thì đĩa không còn gì (xóa không tới trước thêm)", async () => {
    const { storage, tab } = setup();
    const a = tab("A");
    a.queue(rename(id(1), "Một"), "x");
    a.retain([]); // xác nhận tới trước khi lần ghi đầu kịp xong
    await a.idle();
    expect(storage.all()).toEqual([]);
  });

  it("tải lại trang: tab mới nhận lại các thao tác chưa gửi theo đúng thứ tự", async () => {
    const { tab } = setup();
    const before = tab("A1");
    const reqs = [rename(id(1), "Một"), rename(id(2), "Hai"), rename(id(1), "Ba")];
    reqs.forEach((r, i) => before.queue(r, `l${i}`));
    await before.idle();

    // Tab cũ đã đóng (không còn trong danh sách tab sống).
    const after = tab("A2");
    const claimed = await after.claim();
    expect(claimed.map((r) => r.opId)).toEqual(reqs.map((r) => r.opId));
    expect(claimed.map((r) => r.label)).toEqual(["l0", "l1", "l2"]);
    expect(claimed.every((r) => r.owner === "A2")).toBe(true);
  });

  it("hai tab cùng nhận hàng đợi của tab đã chết: mỗi thao tác chỉ về MỘT tab", async () => {
    const { storage, tab } = setup((me) => new Set(["B", "C"].filter((t) => t !== me)));
    const dead = tab("DEAD");
    const reqs = [rename(id(1), "Một"), rename(id(2), "Hai")];
    reqs.forEach((r) => dead.queue(r, "x"));
    await dead.idle();

    const [b, c] = [tab("B"), tab("C")];
    const [fromB, fromC] = await Promise.all([b.claim(), c.claim()]);
    const all = [...fromB, ...fromC].map((r) => r.opId).sort();
    expect(all).toEqual(reqs.map((r) => r.opId).sort()); // không thiếu, không trùng
    expect(storage.all().every((r) => r.owner === "B" || r.owner === "C")).toBe(true);
  });

  it("không giành thao tác của tab còn sống", async () => {
    const { tab } = setup((me) => new Set(["A", "B"].filter((t) => t !== me)));
    const a = tab("A");
    a.queue(rename(id(1), "Một"), "x");
    await a.idle();
    expect(await tab("B").claim()).toEqual([]);
    // Còn chính tab A (rời bảng rồi quay lại trong cùng một tab) thì nhận lại được.
    expect(await a.claim()).toHaveLength(1);
  });

  it("không biết tab nào còn sống (không có Web Locks) thì nhận hết — an toàn nhờ server chống ghi trùng", async () => {
    const { tab } = setup(() => null);
    const a = tab("A");
    a.queue(rename(id(1), "Một"), "x");
    await a.idle();
    expect(await tab("B").claim()).toHaveLength(1);
  });

  it("thao tác vừa xong (đĩa chưa kịp xóa) không bị nhận lại, kể cả bởi chính tab đó", async () => {
    const { tab } = setup();
    const a = tab("A");
    const r1 = rename(id(1), "Một");
    const r2 = rename(id(2), "Hai");
    a.queue(r1, "x");
    a.queue(r2, "y");
    await a.idle();
    a.retain([r2.opId]); // r1 vừa được xác nhận; lần xóa còn đang chờ trong hàng ghi
    const claimed = await a.claim();
    expect(claimed.map((r) => r.opId)).toEqual([r2.opId]);
  });

  it("không lẫn bảng hay người dùng khác", async () => {
    const storage = new MemoryOutboxStorage();
    const mk = (userId: string, boardId: string, tabId: string) =>
      new Outbox({ storage, userId, boardId, tabId, liveTabs: async () => null });
    const a = mk(ME, BOARD, "A");
    a.queue(rename(id(1), "Một"), "x");
    await a.idle();
    expect(await mk(ME, id(77), "B").claim()).toEqual([]);
    expect(await mk(id(78), BOARD, "B").claim()).toEqual([]);
  });

  it("ghi đĩa lỗi thì báo, đánh dấu không bền, và không làm sập hàng đợi", async () => {
    const storage = new MemoryOutboxStorage();
    storage.add = async () => {
      throw new Error("QuotaExceededError");
    };
    const errors: unknown[] = [];
    const o = new Outbox({
      storage,
      userId: ME,
      boardId: BOARD,
      tabId: "A",
      liveTabs: async () => null,
      onStorageError: (e) => errors.push(e),
    });
    expect(o.durable).toBe(true);
    o.queue(rename(id(1), "Một"), "x");
    await o.idle();
    expect(errors).toHaveLength(1);
    expect(o.durable).toBe(false);
    o.retain([]); // vẫn chạy được
    await o.idle();
  });

  it("thao tác bị từ chối được lưu lại, và bỏ qua thì xóa", async () => {
    const { tab } = setup();
    const a = tab("A");
    const req = rename(id(1), "Một");
    const failed: FailedOp = {
      opId: req.opId,
      userId: ME,
      boardId: BOARD,
      request: req,
      label: "x",
      error: { status: 409, code: "version_conflict", message: "Someone else just changed this card" },
      failedAt: "2026-11-10T00:00:00.000Z",
    };
    a.fail(failed);
    expect(await tab("B").listFailed()).toEqual([failed]); // tải lại trang vẫn thấy
    a.dismissFailed([req.opId]);
    expect(await tab("B").listFailed()).toEqual([]);
  });
});

describe("describeRequest", () => {
  it("giữ nguyên chữ người dùng gõ", () => {
    expect(describeRequest(view, rename(id(1), "Tiêu đề mới"))).toBe("Change “Thẻ 1”: title to “Tiêu đề mới”");
    const create: OpRequest = { opId: opId(), type: "card.create", payload: { id: id(9), columnId: DONE, title: "Việc mới" } };
    expect(describeRequest(view, create)).toBe("Add card “Việc mới” to “Done”");
  });

  it("mô tả được thẻ đã biến mất khỏi bảng bằng dữ liệu kèm theo", () => {
    const gone = card(5, { title: "Đã xóa" });
    const req: OpRequest = { opId: opId(), type: "card.restore", payload: { cardId: gone.id } };
    expect(describeRequest(view, req)).toBe("Restore card a card");
    expect(describeRequest(view, req, { restoreCard: gone })).toBe("Restore card “Đã xóa”");
  });

  it("cắt tên quá dài, và nhiều trường thì liệt kê hết", () => {
    expect(describeRequest(view, rename(id(1), "x".repeat(100)))).toContain("…");
    const req: OpRequest = {
      opId: opId(),
      type: "card.update",
      payload: { cardId: id(1), dueDate: null, columnId: DONE, baseVersion: 1 },
    };
    expect(describeRequest(view, req)).toBe("Change “Thẻ 1”: clear the due date, column to “Done”");
  });
});

describe("thử lại thao tác bị từ chối", () => {
  const failedWith = (request: OpRequest, code: string, status = 409): FailedOp => ({
    opId: request.opId,
    userId: ME,
    boardId: BOARD,
    request,
    label: "x",
    error: { status, code, message: "m" },
    failedAt: "2026-11-10T00:00:00.000Z",
  });

  it("xung đột phiên bản → 'Use mine': cùng nội dung, bỏ baseVersion, opId mới", () => {
    const req = rename(id(1), "Của tôi");
    const opt = retryOption(failedWith(req, "version_conflict"))!;
    expect(opt.label).toBe("Use mine");
    const [next, ...rest] = opt.requests(opId);
    expect(rest).toEqual([]);
    expect(next!.opId).not.toBe(req.opId);
    expect(next).toMatchObject({ type: "card.update", payload: { cardId: id(1), title: "Của tôi" } });
    expect((next!.payload as { baseVersion?: number }).baseVersion).toBeUndefined();
  });

  it("thẻ đã bị xóa → khôi phục rồi áp dụng lại, đúng thứ tự", () => {
    const req = rename(id(1), "Của tôi");
    const [restore, again] = retryOption(failedWith(req, "card_deleted", 410))!.requests(opId);
    expect(restore).toMatchObject({ type: "card.restore", payload: { cardId: id(1) } });
    expect(again).toMatchObject({ type: "card.update", payload: { title: "Của tôi", baseVersion: 1 } });
    expect(new Set([restore!.opId, again!.opId, req.opId]).size).toBe(3);
  });

  it("không có quyền / không tìm thấy thì chỉ cho bỏ qua", () => {
    const req = rename(id(1), "x");
    expect(retryOption(failedWith(req, "forbidden", 403))).toBeNull();
    expect(retryOption(failedWith(req, "not_found", 404))).toBeNull();
  });

  it("lỗi khác (vd. cột chưa trống) thì cho thử lại nguyên văn với opId mới", () => {
    const req: OpRequest = { opId: opId(), type: "column.delete", payload: { columnId: TODO } };
    const [next] = retryOption(failedWith(req, "column_not_empty"))!.requests(opId);
    expect(next).toMatchObject({ type: "column.delete", payload: { columnId: TODO } });
    expect(next!.opId).not.toBe(req.opId);
  });

  it("lỗi tạm thời: giới hạn tốc độ, bận, lỗi server", () => {
    expect(isTransientError({ status: 429, code: "rate_limited" })).toBe(true);
    expect(isTransientError({ status: 409, code: "busy" })).toBe(true);
    expect(isTransientError({ status: 500, code: "internal" })).toBe(true);
    expect(isTransientError({ status: 409, code: "version_conflict" })).toBe(false);
    expect(isTransientError({ status: 410, code: "card_deleted" })).toBe(false);
  });
});
