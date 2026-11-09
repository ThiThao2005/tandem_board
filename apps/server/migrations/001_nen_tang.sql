-- Tuần 1: người dùng, nhóm, lời mời, bảng → cột → thẻ.
-- Bảng operations, labels, comments, card_notes sẽ thêm ở các migration sau.

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,            -- luôn lưu chữ thường
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_color  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refresh token: chỉ lưu SHA-256, không lưu chuỗi gốc.
-- family_id gom các token sinh ra từ cùng một lần đăng nhập, để khi phát hiện
-- token cũ bị dùng lại (dấu hiệu bị đánh cắp) thì thu hồi cả chuỗi.
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   UUID NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TYPE workspace_role AS ENUM ('owner', 'editor', 'viewer');

CREATE TABLE workspaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         workspace_role NOT NULL,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

-- Link mời: dùng nhiều lần cho tới khi hết hạn hoặc bị thu hồi.
-- Có email thì chỉ đúng người đó chấp nhận được.
CREATE TABLE invitations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  role         workspace_role NOT NULL CHECK (role <> 'owner'),
  email        TEXT,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invitations_workspace_idx ON invitations (workspace_id);

CREATE TABLE boards (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX boards_workspace_idx ON boards (workspace_id);

-- position dùng COLLATE "C": so sánh theo byte, đúng thứ tự của fractional indexing.
-- Nếu để collation theo ngôn ngữ, "a0V" và "a0v" có thể bị xếp sai.
CREATE TABLE columns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id    UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  position    TEXT COLLATE "C" NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX columns_board_idx ON columns (board_id, position);

-- board_id được lưu lặp lại trên thẻ để kiểm tra quyền và tải cả bảng bằng một truy vấn.
-- Thẻ chỉ được chuyển giữa các cột cùng một bảng, nên board_id không bao giờ đổi.
CREATE TABLE cards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id    UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  column_id   UUID NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  due_date    DATE,
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  position    TEXT COLLATE "C" NOT NULL,
  version     INT NOT NULL DEFAULT 1,
  deleted_at  TIMESTAMPTZ,                      -- xóa mềm
  deleted_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cards_column_idx ON cards (column_id, position) WHERE deleted_at IS NULL;
CREATE INDEX cards_board_idx ON cards (board_id);
