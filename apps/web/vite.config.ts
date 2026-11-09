import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Gọi /api qua cùng origin với trang → cookie refresh token hoạt động mà không cần CORS.
    proxy: { "/api": "http://localhost:4000" },
  },
});
