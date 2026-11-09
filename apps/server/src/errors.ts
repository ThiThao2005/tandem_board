import type { ErrorRequestHandler } from "express";
import { z, ZodError, type ZodTypeAny } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Không cho biết tài nguyên có tồn tại hay không với người ngoài nhóm. */
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const forbidden = (message = "You don't have permission to do this") =>
  new HttpError(403, "forbidden", message);
export const unauthorized = (code = "unauthorized", message = "Please sign in") =>
  new HttpError(401, code, message);

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  return schema.parse(data);
}

const uuidSchema = z.string().uuid();
/** Tham số id trên URL sai định dạng thì coi như không tồn tại. */
export function parseId(value: unknown): string {
  const r = uuidSchema.safeParse(value);
  if (!r.success) throw notFound();
  return r.data;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: "invalid_input", message: err.issues[0]?.message ?? "Invalid input", details: err.issues },
    });
    return;
  }
  // Lỗi JSON hỏng hoặc body quá lớn từ express.json()
  if (typeof err?.status === "number" && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: { code: "bad_request", message: "Bad request" } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: "internal", message: "Internal server error" } });
};
