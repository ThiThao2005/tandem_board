import { config } from "./config";
import { flushNotes } from "./realtime";
import { createServer } from "./server";

createServer().listen(config.port, () => {
  console.log(`Tandem API + realtime listening on http://localhost:${config.port}`);
});

// Tắt server (Ctrl+C, deploy, tsx watch khởi động lại): lưu nốt ghi chú còn trong bộ nhớ (tuần 5).
// Ghi chú được lưu sau ≤ 3 giây kể từ lần gõ cuối, nên chỉ phần gõ ngay trước lúc tắt là cần bước này.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 5_000);
    void flushNotes()
      .catch((err: unknown) => console.error("Saving notes on shutdown failed", err))
      .finally(() => {
        clearTimeout(timeout);
        process.exit(0);
      });
  });
}
