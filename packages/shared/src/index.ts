import { z } from "zod";

// ---------- Vai trò ----------

export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Thứ hạng quyền: số càng lớn càng nhiều quyền. */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
};

// ---------- Dữ liệu đầu vào (dùng chung cho server kiểm tra và web gửi lên) ----------

const email = z.string().trim().toLowerCase().email("Invalid email address").max(254);
const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

export const registerInput = z.object({
  email,
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  displayName: z.string().trim().min(1, "Please enter a display name").max(60),
});
export type RegisterInput = z.infer<typeof registerInput>;

export const loginInput = z.object({
  email,
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginInput>;

export const workspaceInput = z.object({
  name: z.string().trim().min(1, "Please enter a workspace name").max(80),
});

export const inviteInput = z.object({
  role: z.enum(["editor", "viewer"]),
  email: email.optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});
export type InviteInput = z.input<typeof inviteInput>;

export const memberRoleInput = z.object({ role: z.enum(ROLES) });

export const boardInput = z.object({
  title: z.string().trim().min(1, "Please enter a board name").max(120),
});

export const columnCreateInput = z.object({
  /** Client được tự sinh UUID (chuẩn bị cho chế độ offline ở tuần 6). */
  id: uuid.optional(),
  title: z.string().trim().min(1, "Please enter a column name").max(80),
});

export const columnUpdateInput = z.object({
  title: z.string().trim().min(1).max(80),
});

export const cardCreateInput = z.object({
  id: uuid.optional(),
  title: z.string().trim().min(1, "Please enter a card title").max(500),
});

export const cardUpdateInput = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    dueDate: isoDate.nullable().optional(),
    assigneeId: uuid.nullable().optional(),
    columnId: uuid.optional(),
    /** Phiên bản thẻ mà client đang thấy. Lệch với server thì báo xung đột. */
    baseVersion: z.number().int().positive().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.dueDate !== undefined ||
      v.assigneeId !== undefined ||
      v.columnId !== undefined,
    { message: "Nothing to update" },
  );
export type CardUpdateInput = z.infer<typeof cardUpdateInput>;

// ---------- Dữ liệu trả về ----------

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarColor: string;
}

export interface AuthResult {
  accessToken: string;
  user: User;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
  memberCount: number;
}

export interface Member {
  id: string;
  email: string;
  displayName: string;
  avatarColor: string;
  role: Role;
}

export interface WorkspaceDetail {
  workspace: { id: string; name: string };
  role: Role;
  members: Member[];
}

export interface Invitation {
  id: string;
  role: Role;
  email: string | null;
  expiresAt: string;
}

export interface InvitationPreview {
  workspaceId: string;
  workspaceName: string;
  role: Role;
  invitedBy: string | null;
  expiresAt: string;
  alreadyMember: boolean;
}

export interface Board {
  id: string;
  workspaceId: string;
  title: string;
}

export interface Column {
  id: string;
  boardId: string;
  title: string;
  position: string;
}

export interface Card {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  dueDate: string | null;
  assigneeId: string | null;
  position: string;
  version: number;
  deletedAt: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

/** Ảnh chụp toàn bộ bảng. */
export interface BoardSnapshot {
  board: Board;
  role: Role;
  columns: Column[];
  cards: Card[];
  members: Member[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
