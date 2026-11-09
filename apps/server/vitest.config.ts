import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    // Các file test dùng chung một database nên chạy lần lượt.
    fileParallelism: false,
    env: { NODE_ENV: "test" },
  },
});
