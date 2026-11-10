import { z } from "zod";
import type { NoteSummary } from "./notes";

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

/** Các trường sửa được của thẻ. Tách khỏi phần refine để thao tác card.update dùng lại được. */
export const cardUpdateFields = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  dueDate: isoDate.nullable().optional(),
  assigneeId: uuid.nullable().optional(),
  columnId: uuid.optional(),
  /**
   * Phiên bản thẻ mà client đang thấy khi sửa. Chỉ báo xung đột nếu CHÍNH trường đang sửa đã bị
   * người khác sửa sau phiên bản này; sửa trường khác hay kéo thẻ thì không tính là xung đột.
   */
  baseVersion: z.number().int().positive().optional(),
});

export const hasCardChange = (v: z.infer<typeof cardUpdateFields>) =>
  v.title !== undefined || v.dueDate !== undefined || v.assigneeId !== undefined || v.columnId !== undefined;

export const cardUpdateInput = cardUpdateFields.refine(hasCardChange, { message: "Nothing to update" });
export type CardUpdateInput = z.infer<typeof cardUpdateInput>;

/**
 * Kéo thẻ: client gửi Ý ĐỊNH (nằm sau thẻ nào / trước thẻ nào), không gửi vị trí.
 * Server tự tính vị trí từ hàng xóm hiện tại, nên nếu hàng xóm đã bị người khác
 * dời đi hay xóa thì vẫn đặt được thẻ vào chỗ hợp lý thay vì báo lỗi.
 */
export const cardMoveInput = z.object({
  columnId: uuid,
  /** Thẻ nằm ngay phía trên chỗ thả; null = thả lên đầu cột. */
  afterCardId: uuid.nullable().default(null),
  /** Thẻ nằm ngay phía dưới chỗ thả; null = thả xuống cuối cột. */
  beforeCardId: uuid.nullable().default(null),
});
export type CardMoveInput = z.input<typeof cardMoveInput>;

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
  /** Tóm tắt ghi chú (tuần 5): có chữ không, tiến độ checklist. null = chưa có ghi chú. */
  note: NoteSummary | null;
}

export interface CardMoveResult {
  card: Card;
  /** Cột bị sắp xếp lại vì vị trí quá dài: vị trí mới của mọi thẻ trong cột. Rỗng nếu không. */
  rebalanced: { id: string; position: string }[];
}

/** Ảnh chụp toàn bộ bảng. */
export interface BoardSnapshot {
  /** seq của thao tác cuối cùng đã có trong ảnh chụp. Client nhận tiếp từ seq + 1. */
  seq: number;
  board: Board;
  role: Role;
  columns: Column[];
  cards: Card[];
  members: Member[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
