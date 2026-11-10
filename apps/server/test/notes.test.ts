import { NOTE_FIELD, NOTE_MAX_UPDATE_BYTES, noteSummary, type Card, type BoardSnapshot, type NoteOpenAck } from "@tandem/shared";
import fc from "fast-check";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { pool } from "../src/db";
import { noteStore } from "../src/realtime";
import { addMember, createBoard, registerUser } from "./helpers";
import { connect, errorCode, join, okOp, sendOp, sleep, useRealtimeServer, waitFor, type ClientSocket } from "./socket-helpers";

useRealtimeServer();

// ---------- Client ghi chú tối giản: làm đúng như web (apps/web/src/sync/noteSync.ts) ----------

class NoteClient {
  readonly doc: Y.Doc;
  readonly sent: Promise<{ ok: boolean; error?: { code: string } }>[] = [];
  readonly closed: { cardId: string; reason: string }[] = [];
  readonly awarenessIn: Uint8Array[] = [];

  constructor(
    public socket: ClientSocket,
    readonly cardId: string,
    doc?: Y.Doc,
  ) {
    this.doc = doc ?? new Y.Doc();
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "server") return;
      this.sent.push(this.socket.emitWithAck("note.update", { cardId: this.cardId, update }));
    });
    this.listen(socket);
  }

  /** Gắn vào một socket (mới, sau khi kết nối lại). */
  listen(socket: ClientSocket) {
    this.socket = socket;
    socket.on("note.update", ({ cardId, update }) => {
      if (cardId === this.cardId) Y.applyUpdate(this.doc, new Uint8Array(update), "server");
    });
    socket.on("note.closed", (msg) => this.closed.push(msg));
    socket.on("note.awareness", ({ cardId, update }) => {
      if (cardId === this.cardId) this.awarenessIn.push(new Uint8Array(update));
    });
  }

  /** Đồng bộ hai chiều trong một vòng: nhận phần mình thiếu, gửi phần server thiếu. */
  async open(): Promise<NoteOpenAck> {
    const res = await this.socket.emitWithAck("note.open", { cardId: this.cardId, stateVector: Y.encodeStateVector(this.doc) });
    if (!res.ok) return res;
    Y.applyUpdate(this.doc, new Uint8Array(res.update), "server");
    const mine = Y.encodeStateAsUpdate(this.doc, new Uint8Array(res.stateVector));
    // Update rỗng mã hóa thành 2 byte [0, 0].
    if (mine.byteLength > 2) this.sent.push(this.socket.emitWithAck("note.update", { cardId: this.cardId, update: mine }));
    return res;
  }

  /** Chờ server nhận hết những gì đã gửi; trả về các ack. */
  async settle() {
    return Promise.all(this.sent.splice(0));
  }

  get fragment() {
    return this.doc.getXmlFragment(NOTE_FIELD);
  }

  /** Nội dung dạng XML (đủ để so sánh hai bản sao). */
  get xml(): string {
    return this.fragment.toString();
  }

  /** Chữ của đoạn đầu tiên (tạo đoạn nếu chưa có). */
  paragraph(): Y.XmlText {
    let p = this.fragment.toArray().find((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === "paragraph");
    if (!p) {
      p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText()]);
      this.fragment.insert(0, [p]);
    }
    return p.get(0) as Y.XmlText;
  }

  type(index: number, text: string) {
    const t = this.paragraph();
    t.insert(Math.min(index, t.length), text);
  }
}

/** Đọc ghi chú đã lưu trong DB thành Y.Doc. */
async function storedDoc(cardId: string): Promise<Y.Doc | null> {
  const { rows } = await pool.query<{ ydoc: Buffer }>("SELECT ydoc FROM card_notes WHERE card_id = $1", [cardId]);
  if (!rows[0]) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(rows[0].ydoc));
  return doc;
}

