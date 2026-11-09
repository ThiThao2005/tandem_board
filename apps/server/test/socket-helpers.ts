import type { AddressInfo } from "node:net";
import type {
  Ack,
  BoardOp,
  BoardPresence,
  ClientToServerEvents,
  JoinAck,
  OpAck,
  OpRequestInput,
  PresenceStatus,
  ServerToClientEvents,
} from "@tandem/shared";
import { io as connectClient, type Socket } from "socket.io-client";
import { afterAll, beforeAll } from "vitest";
import { closeRealtime } from "../src/realtime";
import { createServer } from "../src/server";

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents> & {
  /** Mọi thao tác socket này đã nhận, theo thứ tự nhận. */
  received: BoardOp[];
  /** Mọi danh sách presence socket này đã nhận, theo thứ tự nhận. */
  presence: BoardPresence[];
};

let baseUrl = "";
const opened: ClientSocket[] = [];

/** Bật một server thật (REST + Socket.IO) trên cổng ngẫu nhiên cho cả file test. */
export function useRealtimeServer() {
  const http = createServer();
  beforeAll(async () => {
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    for (const s of opened) s.disconnect();
    await closeRealtime();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
}

/** Mở kết nối; trả về socket đã kết nối, hoặc ném lỗi với err.data.code khi server từ chối. */
export async function connect(token: string | undefined): Promise<ClientSocket> {
  const socket = connectClient(baseUrl, {
    auth: token === undefined ? {} : { token },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  }) as ClientSocket;
  socket.received = [];
  socket.presence = [];
  socket.on("op", (op) => socket.received.push(op));
  socket.on("presence", (msg) => socket.presence.push(msg));
  opened.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

export function join(socket: ClientSocket, boardId: string, lastSeq: number | null = null): Promise<JoinAck> {
  return socket.emitWithAck("board.join", { boardId, lastSeq });
}

export function sendOp(socket: ClientSocket, boardId: string, op: OpRequestInput): Promise<OpAck> {
  return socket.emitWithAck("op", { ...op, boardId });
}

export function refreshToken(socket: ClientSocket, token: string): Promise<Ack> {
  return socket.emitWithAck("auth.refresh", token);
}

export function updatePresence(
  socket: ClientSocket,
  boardId: string,
  status: PresenceStatus,
  cardId: string | null = null,
): Promise<Ack> {
  return socket.emitWithAck("presence.update", { boardId, status, cardId });
}

/** Danh sách presence mới nhất socket nhận được cho bảng này (rút gọn thành [userId, status, cardId]). */
export function lastPresence(socket: ClientSocket, boardId: string): [string, string, string | null][] | null {
  const msg = socket.presence.filter((p) => p.boardId === boardId).at(-1);
  return msg ? msg.users.map((u) => [u.userId, u.status, u.cardId]) : null;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chờ tới khi điều kiện đúng (thao tác đi qua mạng nên không tới ngay). */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000, label = "condition") {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Hết thời gian chờ: ${label}`);
    await sleep(10);
  }
}

/** Ack thành công thì trả về op, không thì ném lỗi để test báo rõ lý do. */
export function okOp(ack: OpAck): BoardOp {
  if (!ack.ok) throw new Error(`Thao tác bị từ chối: ${ack.error.code} — ${ack.error.message}`);
  return ack.op;
}

export function errorCode(ack: Ack): string | null {
  return ack.ok ? null : ack.error.code;
}
