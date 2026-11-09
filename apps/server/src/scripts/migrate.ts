import { pool } from "../db";
import { migrate } from "../migrate";

try {
  await migrate(pool, console.log);
  console.log("Migrations complete.");
} finally {
  await pool.end();
}