const xmlOf = (doc: Y.Doc | null) => doc?.getXmlFragment(NOTE_FIELD).toString() ?? null;

/** An (chủ) và Bình (editor), một bảng một thẻ, cả hai đã vào bảng. */
async function setup(role: "editor" | "viewer" = "editor") {
  const a = await registerUser("An");
  const b = await registerUser("Bình");
  await addMember(a, b, role);
  const snap = await createBoard(a);
  const boardId = snap.board.id;
  const columnId = snap.columns[0]!.id;
  const card = (await a.post(`/api/columns/${columnId}/cards`, { title: "Thẻ có ghi chú" }).expect(201)).body as Card;
  const sa = await connect(a.token);
  const sb = await connect(b.token);
  expect((await join(sa, boardId)).ok).toBe(true);
  expect((await join(sb, boardId)).ok).toBe(true);
  return { a, b, boardId, columnId, cardId: card.id, sa, sb };
}

async function opened(n: NoteClient) {
  const res = await n.open();
  if (!res.ok) throw new Error(`note.open bị từ chối: ${res.error.code}`);
  return res;
}

describe("ghi chú nhiều người cùng gõ", () => {
  it("người mở sau nhận nội dung hiện có; hai người gõ cùng lúc thì hội tụ, server và DB giống hệt", async () => {
    const { sa, sb, cardId } = await setup();
    const na = new NoteClient(sa, cardId);
    await opened(na);
    na.type(0, "Xin chào");
    await na.settle();

    const nb = new NoteClient(sb, cardId);
    const res = await opened(nb);
    expect(res.canEdit).toBe(true);
    expect(nb.paragraph().toString()).toBe("Xin chào");

    // Cùng chèn vào ĐÚNG một vị trí cùng lúc: Yjs giữ cả hai, mọi bản sao xếp giống nhau.
    na.type(3, "AAA");
    nb.type(3, "BBB");
    await Promise.all([na.settle(), nb.settle()]);
    await waitFor(() => na.xml === nb.xml, 2000, "hai bản sao giống nhau");
    expect(na.paragraph().toString()).toMatch(/^Xin(AAABBB|BBBAAA) chào$/);
    expect(noteStore().get(cardId)!.doc.getXmlFragment(NOTE_FIELD).toString()).toBe(na.xml);

    await noteStore().flushAll();
    expect(xmlOf(await storedDoc(cardId))).toBe(na.xml);
  });

  it("lưu trạng thái Yjs: bỏ khỏi bộ nhớ rồi mở lại thì nạp từ DB; nội dung đã xóa được dọn (GC)", async () => {
    const { sa, sb, cardId } = await setup();
    const na = new NoteClient(sa, cardId);
    await opened(na);
    na.type(0, "x".repeat(20_000));
    await na.settle();
    na.paragraph().delete(0, 20_000);
    na.type(0, "Còn lại");
    await na.settle();

    sa.emit("note.close", { cardId });
    await waitFor(() => noteStore().get(cardId)?.sessions.size === 0, 2000, "đã rời ghi chú");
    await noteStore().unloadNow(cardId);
    expect(noteStore().get(cardId)).toBeUndefined();

    const { rows } = await pool.query<{ n: number }>("SELECT octet_length(ydoc) AS n FROM card_notes WHERE card_id = $1", [cardId]);
    // 20 000 ký tự đã xóa không còn nằm trong trạng thái đã lưu.
    expect(rows[0]!.n).toBeLessThan(500);

    const nb = new NoteClient(sb, cardId);
    await opened(nb);
    expect(nb.paragraph().toString()).toBe("Còn lại");
  });

  it("mất kết nối vẫn gõ tiếp được; kết nối lại thì hai bên tự bù cho nhau phần còn thiếu", async () => {
    const { b, sa, sb, boardId, cardId } = await setup();
    const na = new NoteClient(sa, cardId);
    const nb = new NoteClient(sb, cardId);
    await opened(na);
    await opened(nb);
    na.type(0, "chung ");
    await na.settle();
    await waitFor(() => nb.paragraph().toString() === "chung ", 2000, "Bình nhận chữ của An");

    sb.disconnect();
    nb.type(6, "offline-của-Bình");
    // Lần gửi lúc offline nằm trên socket cũ, không bao giờ có ack. Client thật cũng bỏ chúng: kết nối lại
    // thì note.open gửi state vector và phần còn thiếu được đẩy lên trong một lần.
    nb.sent.splice(0);
    na.type(0, "online-của-An ");
    await na.settle();

    const sb2 = await connect(b.token);
    nb.listen(sb2);
    expect((await join(sb2, boardId)).ok).toBe(true);
    await opened(nb); // gửi state vector → nhận phần của An, gửi lên phần của mình
    await nb.settle();
    await waitFor(() => na.xml === nb.xml, 2000, "hội tụ sau khi kết nối lại");
    expect(na.paragraph().toString()).toBe("online-của-An chung offline-của-Bình");
  });

  it("hội tụ với nhiều người sửa ngẫu nhiên cùng lúc (fast-check, seed cố định)", async () => {
    const { a, sa, sb, boardId, cardId } = await setup();
    const c = await registerUser("Chi");
    await addMember(a, c, "editor");
    const sc = await connect(c.token);
    expect((await join(sc, boardId)).ok).toBe(true);
    const clients = [new NoteClient(sa, cardId), new NoteClient(sb, cardId), new NoteClient(sc, cardId)];
    for (const n of clients) await opened(n);

    const edit = fc.record({
      who: fc.integer({ min: 0, max: 2 }),
      kind: fc.constantFrom("insert", "insert", "delete"),
      at: fc.nat(200),
      text: fc.string({ minLength: 1, maxLength: 5 }),
      len: fc.integer({ min: 1, max: 4 }),
    });
    const edits = fc.sample(fc.array(edit, { minLength: 60, maxLength: 60 }), { numRuns: 1, seed: 20261110 })[0]!;
    for (const [i, e] of edits.entries()) {
      const n = clients[e.who]!;
      const t = n.paragraph();
      if (e.kind === "insert" || t.length === 0) t.insert(e.at % (t.length + 1), e.text);
      else {
        const at = e.at % t.length;
        t.delete(at, Math.min(e.len, t.length - at));
      }
      // Thỉnh thoảng nhường để các thay đổi đan xen trên mạng.
      if (i % 7 === 0) await sleep(1);
    }
    await Promise.all(clients.map((n) => n.settle()));
    await waitFor(() => clients.every((n) => n.xml === clients[0]!.xml), 3000, "cả 3 bản sao giống nhau");
    await noteStore().flushAll();
    expect(xmlOf(await storedDoc(cardId))).toBe(clients[0]!.xml);
  });
});

