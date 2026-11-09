import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config";

// Kiểu DATE (oid 1082) mặc định bị đổi thành Date theo múi giờ máy chủ,
// dễ lệch một ngày. Giữ nguyên chuỗi 'YYYY-MM-DD'.
pg.types.setTypeParser(1082, (v) => v);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLocalDatabase(url: string): boolean {
  return LOCAL_HOSTS.has(new URL(url).hostname);
}

/**
 * DB trên máy (Docker) thì không cần SSL. DB từ xa (Supabase…) thì bắt buộc SSL:
 * - có DATABASE_CA_FILE: mã hóa + xác minh chứng chỉ server (an toàn nhất);
 * - không có: vẫn mã hóa đường truyền nhưng không xác minh chứng chỉ.
 * Lưu ý: đừng thêm ?sslmode=... vào DATABASE_URL, vì pg sẽ ưu tiên tham số đó và bỏ qua cấu hình ở đây.
 */
function sslConfig(url: string): pg.PoolConfig["ssl"] {
  if (isLocalDatabase(url)) return undefined;
  if (config.databaseCaFile) {
    const serverDir = fileURLToPath(new URL("..", import.meta.url));
    const file = isAbsolute(config.databaseCaFile) ? config.databaseCaFile : resolve(serverDir, config.databaseCaFile);
    return { ca: readFileSync(file, "utf8") };
  }
  return { rejectUnauthorized: false };
}

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: sslConfig(config.databaseUrl),
  max: config.databasePoolMax,
});

/** Pool hoặc một client đang trong transaction. */
export type Db = pg.Pool | pg.PoolClient;

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Mã lỗi Postgres khi vi phạm ràng buộc UNIQUE. */
export const UNIQUE_VIOLATION = "23505";

export function isPgError(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === code;
}
