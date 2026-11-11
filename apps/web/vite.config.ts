import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Đổi cổng được qua biến môi trường để chạy song song hai bản dev (vd. một bản nối Supabase,
// một bản nối Postgres trong Docker). API_PORT là cổng của API server (cùng biến server đọc).
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  plugins: [react()],
  // Editor ghi chú (tuần 5) được tải lười; khai báo trước để lần đầu mở thẻ Vite không phải tối ưu
  // thư viện mới rồi tải lại cả trang.
  optimizeDeps: {
    include: [
      "yjs",
      "y-indexeddb",
      "idb",
      "y-protocols/awareness",
      "@tiptap/react",
      "@tiptap/starter-kit",
      "@tiptap/extension-collaboration",
      "@tiptap/extension-collaboration-caret",
      "@tiptap/extension-list",
      "@tiptap/extensions",
    ],
  },
  build: {
    rollupOptions: {
      output: {
        // Tách thư viện ít đổi ra file riêng: trình duyệt giữ cache được lâu (code app đổi thì chỉ tải lại file
        // của app), và không còn một file > 500 KB. TipTap không nằm ở đây: nó vẫn ở chunk tải lười của editor.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) return "vendor-react";
          if (/[\\/]node_modules[\\/](socket\.io-client|engine\.io-client|socket\.io-parser|engine\.io-parser)[\\/]/.test(id)) {
            return "vendor-socket";
          }
          if (/[\\/]node_modules[\\/](yjs|y-protocols|lib0)[\\/]/.test(id)) return "vendor-yjs";
          return undefined;
        },
      },
    },
  },
  server: {
    port: Number(env.WEB_PORT ?? 5173),
    strictPort: true,
    // Gọi /api qua cùng origin với trang → cookie refresh token hoạt động mà không cần CORS.
    proxy: {
      "/api": `http://localhost:${env.API_PORT ?? 4000}`,
      // Socket.IO (tuần 3): cùng origin với trang, ws: true để chuyển tiếp cả kết nối WebSocket.
      "/socket.io": { target: `http://localhost:${env.API_PORT ?? 4000}`, ws: true },
    },
  },
});