describe("tóm tắt ghi chú trên mặt thẻ (card.notes có seq)", () => {
  function checklist(n: NoteClient, items: [string, boolean][]) {
    const list = new Y.XmlElement("taskList");
    // Như TipTap: cả khối trong một transaction (taskList rỗng không hợp lệ với schema ProseMirror).
    n.doc.transact(() => {
    n.fragment.insert(n.fragment.length, [list]);
    list.insert(
      0,
      items.map(([text, checked]) => {
        const item = new Y.XmlElement("taskItem");
        item.setAttribute("checked", checked as unknown as string);
        const p = new Y.XmlElement("paragraph");
        p.insert(0, [new Y.XmlText(text)]);
        item.insert(0, [p]);
        return item;
      }),
    );
    });
    return list;
  }

  it("tiến độ checklist đổi → thao tác card.notes cho cả bảng; gõ chữ mà tóm tắt không đổi thì không sinh thao tác", async () => {
    const { a, sa, sb, boardId, cardId } = await setup();
    const na = new NoteClient(sa, cardId);
    await opened(na);
    const list = checklist(na, [
      ["Viết test", true],
      ["Deploy", false],
    ]);
    await na.settle();
    await noteStore().flushAll();

    await waitFor(() => sb.received.some((op) => op.type === "card.notes"), 2000, "Bình nhận card.notes");
    const op = sb.received.find((o) => o.type === "card.notes")!;
    expect(op.type === "card.notes" && op.payload.card.note).toEqual({ hasText: true, done: 1, total: 2 });
    expect(op.actorId).toBe(a.id);

    // Ảnh chụp bảng (tải lại trang) cũng có tóm tắt, và seq liên tục.
    const snap = (await a.get(`/api/boards/${boardId}`).expect(200)).body as BoardSnapshot;
    expect(snap.cards.find((k) => k.id === cardId)!.note).toEqual({ hasText: true, done: 1, total: 2 });
    expect(snap.seq).toBe(op.seq);

    const count = () => sb.received.filter((o) => o.type === "card.notes").length;
    na.type(0, "thêm chữ");
    await na.settle();
    await noteStore().flushAll();
    await sleep(50);
    expect(count()).toBe(1);

    // Tick nốt việc còn lại.
    (list.get(1) as Y.XmlElement).setAttribute("checked", true as unknown as string);
    await na.settle();
    await noteStore().flushAll();
    await waitFor(() => count() === 2, 2000, "card.notes lần hai");
    const last = sb.received.filter((o) => o.type === "card.notes").at(-1)!;
    expect(last.type === "card.notes" && last.payload.card.note).toEqual({ hasText: true, done: 2, total: 2 });
  });

  it("tóm tắt không làm người đang sửa tiêu đề bị báo xung đột (không tăng version)", async () => {
    const { sa, sb, boardId, cardId } = await setup();
    const na = new NoteClient(sa, cardId);
    await opened(na);
    const before = (await pool.query<{ version: number }>("SELECT version FROM cards WHERE id = $1", [cardId])).rows[0]!.version;
    checklist(na, [["Một việc", false]]);
    await na.settle();
    await noteStore().flushAll();
    const after = (await pool.query<{ version: number }>("SELECT version FROM cards WHERE id = $1", [cardId])).rows[0]!.version;
    expect(after).toBe(before);
    okOp(await sendOp(sb, boardId, { opId: crypto.randomUUID(), type: "card.update", payload: { cardId, title: "Mới", baseVersion: before } }));
  });

  it("noteSummary: trống là null, chỉ có chữ, chỉ có checklist", () => {
    const doc = new Y.Doc();
    expect(noteSummary(doc)).toBeNull();
    const f = doc.getXmlFragment(NOTE_FIELD);
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("   ")]);
    f.insert(0, [p]);
    expect(noteSummary(doc)).toBeNull(); // chỉ khoảng trắng
    (p.get(0) as Y.XmlText).insert(0, "chữ");
    expect(noteSummary(doc)).toEqual({ hasText: true, done: 0, total: 0 });
  });
});

