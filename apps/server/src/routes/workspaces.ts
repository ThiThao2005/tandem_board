import {
  inviteInput,
  memberRoleInput,
  workspaceInput,
  type Invitation,
  type InvitationPreview,
  type Member,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from "@tandem/shared";
import { Router } from "express";
import { requireWorkspace } from "../access";
import { uid } from "../auth/middleware";
import { randomToken, sha256 } from "../auth/tokens";
import { pool, withTx, type Db } from "../db";
import { forbidden, HttpError, notFound, parse, parseId } from "../errors";

export const workspacesRouter = Router();

export async function listMembers(db: Db, workspaceId: string): Promise<Member[]> {
  const { rows } = await db.query<Member>(
    `SELECT u.id, u.email, u.display_name AS "displayName", u.avatar_color AS "avatarColor", m.role
       FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1
      ORDER BY (m.role = 'owner') DESC, m.joined_at`,
    [workspaceId],
  );
  return rows;
}

workspacesRouter.get("/workspaces", async (req, res) => {
  const { rows } = await pool.query<WorkspaceSummary>(
    `SELECT w.id, w.name, m.role,
            (SELECT count(*) FROM workspace_members x WHERE x.workspace_id = w.id)::int AS "memberCount"
       FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = $1
      ORDER BY w.created_at`,
    [uid(req)],
  );
  res.json(rows);
});

workspacesRouter.post("/workspaces", async (req, res) => {
  const { name } = parse(workspaceInput, req.body);
  const ws = await withTx(async (c) => {
    const { rows } = await c.query<{ id: string; name: string }>(
      "INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id, name",
      [name, uid(req)],
    );
    await c.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [
      rows[0]!.id,
      uid(req),
    ]);
    return rows[0]!;
  });
  res.status(201).json({ ...ws, role: "owner", memberCount: 1 } satisfies WorkspaceSummary);
});

workspacesRouter.get("/workspaces/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const role = await requireWorkspace(pool, uid(req), id, "viewer");
  const { rows } = await pool.query<{ id: string; name: string }>("SELECT id, name FROM workspaces WHERE id = $1", [id]);
  res.json({ workspace: rows[0]!, role, members: await listMembers(pool, id) } satisfies WorkspaceDetail);
});

workspacesRouter.patch("/workspaces/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const { name } = parse(workspaceInput, req.body);
  await requireWorkspace(pool, uid(req), id, "owner");
  await pool.query("UPDATE workspaces SET name = $2 WHERE id = $1", [id, name]);
  res.json({ id, name });
});

workspacesRouter.delete("/workspaces/:id", async (req, res) => {
  const id = parseId(req.params.id);
  await requireWorkspace(pool, uid(req), id, "owner");
  await pool.query("DELETE FROM workspaces WHERE id = $1", [id]);
  res.status(204).end();
});

// ---------- Thành viên ----------

/** Khóa danh sách chủ nhóm rồi đếm, để hai yêu cầu song song không cùng gỡ người chủ cuối cùng. */
async function ownerCount(db: Db, workspaceId: string): Promise<number> {
  const { rows } = await db.query(
    "SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' FOR UPDATE",
    [workspaceId],
  );
  return rows.length;
}

const lastOwner = () => new HttpError(409, "last_owner", "A workspace must have at least one owner");

workspacesRouter.patch("/workspaces/:id/members/:userId", async (req, res) => {
  const id = parseId(req.params.id);
  const targetId = parseId(req.params.userId);
  const { role } = parse(memberRoleInput, req.body);
  await withTx(async (c) => {
    await requireWorkspace(c, uid(req), id, "owner");
    const current = await c.query<{ role: string }>(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
      [id, targetId],
    );
    if (!current.rows[0]) throw notFound("This person is not a member of the workspace");
    if (current.rows[0].role === "owner" && role !== "owner" && (await ownerCount(c, id)) <= 1) throw lastOwner();
    await c.query("UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2", [id, targetId, role]);
  });
  res.json({ userId: targetId, role });
});

