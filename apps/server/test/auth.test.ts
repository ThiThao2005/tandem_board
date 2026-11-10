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

  it("hai tab làm mới gần như cùng lúc: tab chậm hơn cũng nhận token mới, không bị đăng xuất", async () => {
    const u = await registerUser();
    const first = await request(app).post("/api/auth/refresh").set("Cookie", u.cookie).expect(200);
    const second = await request(app).post("/api/auth/refresh").set("Cookie", u.cookie).expect(200);
    // Cả hai token mới đều dùng được.
    await request(app).post("/api/auth/refresh").set("Cookie", refreshCookieFrom(first)).expect(200);
    await request(app).post("/api/auth/refresh").set("Cookie", refreshCookieFrom(second)).expect(200);
  });

  // Lỗi tìm ra ở tuần 5 (NOTES): tải lại trang đúng lúc /auth/refresh đang chạy → server đã xoay token nhưng
  // trình duyệt không nhận cookie mới → lần sau gửi token cũ → trước đây 401 rồi bị đăng xuất.
  it("tải lại trang giữa lúc làm mới (không nhận được cookie mới): token cũ vẫn dùng được trong thời gian ân hạn", async () => {
    const u = await registerUser();
    await request(app).post("/api/auth/refresh").set("Cookie", u.cookie).expect(200); // cookie mới bị mất
    const retry = await request(app).post("/api/auth/refresh").set("Cookie", u.cookie).expect(200);
    expect(retry.body.accessToken).toBeTruthy();
    await request(app).post("/api/auth/refresh").set("Cookie", refreshCookieFrom(retry)).expect(200);
  });

  it("đăng xuất thu hồi refresh token, kể cả token vừa bị xoay vòng trong thời gian ân hạn", async () => {
    const u = await registerUser();
    const next = await request(app).post("/api/auth/refresh").set("Cookie", u.cookie).expect(200);
    await request(app).post("/api/auth/logout").set("Cookie", refreshCookieFrom(next)).expect(204);
    await request(app).post("/api/auth/refresh").set("Cookie", refreshCookieFrom(next)).expect(401);
    // Token cũ vừa bị xoay vòng vài giây trước: phiên đã đăng xuất nên không được ân hạn.
    await request(app).post("/api/auth/refresh").set("Cookie", u.cookie).expect(401);
  });
});