describe("quyền với ghi chú", () => {
  it("viewer mở được, thấy người khác gõ, nhưng không sửa được", async () => {
    const { sa, sb, cardId } = await setup("viewer");
    const na = new NoteClient(sa, cardId);
    const nb = new NoteClient(sb, cardId);
    await opened(na);
    const res = await opened(nb);
    expect(res.canEdit).toBe(false);

    na.type(0, "của chủ");
    await na.settle();
    await waitFor(() => nb.paragraph().toString() === "của chủ", 2000, "viewer thấy chữ");

    nb.type(0, "lén sửa ");
    const [ack] = await nb.settle();
    expect(ack && errorCode(ack as never)).toBe("forbidden");
    await sleep(50);
    expect(na.paragraph().toString()).toBe("của chủ");
  });

  it("người ngoài nhóm, hoặc chưa vào bảng, không mở được ghi chú", async () => {
    const { cardId, a, boardId } = await setup();
    const stranger = await registerUser("Người lạ");
    const ss = await connect(stranger.token);
    expect((await join(ss, boardId)).ok).toBe(false);
    expect(errorCode(await new NoteClient(ss, cardId).open())).toBe("not_found");

    // Thành viên nhưng chưa vào phòng bảng (chưa qua kiểm tra quyền trên socket này).
    const sa2 = await connect(a.token);
    expect(errorCode(await new NoteClient(sa2, cardId).open())).toBe("not_found");
    // Gửi thay đổi mà chưa mở.
    const ack = await sa2.emitWithAck("note.update", { cardId, update: Y.encodeStateAsUpdate(new Y.Doc()) });
    expect(errorCode(ack)).toBe("note_not_open");
  });

  it("bị xóa khỏi nhóm khi đang mở ghi chú: bị đóng ngay, gửi tiếp bị từ chối", async () => {
    const { a, b, sb, cardId } = await setup();
    const nb = new NoteClient(sb, cardId);
    await opened(nb);
    await a.del(`/api/workspaces/${a.workspaceId}/members/${b.id}`).expect(204);
    await waitFor(() => nb.closed.length > 0, 2000, "note.closed");
    expect(nb.closed[0]).toEqual({ cardId, reason: "board_left" });

    nb.type(0, "sau khi bị xóa");
    const [ack] = await nb.settle();
    expect(errorCode(ack as never)).toBe("note_not_open");
    expect(noteStore().get(cardId)?.sessions.size ?? 0).toBe(0);
  });

  it("bị hạ xuống viewer khi đang gõ: lần gửi kế tiếp bị từ chối ngay (không chờ tra DB)", async () => {
    const { a, b, sb, cardId } = await setup();
    const nb = new NoteClient(sb, cardId);
    await opened(nb);
    nb.type(0, "trước");
    expect((await nb.settle()).every((r) => r.ok)).toBe(true);

    const roleEvent = new Promise((r) => sb.once("access.role", r));
    await a.patch(`/api/workspaces/${a.workspaceId}/members/${b.id}`, { role: "viewer" }).expect(200);
    await roleEvent;
    nb.type(0, "sau ");
    const [ack] = await nb.settle();
    expect(errorCode(ack as never)).toBe("forbidden");
  });

  it("thẻ bị xóa hẳn (xóa cột) khi ghi chú còn chưa lưu: người đang mở được báo card_deleted", async () => {
    const { sa, boardId, columnId, cardId } = await setup();
    const na = new NoteClient(sa, cardId);
    await opened(na);
    na.type(0, "chưa kịp lưu");
    await na.settle();
    okOp(await sendOp(sa, boardId, { opId: crypto.randomUUID(), type: "card.delete", payload: { cardId } }));
    okOp(await sendOp(sa, boardId, { opId: crypto.randomUUID(), type: "column.delete", payload: { columnId } }));
    await noteStore().flushAll();
    await waitFor(() => na.closed.length > 0, 2000, "note.closed");
    expect(na.closed[0]).toEqual({ cardId, reason: "card_deleted" });
    expect(noteStore().get(cardId)).toBeUndefined();
  });

  it("thẻ đã xóa mềm thì không mở ghi chú được", async () => {
    const { sa, boardId, cardId } = await setup();
    okOp(await sendOp(sa, boardId, { opId: crypto.randomUUID(), type: "card.delete", payload: { cardId } }));
    expect(errorCode(await new NoteClient(sa, cardId).open())).toBe("card_deleted");
  });
});

