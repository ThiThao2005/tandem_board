import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see apps/server/.env.example)`);
  return value;
}

const isTest = Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";

export const config = {
  isTest,
  isProd: process.env.NODE_ENV === "production",
  databaseUrl: isTest ? required("TEST_DATABASE_URL") : required("DATABASE_URL"),
  /** File chứng chỉ CA của nhà cung cấp DB (Supabase: Settings → Database → SSL). Có thì xác minh chứng chỉ server. */
  databaseCaFile: process.env.DATABASE_CA_FILE || null,
  /** Supabase gói Free giới hạn số kết nối, nên để pool nhỏ. */
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX ?? 10),
  jwtSecret: required("JWT_SECRET"),
  port: Number(process.env.PORT ?? 4000),
  accessTokenTtl: "15m",
  refreshTokenDays: 30,
  /** Hai tab cùng làm mới token trong khoảng này thì không bị coi là đánh cắp token. */
  refreshGraceSeconds: 10,
} as const;
