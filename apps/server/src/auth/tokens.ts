import { createHash, randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { withTx, type Db } from "../db";
import { unauthorized } from "../errors";

export function signAccessToken(userId: string): string {
  return jwt.sign({}, config.jwtSecret, { subject: userId, expiresIn: config.accessTokenTtl });
}

/** Trả về userId, hoặc ném lỗi 401 (code token_expired nếu chỉ là hết hạn). */
export function verifyAccessToken(token: string): string {
  return verifyAccessTokenClaims(token).userId;
}

/** Như verifyAccessToken, kèm thời điểm hết hạn (giây) để socket tự ngắt khi token hết hạn. */
export function verifyAccessTokenClaims(token: unknown): { userId: string; exp: number } {
  if (typeof token !== "string" || !token) throw unauthorized();
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
    if (typeof payload === "string" || !payload.sub || typeof payload.exp !== "number") throw unauthorized();
    return { userId: payload.sub, exp: payload.exp };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw unauthorized("token_expired", "Your session has expired");
    throw unauthorized();
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");

export async function issueRefreshToken(db: Db, userId: string, familyId: string = randomUUID()) {
  const raw = randomToken();
  await db.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [userId, familyId, sha256(raw), config.refreshTokenDays],
  );
  return raw;
}

type RotateResult =
  | { ok: true; userId: string; raw: string }
  | { ok: false; code: "invalid" | "expired" | "refresh_race" | "reuse_detected" };

/**
 * Đổi refresh token cũ lấy token mới (rotation).
 * - Token đã bị thu hồi mà vẫn được dùng lại → có thể đã bị đánh cắp → thu hồi cả family.
 * - Ngoại lệ (thời gian ân hạn, refreshGraceSeconds): token vừa bị XOAY VÒNG trong vài giây, và family
 *   vẫn còn token đang hiệu lực → cấp thêm một token mới trong cùng family thay vì từ chối. Hai trường hợp
 *   thật hay gặp:
 *     · hai tab cùng làm mới gần như cùng lúc;
 *     · tải lại trang đúng lúc /auth/refresh đang chạy: server đã xoay token nhưng trình duyệt hủy request
 *       nên không nhận được cookie mới, lần sau vẫn gửi token cũ. (Trước đây trả 401 "refresh_race", thử
 *       lại cũng vẫn là token cũ đó → bị đăng xuất; với DB ở xa mỗi lần làm mới ~1,5 s nên gặp thường xuyên.)
 *   Giống "reuse interval" của Auth0. Đánh đổi: token bị lộ mà kẻ gian dùng trong vài giây sau lần xoay vòng
 *   thì cũng được cấp token — quá thời gian ân hạn thì vẫn bị coi là đánh cắp như cũ.
 * - Family đã bị thu hồi hết (đăng xuất, phát hiện dùng lại) thì không có ân hạn: phiên đã kết thúc.
 */
export async function rotateRefreshToken(raw: string): Promise<{ userId: string; raw: string }> {
  // Transaction phải COMMIT việc thu hồi family trước, rồi mới ném lỗi, nên trả kết quả ra ngoài.
  const result = await withTx<RotateResult>(async (c) => {
    const { rows } = await c.query<{
      id: string;
      user_id: string;
      family_id: string;
      revoked: boolean;
      in_grace: boolean;
      expired: boolean;
    }>(
      `SELECT id, user_id, family_id,
              revoked_at IS NOT NULL AS revoked,
              revoked_at > now() - make_interval(secs => $2) AS in_grace,
              expires_at < now() AS expired
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [sha256(raw), config.refreshGraceSeconds],
    );
    const row = rows[0];
    if (!row) return { ok: false, code: "invalid" };
    if (row.revoked) {
      if (row.in_grace) {
        // Chỉ khi token này bị thu hồi do XOAY VÒNG (family còn token đang hiệu lực), không phải do đăng xuất.
        const live = await c.query(
          "SELECT 1 FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1",
          [row.family_id],
        );
        if (live.rowCount === 0) return { ok: false, code: "invalid" };
        const next = await issueRefreshToken(c, row.user_id, row.family_id);
        return { ok: true, userId: row.user_id, raw: next };
      }
      await c.query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL",
        [row.family_id],
      );
      return { ok: false, code: "reuse_detected" };
    }
    if (row.expired) return { ok: false, code: "expired" };

    await c.query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1", [row.id]);
    const next = await issueRefreshToken(c, row.user_id, row.family_id);
    return { ok: true, userId: row.user_id, raw: next };
  });

  if (!result.ok) {
    const message =
      result.code === "refresh_race" ? "Session is being refreshed in another tab, please retry" : "Your session is no longer valid";
    throw unauthorized(result.code, message);
  }
  return result;
}

export async function revokeRefreshFamily(raw: string) {
  await withTx(async (c) => {
    await c.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)
          AND revoked_at IS NULL`,
      [sha256(raw)],
    );
  });
}