describe("dữ liệu xấu và giới hạn", () => {
  it("update hỏng bị từ chối, ghi chú không bị ảnh hưởng", async () => {
    const { sa, cardId } = await setup();
    const na = new NoteClient(sa, cardId);
    await opened(na);
    na.type(0, "ổn");
    await na.settle();
    const ack = await sa.emitWithAck("note.update", { cardId, update: new Uint8Array([1, 2, 3, 250, 251, 252, 253]) });
    expect(errorCode(ack)).toBe("invalid_input");
    expect(noteStore().get(cardId)!.doc.getXmlFragment(NOTE_FIELD).toString()).toBe(na.xml);
  });

  it("một lần gửi quá lớn bị từ chối; ghi chú vượt giới hạn tổng thì bị từ chối", async () => {
    const { sa, cardId } = await setup();
    const na = new NoteClient(sa, cardId);
    await opened(na);
    const huge = await sa.emitWithAck("note.update", { cardId, update: new Uint8Array(NOTE_MAX_UPDATE_BYTES + 1).fill(1) });
    expect(errorCode(huge)).toBe("invalid_input");

    // ~240 KB mỗi lần, lần thứ 5 vượt 1 MB. (Tạo đoạn văn trước, để mỗi lần gõ đúng một update.)
    na.paragraph();
    await na.settle();
    const codes: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      na.type(0, "y".repeat(240_000));
      codes.push(...(await na.settle()).map((r) => errorCode(r as never)));
    }
    expect(codes.slice(0, 4)).toEqual([null, null, null, null]);
    expect(codes[4]).toBe("note_too_large");
  });
});

