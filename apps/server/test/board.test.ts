import type { Card } from "@tandem/shared";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addMember, createBoard, registerUser } from "./helpers";

describe("bảng → cột → thẻ", () => {
  it("bảng mới có sẵn 3 cột theo đúng thứ tự", async () => {
    const u = await registerUser();
    const snap = await createBoard(u);
    expect(snap.columns.map((c) => c.title)).toEqual(["To do", "In progress", "Done"]);
    expect(snap.role).toBe("owner");
  });

  it("thêm thẻ nối vào cuối cột, vị trí tăng dần", async () => {
    const u = await registerUser();
    const snap = await createBoard(u);
    const col = snap.columns[0]!.id;
    const titles = ["Một", "Hai", "Ba"];
    for (const title of titles) await u.post(`/api/columns/${col}/cards`, { title }).expect(201);

    const again = await u.get(`/api/boards/${snap.board.id}`).expect(200);
    const cards = again.body.cards as Card[];
    expect(cards.map((c) => c.title)).toEqual(titles);
    const positions = cards.map((c) => c.position);
    expect([...positions].sort()).toEqual(positions);
  });

  it("thêm nhiều thẻ song song vào cùng cột không trùng vị trí", async () => {
    const u = await registerUser();
    const snap = await createBoard(u);
    const col = snap.columns[0]!.id;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => u.post(`/api/columns/${col}/cards`, { title: `Thẻ ${i}` })),
    );
    const positions = new Set(results.map((r) => r.body.position));
    expect(positions.size).toBe(10);
  });

  it("client tự sinh id cho thẻ; gửi trùng id thì báo 409", async () => {
    const u = await registerUser();
    const snap = await createBoard(u);
    const id = randomUUID();
    const res = await u.post(`/api/columns/${snap.columns[0]!.id}/cards`, { id, title: "Có id sẵn" }).expect(201);
    expect(res.body.id).toBe(id);
    await u.post(`/api/columns/${snap.columns[0]!.id}/cards`, { id, title: "Trùng" }).expect(409);
  });

  it("sửa thẻ tăng version; gửi baseVersion cũ thì báo xung đột", async () => {
    const u = await registerUser();
    const snap = await createBoard(u);
    const card = (await u.post(`/api/columns/${snap.columns[0]!.id}/cards`, { title: "A" }).expect(201)).body as Card;

    const v2 = await u.patch(`/api/cards/${card.id}`, { title: "B", baseVersion: 1 }).expect(200);
    expect(v2.body.version).toBe(2);

    const conflict = await u.patch(`/api/cards/${card.id}`, { title: "C", baseVersion: 1 }).expect(409);
    expect(conflict.body.error.code).toBe("version_conflict");
    expect(conflict.body.error.details.card.title).toBe("B");
  });

  it("chuyển thẻ sang cột khác trong cùng bảng", async () => {
    const u = await registerUser();
    const snap = await createBoard(u);
    const [todo, doing] = snap.columns;
    const card = (await u.post(`/api/columns/${todo!.id}/cards`, { title: "Đi" }).expect(201)).body as Card;
    const moved = await u.patch(`/api/cards/${card.id}`, { columnId: doing!.id }).expect(200);
    expect(moved.body.columnId).toBe(doing!.id);
  });

  it("đặt hạn và người phụ trách; người phụ trách phải là thành viên nhóm", async () => {
    const u = await registerUser();
    const stranger = await registerUser();
    const snap = await createBoard(u);
    const card = (await u.post(`/api/columns/${snap.columns[0]!.id}/cards`, { title: "X" }).expect(201)).body as Card;

    const ok = await u.patch(`/api/cards/${card.id}`, { dueDate: "2026-12-31", assigneeId: u.id }).expect(200);
    expect(ok.body).toMatchObject({ dueDate: "2026-12-31", assigneeId: u.id });
    await u.patch(`/api/cards/${card.id}`, { assigneeId: stranger.id }).expect(400);
  });

  it("xóa mềm rồi khôi phục; sửa thẻ đã xóa thì báo ai đã xóa", async () => {
    const owner = await registerUser("Chủ");
    const lan = await registerUser("Lan");
    await addMember(owner, lan, "editor");
    const snap = await createBoard(owner);
    const card = (await owner.post(`/api/columns/${snap.columns[0]!.id}/cards`, { title: "X" }).expect(201)).body as Card;

    await lan.del(`/api/cards/${card.id}`).expect(200);
    const after = await owner.get(`/api/boards/${snap.board.id}`).expect(200);
    expect(after.body.cards).toHaveLength(0);

    const gone = await owner.patch(`/api/cards/${card.id}`, { title: "Y" }).expect(410);
    expect(gone.body.error.code).toBe("card_deleted");
    expect(gone.body.error.message).toContain("Lan");

    await owner.post(`/api/cards/${card.id}/restore`).expect(200);
    const restored = await owner.get(`/api/boards/${snap.board.id}`).expect(200);
    expect(restored.body.cards).toHaveLength(1);
  });

  it("không xóa được cột còn thẻ", async () => {
    const u = await registerUser();
    const snap = await createBoard(u);
    const col = snap.columns[0]!.id;
    await u.post(`/api/columns/${col}/cards`, { title: "Còn đây" }).expect(201);
    const res = await u.del(`/api/columns/${col}`).expect(409);
    expect(res.body.error.code).toBe("column_not_empty");
    await u.del(`/api/columns/${snap.columns[1]!.id}`).expect(204);
  });
});

