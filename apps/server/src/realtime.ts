import type { Server as HttpServer } from "node:http";
import {
  boardJoinInput,
  opRequest,
  type Ack,
  type BoardOp,
  type ClientToServerEvents,
  type Role,
  type ServerToClientEvents,
  type SocketErrorBody,
} from "@tandem/shared";
import { Server, type Socket } from "socket.io";
import { z, ZodError } from "zod";
import { verifyAccessTokenClaims } from "./auth/tokens";
import { pool } from "./db";
import { HttpError } from "./errors";
import { catchUp, executeOp } from "./ops";

/*
 * Kênh realtime (Socket.IO).
 *  - Mỗi socket vào phòng user:{id} (để đá ra / báo đổi quyền) và phòng board:{id} của bảng đang mở.
 *  - Quyền được kiểm tra LẠI TỪ DB ở mỗi thao tác, không chỉ lúc kết nối.
 *  - Access token hết hạn mà client không gửi auth.refresh thì server tự ngắt kết nối.
 *
 * Tuần 8: thêm @socket.io/redis-adapter để phát được giữa nhiều tiến trình server. Các hàm bên dưới chỉ
 * dùng io.to(...)/io.in(...) nên không phải sửa gì.
 */

interface SocketData {
  userId: string;
  /** Thời điểm access token hết hạn (giây). */
  exp: number;
  expiryTimer?: NodeJS.Timeout;
}

type TandemServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type TandemSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

let io: TandemServer | null = null;

export const boardRoom = (boardId: string) => `board:${boardId}`;
const userRoom = (userId: string) => `user:${userId}`;

// ---------- Giới hạn tốc độ ----------

/**
 * Token bucket cho từng người: tối đa `burst` lần dồn dập, sau đó `rate` lần mỗi giây.
 * Xô đã đầy lại (người đó ngừng gửi đủ lâu) thì bị dọn khỏi Map, để Map không phình mãi theo số người.
 */