/** Chủ nhóm xóa người khác, hoặc bất kỳ ai tự rời nhóm. */
workspacesRouter.delete("/workspaces/:id/members/:userId", async (req, res) => {
  const id = parseId(req.params.id);
  const targetId = parseId(req.params.userId);
  const me = uid(req);
  await withTx(async (c) => {
    await requireWorkspace(c, me, id, targetId === me ? "viewer" : "owner");
    const current = await c.query<{ role: string }>(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
      [id, targetId],
    );
    if (!current.rows[0]) throw notFound("This person is not a member of the workspace");
    if (current.rows[0].role === "owner" && (await ownerCount(c, id)) <= 1) throw lastOwner();
    await c.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [id, targetId]);
    // Tuần 3: đá các kết nối realtime của người này ra khỏi phòng của nhóm.
  });
  res.status(204).end();
});

// ---------- Lời mời ----------

const INVITE_COLS = `id, role, email, expires_at AS "expiresAt"`;

workspacesRouter.get("/workspaces/:id/invitations", async (req, res) => {
  const id = parseId(req.params.id);
  await requireWorkspace(pool, uid(req), id, "owner");
  const { rows } = await pool.query<Invitation>(
    `SELECT ${INVITE_COLS} FROM invitations
      WHERE workspace_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`,
    [id],
  );
  res.json(rows);
});

workspacesRouter.post("/workspaces/:id/invitations", async (req, res) => {
  const id = parseId(req.params.id);
  const input = parse(inviteInput, req.body);
  await requireWorkspace(pool, uid(req), id, "owner");
  // Chỉ lưu hash; chuỗi gốc chỉ trả về đúng một lần này.
  const token = randomToken();
  const { rows } = await pool.query<Invitation>(
    `INSERT INTO invitations (workspace_id, token_hash, role, email, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
     RETURNING ${INVITE_COLS}`,
    [id, sha256(token), input.role, input.email ?? null, uid(req), input.expiresInDays],
  );
  res.status(201).json({ invitation: rows[0]!, token });
});

workspacesRouter.delete("/invitations/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query<{ workspaceId: string }>(
    `SELECT workspace_id AS "workspaceId" FROM invitations WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound();
  await requireWorkspace(pool, uid(req), rows[0].workspaceId, "owner");
  await pool.query("UPDATE invitations SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
  res.status(204).end();
});

async function findActiveInvitation(db: Db, token: string) {
  const { rows } = await db.query<{
    workspaceId: string;
    workspaceName: string;
    role: "editor" | "viewer";
    email: string | null;
    invitedBy: string | null;
    expiresAt: string;
  }>(
    `SELECT i.workspace_id AS "workspaceId", w.name AS "workspaceName", i.role, i.email,
            u.display_name AS "invitedBy", i.expires_at AS "expiresAt"
       FROM invitations i
       JOIN workspaces w ON w.id = i.workspace_id
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.token_hash = $1 AND i.revoked_at IS NULL AND i.expires_at > now()`,
    [sha256(token)],
  );
  if (!rows[0]) throw new HttpError(404, "invitation_invalid", "This invitation does not exist or has expired");
  return rows[0];
}

workspacesRouter.get("/invitations/token/:token", async (req, res) => {
  const inv = await findActiveInvitation(pool, req.params.token);
  const member = await pool.query("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [
    inv.workspaceId,
    uid(req),
  ]);
  const preview: InvitationPreview = {
    workspaceId: inv.workspaceId,
    workspaceName: inv.workspaceName,
    role: inv.role,
    invitedBy: inv.invitedBy,
    expiresAt: inv.expiresAt,
    alreadyMember: member.rowCount! > 0,
  };
  res.json(preview);
});

workspacesRouter.post("/invitations/token/:token/accept", async (req, res) => {
  const me = uid(req);
  const inv = await findActiveInvitation(pool, req.params.token);
  if (inv.email) {
    const { rows } = await pool.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [me]);
    if (rows[0]?.email !== inv.email) throw forbidden("This invitation was sent to a different email");
  }
  // Đã là thành viên thì giữ nguyên vai trò cũ (không hạ quyền chủ nhóm xuống).
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [inv.workspaceId, me, inv.role],
  );
  res.json({ workspaceId: inv.workspaceId });
});