describe("phân quyền", () => {
  it("viewer xem được nhưng không sửa được", async () => {
    const owner = await registerUser();
    const viewer = await registerUser();
    await addMember(owner, viewer, "viewer");
    const snap = await createBoard(owner);
    await viewer.get(`/api/boards/${snap.board.id}`).expect(200);
    await viewer.post(`/api/columns/${snap.columns[0]!.id}/cards`, { title: "Không được" }).expect(403);
    await viewer.post(`/api/workspaces/${owner.workspaceId}/boards`, { title: "Không được" }).expect(403);
  });

  it("chỉ chủ nhóm mới xóa được bảng", async () => {
    const owner = await registerUser();
    const editor = await registerUser();
    await addMember(owner, editor, "editor");
    const snap = await createBoard(owner);
    await editor.del(`/api/boards/${snap.board.id}`).expect(403);
    await owner.del(`/api/boards/${snap.board.id}`).expect(204);
  });

  it("người ngoài nhóm không đọc, không sửa được thẻ dù biết id (IDOR)", async () => {
    const owner = await registerUser();
    const attacker = await registerUser();
    const snap = await createBoard(owner);
    const card = (await owner.post(`/api/columns/${snap.columns[0]!.id}/cards`, { title: "Bí mật" }).expect(201))
      .body as Card;

    await attacker.get(`/api/boards/${snap.board.id}`).expect(404);
    await attacker.patch(`/api/cards/${card.id}`, { title: "Hack" }).expect(404);
    await attacker.del(`/api/cards/${card.id}`).expect(404);
    await attacker.post(`/api/columns/${snap.columns[0]!.id}/cards`, { title: "Hack" }).expect(404);
  });

  it("không chuyển được thẻ sang cột của bảng khác (kể cả bảng mình có quyền)", async () => {
    const owner = await registerUser();
    const a = await createBoard(owner, "A");
    const b = await createBoard(owner, "B");
    const card = (await owner.post(`/api/columns/${a.columns[0]!.id}/cards`, { title: "X" }).expect(201)).body as Card;
    await owner.patch(`/api/cards/${card.id}`, { columnId: b.columns[0]!.id }).expect(404);
  });

  it("id sai định dạng trả 404 chứ không làm sập server", async () => {
    const u = await registerUser();
    await u.get("/api/boards/khong-phai-uuid").expect(404);
  });
});
