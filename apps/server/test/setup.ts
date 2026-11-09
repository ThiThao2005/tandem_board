import { afterAll, beforeEach } from "vitest";
import { pool } from "../src/db";

beforeEach(async () => {
  await pool.query("TRUNCATE users, workspaces, refresh_tokens RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});
