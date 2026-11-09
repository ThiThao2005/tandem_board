import type { User } from "@tandem/shared";
import cookieParser from "cookie-parser";
import express, { Router } from "express";
import { requireAuth, uid } from "./auth/middleware";
import { authRouter, USER_COLS } from "./auth/routes";
import { pool } from "./db";
import { errorHandler, notFound } from "./errors";
import { boardsRouter } from "./routes/boards";
import { workspacesRouter } from "./routes/workspaces";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/auth", authRouter);

  // Mọi route bên dưới đều cần access token.
  const api = Router();
  api.use(requireAuth);
  api.get("/me", async (req, res) => {
    const { rows } = await pool.query<User>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [uid(req)]);
    if (!rows[0]) throw notFound();
    res.json(rows[0]);
  });
  api.use(workspacesRouter);
  api.use(boardsRouter);
  api.use(() => {
    throw notFound("No such API endpoint");
  });
  app.use("/api", api);

  app.use(errorHandler);
  return app;
}