describe("con trỏ (awareness)", () => {
  /** awareness update với một trạng thái tùy ý (kể cả mạo danh). */
  function rawAwareness(clientId: number, clock: number, state: unknown): Uint8Array {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint(enc, clientId);
    encoding.writeVarUint(enc, clock);
    encoding.writeVarString(enc, JSON.stringify(state));
    return encoding.toUint8Array(enc);
  }

  function statesFrom(updates: Uint8Array[]) {
    const aw = new Awareness(new Y.Doc());
    aw.setLocalState(null);
    for (const u of updates) applyAwarenessUpdate(aw, u, "server");
    const states = new Map(aw.getStates());
    aw.destroy();
    return states;
  }

  it("server ghi đè danh tính: không mạo danh được người khác; rời đi thì con trỏ biến mất", async () => {
    const { a, b, sa, sb, cardId } = await setup();
    const na = new NoteClient(sa, cardId);
    const nb = new NoteClient(sb, cardId);
    await opened(na);
    await opened(nb);

    sb.emit("note.awareness", {
      cardId,
      update: rawAwareness(4242, 1, { user: { id: a.id, name: "An (giả)", color: "#000" }, typing: true, cursor: { anchor: 1 }, xss: "<img>" }),
    });
    await waitFor(() => na.awarenessIn.length > 0, 2000, "An nhận con trỏ của Bình");
    const state = statesFrom(na.awarenessIn).get(4242) as Record<string, unknown>;
    expect((state.user as { id: string; name: string }).id).toBe(b.id);
    expect((state.user as { name: string }).name).toMatch(/^Bình/);
    expect(state.typing).toBe(true);
    // { anchor: 1 } không phải vị trí hợp lệ (thiếu head): chuyển tiếp nó sẽ làm hỏng editor bên nhận.
    expect(state.cursor).toBeUndefined();
    expect(state.xss).toBeUndefined();

    // Người mở sau nhận con trỏ đang có ngay trong note.open.
    const sa2 = await connect(a.token);
    expect((await join(sa2, (await pool.query("SELECT board_id FROM cards WHERE id = $1", [cardId])).rows[0].board_id)).ok).toBe(true);
    const late = await opened(new NoteClient(sa2, cardId));
    expect(statesFrom([new Uint8Array(late.awareness!)]).has(4242)).toBe(true);

    // An không xóa/sửa được con trỏ của Bình (clientID thuộc kết nối khác).
    na.awarenessIn.length = 0;
    sa.emit("note.awareness", { cardId, update: rawAwareness(4242, 2, null) });
    await sleep(100);
    expect(noteStore().get(cardId)!.awareness.getStates().has(4242)).toBe(true);

    // Bình đóng ghi chú → An nhận bản xóa con trỏ.
    sb.emit("note.close", { cardId });
    await waitFor(() => !statesFrom(na.awarenessIn).has(4242) && na.awarenessIn.length > 0, 2000, "con trỏ bị xóa");
    expect(noteStore().get(cardId)!.awareness.getStates().has(4242)).toBe(false);
  });

  // Lỗi tìm ra lúc review tuần 5: y-tiptap gọi thẳng Y.createRelativePositionFromJSON(cursor.anchor) không
  // có try/catch, nên một cursor sai định dạng từ một người làm hỏng editor của mọi người đang mở ghi chú.
  it("cursor sai định dạng bị bỏ; cursor đúng được chuyển tiếp (đã lọc trường lạ) và giải mã được", async () => {
    const { sb, sa, cardId } = await setup();
    const na = new NoteClient(sa, cardId);
    await opened(na);
    await opened(new NoteClient(sb, cardId));

    const ref = new Y.Doc();
    const frag = ref.getXmlFragment("default");
    const relJson = (index: number, assoc = 0) =>
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(frag, index, assoc));
    const good = { anchor: relJson(0), head: relJson(0, -1) };
    const bad: unknown[] = [
      1,
      "x",
      [],
      { anchor: 1 },
      { anchor: good.anchor },
      { anchor: good.anchor, head: {} },
      { anchor: good.anchor, head: { tname: "khac" } },
      { anchor: good.anchor, head: { item: { client: "1", clock: 0 } } },
    ];
    const ids = [5001, 5002];
    sb.emit("note.awareness", { cardId, update: rawAwareness(ids[0]!, 1, { cursor: { ...good, extra: "<img>" } }) });
    await waitFor(() => statesFrom(na.awarenessIn).has(ids[0]!), 2000, "nhận cursor hợp lệ");
    const kept = statesFrom(na.awarenessIn).get(ids[0]!) as { cursor: { anchor: unknown; head: unknown } };
    expect(kept.cursor).toEqual(good);

    for (const [i, cursor] of bad.entries()) {
      na.awarenessIn.length = 0;
      sb.emit("note.awareness", { cardId, update: rawAwareness(ids[1]!, i + 1, { cursor }) });
      await waitFor(() => statesFrom(na.awarenessIn).has(ids[1]!), 2000, `nhận awareness #${i}`);
      const state = statesFrom(na.awarenessIn).get(ids[1]!) as { cursor?: unknown };
      expect(state.cursor, JSON.stringify(cursor)).toBeUndefined();
    }

    // Mọi cursor server từng chuyển đi đều giải mã được như y-tiptap làm ở bên nhận.
    for (const s of noteStore().get(cardId)!.awareness.getStates().values()) {
      const c = (s as { cursor?: { anchor: unknown; head: unknown } | null }).cursor;
      if (c == null) continue;
      expect(() => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(c.anchor), ref)).not.toThrow();
      expect(() => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(c.head), ref)).not.toThrow();
    }
    ref.destroy();
  });

  it("viewer không bao giờ hiện là đang gõ", async () => {
    const { sa, sb, cardId } = await setup("viewer");
    const na = new NoteClient(sa, cardId);
    await opened(na);
    await opened(new NoteClient(sb, cardId));
    const aw = new Awareness(new Y.Doc());
    aw.setLocalState({ typing: true });
    sb.emit("note.awareness", { cardId, update: encodeAwarenessUpdate(aw, [aw.clientID]) });
    await waitFor(() => na.awarenessIn.length > 0, 2000, "nhận awareness");
    expect((statesFrom(na.awarenessIn).get(aw.clientID) as { typing: boolean }).typing).toBe(false);
    aw.destroy();
  });
});
