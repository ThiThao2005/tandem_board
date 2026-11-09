import { describe, expect, it } from "vitest";
import { addMember, registerUser } from "./helpers";

describe("nhóm và lời mời", () => {
  it("mời bằng link: người được mời vào nhóm với đúng vai trò", async () => {
    const owner = await registerUser("Chủ");
    const lan = await registerUser("Lan");
    const inv = await owner.post(`/api/workspaces/${owner.workspaceId}/invitations`, { role: "editor" }).expect(201);

    const preview = await lan.get(`/api/invitations/token/${inv.body.token}`).expect(200);
    expect(preview.body).toMatchObject({ role: "editor", alreadyMember: false });

    await lan.post(`/api/invitations/token/${inv.body.token}/accept`).expect(200);
    const detail = await lan.get(`/api/workspaces/${owner.workspaceId}`).expect(200);
    expect(detail.body.role).toBe("editor");
    expect(detail.body.members).toHaveLength(2);
  });

  it("chỉ chủ nhóm mới tạo được lời mời", async () => {
    const owner = await registerUser();
    const editor = await registerUser();
    await addMember(owner, editor, "editor");
    await editor.post(`/api/workspaces/${owner.workspaceId}/invitations`, { role: "editor" }).expect(403);
  });

  it("lời mời có email chỉ dành cho đúng người đó", async () => {
    const owner = await registerUser();
    const lan = await registerUser();
    const other = await registerUser();
    const inv = await owner
      .post(`/api/workspaces/${owner.workspaceId}/invitations`, { role: "viewer", email: lan.email })
      .expect(201);
    await other.post(`/api/invitations/token/${inv.body.token}/accept`).expect(403);
    await lan.post(`/api/invitations/token/${inv.body.token}/accept`).expect(200);
  });

  it("lời mời bị thu hồi thì không dùng được", async () => {
    const owner = await registerUser();
    const lan = await registerUser();
    const inv = await owner.post(`/api/workspaces/${owner.workspaceId}/invitations`, { role: "editor" }).expect(201);
    await owner.del(`/api/invitations/${inv.body.invitation.id}`).expect(204);
    const res = await lan.post(`/api/invitations/token/${inv.body.token}/accept`).expect(404);
    expect(res.body.error.code).toBe("invitation_invalid");
  });

  it("chấp nhận lại lời mời không hạ quyền của chủ nhóm", async () => {
    const owner = await registerUser();
    const inv = await owner.post(`/api/workspaces/${owner.workspaceId}/invitations`, { role: "viewer" }).expect(201);
    await owner.post(`/api/invitations/token/${inv.body.token}/accept`).expect(200);
    const detail = await owner.get(`/api/workspaces/${owner.workspaceId}`).expect(200);
    expect(detail.body.role).toBe("owner");
  });

  it("người ngoài nhóm nhận 404, không biết nhóm có tồn tại", async () => {
    const owner = await registerUser();
    const stranger = await registerUser();
    await stranger.get(`/api/workspaces/${owner.workspaceId}`).expect(404);
  });

  it("nhóm phải luôn còn ít nhất một chủ nhóm", async () => {
    const owner = await registerUser();
    const res = await owner.del(`/api/workspaces/${owner.workspaceId}/members/${owner.id}`).expect(409);
    expect(res.body.error.code).toBe("last_owner");
    await owner.patch(`/api/workspaces/${owner.workspaceId}/members/${owner.id}`, { role: "editor" }).expect(409);
  });

  it("thành viên tự rời nhóm được, nhưng không xóa được người khác", async () => {
    const owner = await registerUser();
    const a = await registerUser();
    const b = await registerUser();
    await addMember(owner, a, "editor");
    await addMember(owner, b, "editor");
    await a.del(`/api/workspaces/${owner.workspaceId}/members/${b.id}`).expect(403);
    await a.del(`/api/workspaces/${owner.workspaceId}/members/${a.id}`).expect(204);
    await a.get(`/api/workspaces/${owner.workspaceId}`).expect(404);
  });
});
