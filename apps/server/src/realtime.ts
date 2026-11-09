import type { Server as HttpServer } from "node:http";
import {
  boardJoinInput,
  opRequest,
  presenceUpdateInput,
  type Ack,
  type BoardOp,
  type ClientToServerEvents,
  type Role,
  type ServerToClientEvents,
  type SocketErrorBody,
} from "@tandem/shared";
import { Server, type Socket } from "socket.io";
import { z, ZodError } from "zod";
import { requireBoard } from "./access";
import { verifyAccessTokenClaims } from "./auth/tokens";
import { pool } from "./db";
import { HttpError } from "./errors";
import { catchUp, executeOp } from "./ops";
import { PresenceStore } from "./presence";

/*
 * Kênh realtime (Socket.IO).
 *  - Mỗi socket vào phòng user:{id} (để đá ra / báo đổi quyền) và phòng board:{id} của bảng đang mở.
 *  - Quyền được kiểm tra LẠI TỪ DB ở mỗi thao tác, không chỉ lúc kết nối.
 *  - Access token hết hạn mà client không gửi auth.refresh thì server tự ngắt kết nối.
 *  - Presence (tuần 4): ai đang ở trên bảng nào, chỉ trong bộ nhớ (xem presence.ts). Rời phòng vì bất kỳ
 *    lý do gì (board.leave, mất kết nối, bị xóa khỏi nhóm, bảng bị xóa) đều đi qua sự kiện "leave-room"
 *    của adapter, nên chỉ có MỘT chỗ dọn presence.
 *
 * Tuần 8: thêm @socket.io/redis-adapter để phát được giữa nhiều tiến trình server. Các hàm bên dưới chỉ
 * dùng io.to(...)/io.in(...) nên không phải sửa gì.
 */

interface SocketData {
  userId: string;
  /** Thời điểm access token hết hạn (giây). */
  exp: number;
  expiryTimer?: NodeJS.Timeout;
  /**
   * Các bảng socket này đã vào phòng VÀ đã qua bước kiểm tra quyền. Chỉ dựa vào socket.rooms thì chưa đủ:
   * board.join cho socket vào phòng trước rồi mới kiểm tra quyền, nên trong khoảng đó người ngoài nhóm
   * vẫn "ở trong phòng" và có thể chen presence vào bảng của nhóm khác.
   */
  boards: Set<string>;
}

type TandemServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type TandemSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

