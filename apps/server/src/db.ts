import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config";
import { HttpError } from "./errors";

// Kiểu DATE (oid 1082) mặc định bị đổi thành Date theo múi giờ máy chủ,
// dễ lệch một ngày. Giữ nguyên chuỗi 'YYYY-MM-DD'.
pg.types.setTypeParser(1082, (v) => v);
// BIGINT (oid 20) mặc định trả về chuỗi. Chỉ dùng cho seq của thao tác, còn rất xa 2^53, nên đổi thành số.
pg.types.setTypeParser(20, (v) => Number(v));

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

/** Mã lỗi Postgres khi vi phạm ràng buộc UNIQUE. */
export const UNIQUE_VIOLATION = "23505";
const DEADLOCK_DETECTED = "40P01";
const SERIALIZATION_FAILURE = "40001";

/**
 * Ném ra bên trong transaction khi dữ liệu vừa đọc đã bị người khác đổi trong lúc chờ khóa
 * (vd. thẻ vừa bị chuyển sang cột khác). withTx sẽ rollback rồi chạy lại từ đầu.
 */
export class RetryTransaction extends Error {}

/** Số lần chạy lại tối đa khi gặp deadlock hoặc RetryTransaction. */
const TX_RETRIES = 3;

async function runTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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

/**
 * Chạy fn trong một transaction. Gặp deadlock (Postgres tự hủy một bên) hoặc RetryTransaction
 * thì rollback, chờ một khoảng ngẫu nhiên rồi chạy lại cả transaction. Vì vậy fn không được
 * có tác dụng phụ bên ngoài DB (gửi mail, phát WebSocket…) — những việc đó làm SAU khi withTx xong.
 */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runTx(fn);
    } catch (err) {
      const retryable =
        err instanceof RetryTransaction || isPgError(err, DEADLOCK_DETECTED) || isPgError(err, SERIALIZATION_FAILURE);
      if (!retryable) throw err;
      if (attempt >= TX_RETRIES) {
        throw new HttpError(409, "busy", "Someone else is changing this right now. Please try again");
      }
      // Chờ ngẫu nhiên để hai bên không đụng nhau lần nữa ở đúng cùng thời điểm.
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * (attempt + 1)));
    }
  }
}

/**
 * Đọc nhiều truy vấn trên CÙNG MỘT ảnh chụp dữ liệu (REPEATABLE READ): mọi câu SELECT thấy DB như ở
 * thời điểm câu đầu tiên chạy. Dùng cho ảnh chụp bảng, để `seq` khớp đúng với cột/thẻ đọc ra — nếu đọc
 * bằng nhiều kết nối riêng rẽ, một thao tác commit xen giữa sẽ làm thẻ đã đổi mà seq vẫn cũ (hoặc ngược lại).
 */
export async function withReadSnapshot<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
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

export function isPgError(err: unknown, code: string, constraint?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === code && (constraint === undefined || e.constraint === constraint);
}
