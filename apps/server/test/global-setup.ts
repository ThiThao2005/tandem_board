import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "../src/migrate";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Chạy một lần trước toàn bộ test: xóa sạch DB test rồi chạy lại migration. */
export default async function setup() {
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing TEST_DATABASE_URL");

  // Chốt chặn: test XÓA SẠCH schema public. Không bao giờ chạy vào DB từ xa (Supabase…).
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && process.env.ALLOW_REMOTE_TEST_DB !== "yes") {
    throw new Error(
      `TEST_DATABASE_URL trỏ tới ${host}, không phải máy local. Test sẽ xóa sạch database đó nên đã dừng lại. ` +
        `Hãy dùng Postgres trong Docker (npm run db:up).`,
    );
  }

  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