function rateLimiter(rate: number, burst: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const fullAfterMs = (burst / rate) * 1000;
  let lastSweep = Date.now();
  return (userId: string): boolean => {
    const now = Date.now();
    if (now - lastSweep > 60_000) {
      for (const [id, b] of buckets) if (now - b.at > fullAfterMs) buckets.delete(id);
      lastSweep = now;
    }
    const b = buckets.get(userId) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    buckets.set(userId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

/** Thao tác sửa bảng: 20/giây, dồn tối đa 40. */
const takeOpToken = rateLimiter(20, 40);
/**
 * Vào phòng: mỗi lần đọc cả ảnh chụp hoặc phần thiếu nên đắt hơn một thao tác nhiều. Xô riêng (không dùng
 * chung với thao tác), để người vừa sửa dồn dập rồi kết nối lại vẫn vào lại phòng được ngay.
 */
const takeJoinToken = rateLimiter(2, 10);

const rateLimited = () => new HttpError(429, "rate_limited", "Too many requests at once, slow down a little");

// ---------- Lỗi ----------

function toSocketError(err: unknown): SocketErrorBody {
  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message, details: err.details };
  if (err instanceof ZodError) {
    return { status: 400, code: "invalid_input", message: err.issues[0]?.message ?? "Invalid input", details: err.issues };
  }
  console.error(err);
  return { status: 500, code: "internal", message: "Internal server error" };
}

/**
 * Bọc handler có ack: lỗi nào cũng trả về { ok: false, error } thay vì làm sập tiến trình.
 * Client gửi sự kiện mà không kèm ack thì vẫn chạy, chỉ là không trả lời.
 */
function withAck<A, R extends object>(fn: (arg: A) => Promise<R>) {
  return (arg: A, ack: unknown) => {
    const reply = typeof ack === "function" ? (ack as (res: Ack<R>) => void) : () => {};
    fn(arg).then(
      (res) => reply({ ok: true, ...res }),
      (err: unknown) => reply({ ok: false, error: toSocketError(err) }),
    );
  };
}

// ---------- Xác thực ----------

/** Hẹn giờ ngắt kết nối đúng lúc access token hết hạn. auth.refresh sẽ hẹn lại. */
function armExpiry(socket: TandemSocket) {
  clearTimeout(socket.data.expiryTimer);
  // setTimeout chỉ nhận tối đa ~24,8 ngày.
  const ms = Math.min(socket.data.exp * 1000 - Date.now(), 2 ** 31 - 1);
  socket.data.expiryTimer = setTimeout(() => {
    socket.emit("session.expired");
    socket.disconnect(true);
  }, Math.max(0, ms));
}

const boardIdInput = z.object({ boardId: z.string().uuid() });

function onConnection(socket: TandemSocket) {
  const { userId } = socket.data;
  void socket.join(userRoom(userId));
  armExpiry(socket);

  socket.on("disconnect", () => clearTimeout(socket.data.expiryTimer));

  /** Client lấy access token mới (qua REST /auth/refresh) rồi báo cho socket, để không bị ngắt. */
  socket.on(
    "auth.refresh",
    withAck(async (token: unknown) => {
      const claims = verifyAccessTokenClaims(token);
      // Không cho đổi sang người khác giữa chừng: các phòng đang tham gia là theo quyền của người cũ.
      if (claims.userId !== userId) throw new HttpError(401, "unauthorized", "Token belongs to another user");
      socket.data.exp = claims.exp;
      armExpiry(socket);
      return {};
    }),
  );

  /**
   * Vào phòng của bảng và lấy phần còn thiếu (seq > lastSeq). Thứ tự quan trọng:
   *  1. vào phòng TRƯỚC, rồi mới đọc phần thiếu → thao tác commit trong khoảng giữa hai bước vẫn
   *     tới được (có thể tới hai lần, client bỏ bản trùng theo seq);
   *  2. kiểm tra quyền SAU khi vào phòng → nếu người này bị xóa khỏi nhóm đúng lúc đó, thì hoặc
   *     bước kiểm tra thấy (và rời phòng), hoặc lệnh đá ra chạy sau và thấy socket đã ở trong phòng.
   */
  socket.on(
    "board.join",
    withAck(async (msg: unknown) => {
      if (!takeJoinToken(userId)) throw rateLimited();
      const { boardId, lastSeq } = boardJoinInput.parse(msg);
      await socket.join(boardRoom(boardId));
      try {
        const { role, catchUp: result } = await catchUp(userId, boardId, lastSeq);
        return { role, catchUp: result };
      } catch (err) {
        await socket.leave(boardRoom(boardId));
        throw err;
      }
    }),
  );

  socket.on("board.leave", (msg: unknown) => {
    const r = boardIdInput.safeParse(msg);
    if (r.success) void socket.leave(boardRoom(r.data.boardId));
  });

  socket.on(
    "op",
    withAck(async (msg: unknown) => {
      if (!takeOpToken(userId)) throw rateLimited();
      const { boardId } = boardIdInput.parse(msg);
      const req = opRequest.parse(msg);
      const result = await executeOp(userId, req, boardId);
      // Phát cho cả phòng (kể cả người gửi) TRƯỚC khi trả ack: cùng một kết nối nên người gửi nhận
      // bản phát trước, áp dụng theo đúng thứ tự seq như mọi người.
      if (!result.duplicate) publishOp(result.op);
      return result;
    }),
  );
}

export function attachRealtime(http: HttpServer): TandemServer {
  const server: TandemServer = new Server(http, {
    serveClient: false,
    // Một thao tác chỉ vài trăm byte; chặn gói to bất thường.
    maxHttpBufferSize: 64 * 1024,
  });

  server.use((socket, next) => {
    try {
      const { userId, exp } = verifyAccessTokenClaims(socket.handshake.auth?.token);
      socket.data.userId = userId;
      socket.data.exp = exp;
      next();
    } catch (err) {
      const code = err instanceof HttpError ? err.code : "unauthorized";
      next(Object.assign(new Error(code), { data: { code } }));
    }
  });
  server.on("connection", onConnection);

  io = server;
  return server;
}

// ---------- Phát từ REST / sau khi commit ----------

/** Gọi SAU khi transaction đã commit. */
export function publishOp(op: BoardOp) {
  io?.to(boardRoom(op.boardId)).emit("op", op);
}

async function boardRoomsOf(workspaceId: string): Promise<{ ids: string[]; rooms: string[] }> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM boards WHERE workspace_id = $1", [workspaceId]);
  const ids = rows.map((r) => r.id);
  return { ids, rooms: ids.map(boardRoom) };
}

/** Người bị xóa khỏi nhóm: đưa mọi socket của họ ra khỏi phòng các bảng của nhóm NGAY, rồi báo cho họ. */
export async function revokeAccess(workspaceId: string, userId: string) {
  if (!io) return;
  const { ids, rooms } = await boardRoomsOf(workspaceId);
  if (rooms.length > 0) io.in(userRoom(userId)).socketsLeave(rooms);
  io.to(userRoom(userId)).emit("access.revoked", { workspaceId, boardIds: ids });
}

export function roleChanged(workspaceId: string, userId: string, role: Role) {
  io?.to(userRoom(userId)).emit("access.role", { workspaceId, role });
}

export async function membersChanged(workspaceId: string) {
  if (!io) return;
  const { rooms } = await boardRoomsOf(workspaceId);
  if (rooms.length > 0) io.to(rooms).emit("members.changed", { workspaceId });
}

export function boardDeleted(boardId: string) {
  if (!io) return;
  io.to(boardRoom(boardId)).emit("board.deleted", { boardId });
  io.in(boardRoom(boardId)).socketsLeave(boardRoom(boardId));
}

/** Dùng trong test: đóng mọi kết nối. */
export async function closeRealtime() {
  await io?.close();
  io = null;
}
