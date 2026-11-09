import request from "supertest";
import { describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { app, refreshCookieFrom, registerUser } from "./helpers";

describe("đăng ký / đăng nhập", () => {
  it("đăng ký tạo luôn một nhóm mà người đó là chủ", async () => {
    const u = await registerUser("Lan");
    const res = await u.get("/api/workspaces").expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ role: "owner", memberCount: 1 });
  });

  it("không cho đăng ký trùng email (kể cả khác chữ hoa/thường)", async () => {
    const u = await registerUser();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: u.email.toUpperCase(), password: "12345678", displayName: "X" })
      .expect(409);
    expect(res.body.error.code).toBe("email_taken");
  });

  it("đăng nhập sai mật khẩu và sai email trả cùng một lỗi", async () => {
    const u = await registerUser();
    const wrongPass = await request(app).post("/api/auth/login").send({ email: u.email, password: "sai" }).expect(401);
    const wrongEmail = await request(app)
      .post("/api/auth/login")
      .send({ email: "khongco@test.local", password: "sai" })
      .expect(401);
    expect(wrongPass.body.error).toEqual(wrongEmail.body.error);
  });

  it("không lưu mật khẩu dạng gốc", async () => {
    const u = await registerUser();
    const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [u.id]);
    expect(rows[0].password_hash).not.toContain("matkhau");
  });

  it("chặn API khi không có hoặc sai access token", async () => {
    await request(app).get("/api/me").expect(401);
    await request(app).get("/api/me").set("Authorization", "Bearer abc").expect(401);
  });
});

describe("refresh token xoay vòng", () => {
  it("đổi token cũ lấy token mới", async () => {
    const u = await registerUser();
    const res = await request(app).post("/api/auth/refresh").set("Cookie", u.cookie).expect(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(refreshCookieFrom(res)).not.toBe(u.cookie);
  });

  it("dùng lại token cũ sau thời gian ân hạn thì thu hồi cả chuỗi (nghi bị đánh cắp)", async () => {
    const u = await registerUser();
    const first = await request(app).post("/api/auth/refresh").set("Cookie", u.cookie).expect(200);
    const newCookie = refreshCookieFrom(first);
    // Giả lập token cũ đã bị thu hồi từ lâu
    await pool.query("UPDATE refresh_tokens SET revoked_at = now() - interval '1 hour' WHERE revoked_at IS NOT NULL");

    const reuse = await request(app).post("/api/auth/refresh").set("Cookie", u.cookie).expect(401);
    expect(reuse.body.error.code).toBe("reuse_detected");
    // Token mới hợp lệ cũng bị thu hồi theo
    await request(app).post("/api/auth/refresh").set("Cookie", newCookie).expect(401);
  });

  it("hai tab làm mới gần như cùng lúc thì tab chậm hơn được báo thử lại, không bị đăng xuất", async () => {
    const u = await registerUser();
    const first = await request(app).post("/api/auth/refresh").set("Cookie", u.cookie).expect(200);
    const race = await request(app).post("/api/auth/refresh").set("Cookie", u.cookie).expect(401);
    expect(race.body.error.code).toBe("refresh_race");
    await request(app).post("/api/auth/refresh").set("Cookie", refreshCookieFrom(first)).expect(200);
  });

  it("đăng xuất thu hồi refresh token", async () => {
    const u = await registerUser();
    await request(app).post("/api/auth/logout").set("Cookie", u.cookie).expect(204);
    await request(app).post("/api/auth/refresh").set("Cookie", u.cookie).expect(401);
  });
});