let io: TandemServer | null = null;
let presence = new PresenceStore();
let sweepTimer: NodeJS.Timeout | undefined;
/** Mỗi chừng này dọn các tab quá hạn heartbeat một lần. */
const PRESENCE_SWEEP_MS = 5_000;

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
/** Presence: heartbeat 15 giây/tab, cộng mở/đóng thẻ, ẩn/hiện tab. 5/giây (dồn 20) là dư cho vài tab. */
const takePresenceToken = rateLimiter(5, 20);

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
   *  1. kiểm tra quyền TRƯỚC khi vào phòng → người ngoài nhóm không bao giờ ở trong phòng, dù chỉ trong
   *     lúc chờ DB. (Trước đây chỉ kiểm tra sau khi vào phòng: với DB ở xa, trong 100–300 ms chờ đó người
   *     ngoài nhóm nhận được mọi thao tác của bảng, và gọi join liên tục là nghe lén được.)
   *  2. vào phòng TRƯỚC khi đọc phần thiếu → thao tác commit trong khoảng giữa hai bước vẫn tới được
   *     (có thể tới hai lần, client bỏ bản trùng theo seq);
   *  3. kiểm tra quyền LẦN NỮA sau khi vào phòng (bên trong catchUp) → nếu người này bị xóa khỏi nhóm
   *     giữa bước 1 và bước 2, lệnh đá ra chạy trước khi socket vào phòng nên không đá được; bước này
   *     thấy và cho rời phòng.
   */
  socket.on(
    "board.join",
    withAck(async (msg: unknown) => {
      if (!takeJoinToken(userId)) throw rateLimited();
      const { boardId, lastSeq } = boardJoinInput.parse(msg);
      const room = boardRoom(boardId);
      await requireBoard(pool, userId, boardId, "viewer");
      await socket.join(room);
      let result;
      try {
        result = await catchUp(userId, boardId, lastSeq);
      } catch (err) {
        await socket.leave(room);
        throw err;
      }
      // Bị xóa khỏi nhóm đúng lúc đang đọc: lệnh đá ra đã đưa socket khỏi phòng → không ghi presence.
      if (socket.rooms.has(room)) {
        socket.data.boards.add(boardId);
        // Vào lại (kết nối lại, lấy bù) thì giữ nguyên trạng thái đã có. Danh sách không đổi (vd. người
        // này đã mở bảng ở tab khác) thì vẫn phải gửi riêng cho socket này, nó chưa có danh sách.
        if (presence.ensure(boardId, socket.id, userId, Date.now())) publishPresence(boardId);
        else socket.emit("presence", { boardId, users: presence.list(boardId) });
      }
      return { role: result.role, catchUp: result.catchUp };
    }),
  );

  /**
   * Trạng thái của tab này (đang hiện/ẩn, đang mở thẻ nào). Vừa là thông báo thay đổi vừa là heartbeat.
   * Không tra DB (rẻ, gửi mỗi 15 giây): quyền đã kiểm tra lúc vào phòng, bị xóa khỏi nhóm thì bị đưa ra
   * khỏi phòng. cardId không được kiểm tra thuộc bảng này hay không — id lạ thì người khác chỉ không tìm
   * thấy thẻ đó để tô viền, server không trả về gì nên không lộ được gì.
   */
  socket.on(
    "presence.update",
    withAck(async (msg: unknown) => {
      if (!takePresenceToken(userId)) throw rateLimited();
      const { boardId, status, cardId } = presenceUpdateInput.parse(msg);
      if (!socket.data.boards.has(boardId)) throw new HttpError(409, "not_joined", "Join the board first");
      if (presence.set(boardId, socket.id, userId, { status, cardId }, Date.now())) publishPresence(boardId);
      return {};
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
      socket.data.boards = new Set();
      next();
    } catch (err) {
      const code = err instanceof HttpError ? err.code : "unauthorized";
      next(Object.assign(new Error(code), { data: { code } }));
    }
  });
  server.on("connection", onConnection);

  // Mọi đường rời phòng bảng đều tới đây: board.leave, mất kết nối (leaveAll), socketsLeave khi bị xóa
  // khỏi nhóm hoặc bảng bị xóa. Adapter đã bỏ socket khỏi phòng trước khi phát sự kiện này.
  server.of("/").adapter.on("leave-room", (room: string, socketId: string) => {
    if (!room.startsWith("board:")) return;
    const boardId = room.slice("board:".length);
    server.of("/").sockets.get(socketId)?.data.boards.delete(boardId);
    if (presence.remove(boardId, socketId)) publishPresence(boardId);
  });

  presence = new PresenceStore();
  clearInterval(sweepTimer);
  sweepTimer = setInterval(() => sweepPresence(), PRESENCE_SWEEP_MS);
  sweepTimer.unref();

  io = server;
  return server;
}

// ---------- Presence ----------

function publishPresence(boardId: string) {
  io?.to(boardRoom(boardId)).emit("presence", { boardId, users: presence.list(boardId) });
}

/** Bỏ các tab quá hạn heartbeat và báo cho phòng. Test gọi trực tiếp với `now` giả. */
export function sweepPresence(now = Date.now()) {
  for (const boardId of presence.sweep(now)) publishPresence(boardId);
}

/** Dùng trong test: số bảng đang có người trong bộ nhớ. */
export function presenceBoardCount(): number {
  return presence.boardCount;
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
  clearInterval(sweepTimer);
  await io?.close();
  io = null;
}
