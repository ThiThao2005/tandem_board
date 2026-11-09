import { loginInput, registerInput, type AuthResult, type User } from "@tandem/shared";
import bcrypt from "bcryptjs";
import { Router, type CookieOptions, type Response } from "express";
import { config } from "../config";
import { isPgError, pool, UNIQUE_VIOLATION, withTx } from "../db";
import { HttpError, parse, unauthorized } from "../errors";
import { issueRefreshToken, revokeRefreshFamily, rotateRefreshToken, signAccessToken } from "./tokens";

export const REFRESH_COOKIE = "tandem_rt";

const cookieOptions: CookieOptions = {
  httpOnly: true, // JavaScript trên trang không đọc được → chống XSS lấy token
  sameSite: "lax",
  secure: config.isProd,
  path: "/api/auth", // chỉ gửi kèm khi gọi các route xác thực
  maxAge: config.refreshTokenDays * 24 * 60 * 60 * 1000,
};

// Tông màu tự nhiên, đủ đậm để chữ trắng đọc rõ.
const AVATAR_COLORS = ["#3f6b4f", "#c0623f", "#4f7f99", "#a6741f", "#7a5c8e", "#5d7a35", "#9c4f3a", "#4a7d7a"];
function avatarColorFor(email: string): string {
  let h = 0;
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export const USER_COLS = `id, email, display_name AS "displayName", avatar_color AS "avatarColor"`;

// Hash giả để so sánh khi email không tồn tại, giúp thời gian phản hồi giống nhau.
const DUMMY_HASH = bcrypt.hashSync("tandem-dummy-password", 10);

function sendAuth(res: Response, status: number, user: User, refreshToken: string) {
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions);
  const body: AuthResult = { accessToken: signAccessToken(user.id), user };
  res.status(status).json(body);
}

export const authRouter = Router();

authRouter.post("/register", async (req, res) => {
  const input = parse(registerInput, req.body);
  const passwordHash = await bcrypt.hash(input.password, 10);
  try {
    const { user, refreshToken } = await withTx(async (c) => {
      const { rows } = await c.query<User>(
        `INSERT INTO users (email, password_hash, display_name, avatar_color)
         VALUES ($1, $2, $3, $4) RETURNING ${USER_COLS}`,
        [input.email, passwordHash, input.displayName, avatarColorFor(input.email)],
      );
      const user = rows[0]!;
      // Mỗi người mới có sẵn một không gian nhóm của riêng mình.
      const ws = await c.query<{ id: string }>(
        "INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id",
        [`${input.displayName}'s workspace`.slice(0, 80), user.id],
      );
      await c.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [
        ws.rows[0]!.id,
        user.id,
      ]);
      return { user, refreshToken: await issueRefreshToken(c, user.id) };
    });
    sendAuth(res, 201, user, refreshToken);
  } catch (err) {
    if (isPgError(err, UNIQUE_VIOLATION)) throw new HttpError(409, "email_taken", "This email is already registered");
    throw err;
  }
});

authRouter.post("/login", async (req, res) => {
  const input = parse(loginInput, req.body);
  const { rows } = await pool.query<User & { passwordHash: string }>(
    `SELECT ${USER_COLS}, password_hash AS "passwordHash" FROM users WHERE email = $1`,
    [input.email],
  );
  const row = rows[0];
  const ok = await bcrypt.compare(input.password, row?.passwordHash ?? DUMMY_HASH);
  if (!row || !ok) throw unauthorized("invalid_credentials", "Incorrect email or password");
  const { passwordHash: _, ...user } = row;
  sendAuth(res, 200, user, await issueRefreshToken(pool, user.id));
});

authRouter.post("/refresh", async (req, res) => {
  const raw: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof raw !== "string" || !raw) throw unauthorized("no_session", "Not signed in");
  try {
    const { userId, raw: next } = await rotateRefreshToken(raw);
    const { rows } = await pool.query<User>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [userId]);
    if (!rows[0]) throw unauthorized();
    sendAuth(res, 200, rows[0], next);
  } catch (err) {
    // Phiên chết hẳn thì xóa cookie; refresh_race thì giữ, vì tab kia đã ghi cookie mới.
    if (err instanceof HttpError && err.code !== "refresh_race") res.clearCookie(REFRESH_COOKIE, cookieOptions);
    throw err;
  }
});

authRouter.post("/logout", async (req, res) => {
  const raw: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof raw === "string" && raw) await revokeRefreshFamily(raw);
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
  res.status(204).end();
});
