import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Đổi cổng được qua biến môi trường để chạy song song hai bản dev (vd. một bản nối Supabase,
// một bản nối Postgres trong Docker). API_PORT là cổng của API server (cùng biến server đọc).
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(env.WEB_PORT ?? 5173),
    strictPort: true,
    // Gọi /api qua cùng origin với trang → cookie refresh token hoạt động mà không cần CORS.
    proxy: { "/api": `http://localhost:${env.API_PORT ?? 4000}` },
  },
});
