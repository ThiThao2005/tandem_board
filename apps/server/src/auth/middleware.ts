import type { Request, RequestHandler } from "express";
import { unauthorized } from "../errors";
import { verifyAccessToken } from "./tokens";

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized();
  req.userId = verifyAccessToken(header.slice("Bearer ".length));
  next();
};

/** Lấy userId của người đang gọi (chỉ dùng trong route đã qua requireAuth). */
export function uid(req: Request): string {
  if (!req.userId) throw unauthorized();
  return req.userId;
}
