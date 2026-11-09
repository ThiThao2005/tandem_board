import type { AuthResult, BoardSnapshot, WorkspaceSummary } from "@tandem/shared";
import request from "supertest";
import { createApp } from "../src/app";

export const app = createApp();

export interface TestUser {
  token: string;
  id: string;
  email: string;
  /** Cookie refresh token, dạng "tandem_rt=...". */
  cookie: string;
  workspaceId: string;
  /** Gọi API kèm access token của người này. */
  get: (url: string) => request.Test;
  post: (url: string, body?: object) => request.Test;
  patch: (url: string, body?: object) => request.Test;
  del: (url: string) => request.Test;
}

let counter = 0;

export function refreshCookieFrom(res: request.Response): string {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith("tandem_rt="));
  if (!cookie) throw new Error("Không thấy cookie tandem_rt");
  return cookie.split(";")[0]!;
}

export async function registerUser(name = "Người dùng"): Promise<TestUser> {
  counter += 1;
  const email = `user${counter}@test.local`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "matkhau-thu-nghiem", displayName: `${name} ${counter}` })
    .expect(201);
  const body = res.body as AuthResult;
  const auth = `Bearer ${body.accessToken}`;
  const workspaces = await request(app).get("/api/workspaces").set("Authorization", auth).expect(200);
  return {
    token: body.accessToken,
    id: body.user.id,
    email,
    cookie: refreshCookieFrom(res),
    workspaceId: (workspaces.body as WorkspaceSummary[])[0]!.id,
    get: (url) => request(app).get(url).set("Authorization", auth),
    post: (url, body) => request(app).post(url).set("Authorization", auth).send(body),
    patch: (url, body) => request(app).patch(url).set("Authorization", auth).send(body),
    del: (url) => request(app).delete(url).set("Authorization", auth),
  };
}

/** Tạo bảng trong workspace mặc định của user, trả về ảnh chụp bảng. */
export async function createBoard(user: TestUser, title = "Bảng thử"): Promise<BoardSnapshot> {
  const res = await user.post(`/api/workspaces/${user.workspaceId}/boards`, { title }).expect(201);
  const snap = await user.get(`/api/boards/${res.body.id}`).expect(200);
  return snap.body as BoardSnapshot;
}

/** Mời rồi cho người kia chấp nhận. */
export async function addMember(owner: TestUser, member: TestUser, role: "editor" | "viewer") {
  const inv = await owner.post(`/api/workspaces/${owner.workspaceId}/invitations`, { role }).expect(201);
  await member.post(`/api/invitations/token/${inv.body.token}/accept`).expect(200);
}
