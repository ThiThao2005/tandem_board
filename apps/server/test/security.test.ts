import { describe, expect, it } from "vitest";
import { pool } from "../src/db";

describe("bảo mật database", () => {
  // Nếu sau này thêm bảng mà quên bật RLS, bảng đó sẽ lộ qua REST API của Supabase.
  it("mọi bảng trong schema public đều bật RLS", async () => {
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity ORDER BY tablename",
    );
    expect(rows.map((r) => r.tablename)).toEqual([]);
  });
});
