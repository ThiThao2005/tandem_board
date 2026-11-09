import { createServer as createHttpServer } from "node:http";
import { createApp } from "./app";
import { attachRealtime } from "./realtime";

/** HTTP server phục vụ cả REST (Express) lẫn WebSocket (Socket.IO, đường dẫn /socket.io). */
export function createServer() {
  const http = createHttpServer(createApp());
  attachRealtime(http);
  return http;
}
