import type { ClientToServerEvents, ServerToClientEvents } from "@tandem/shared";
import { io, type Socket } from "socket.io-client";
import { getAccessToken, onAccessToken, refreshSession, sessionLost } from "./api";

export type TandemSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/*
 * Một kết nối Socket.IO dùng chung cho cả app (mỗi tab một kết nối), mở khi vào bảng đầu tiên.
 *
 * Access token chỉ sống 15 phút:
 *  - Làm mới CHỦ ĐỘNG ~1 phút trước khi hết hạn, rồi gửi `auth.refresh` để server không ngắt kết nối.
 *  - Nếu vẫn bị ngắt (vd. máy ngủ nên hẹn giờ chạy trễ), server gửi `session.expired` rồi ngắt; ta làm
 *    mới token rồi kết nối lại. Khi vào lại phòng, client gửi lastSeq nên không lỡ thao tác nào.
 */

let socket: TandemSocket | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let stopListening: (() => void) | null = null;

/** Đọc thời điểm hết hạn trong JWT (chỉ để hẹn giờ làm mới, không dùng để tin tưởng gì cả). */
function expiresAt(token: string): number | null {
  try {
    const part = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const exp = (JSON.parse(atob(part)) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function scheduleRefresh(token: string | null) {
  clearTimeout(refreshTimer);
  const exp = token ? expiresAt(token) : null;
  if (exp === null) return;
  const delay = Math.max(5_000, exp - Date.now() - 60_000);
  const run = () => {
    refreshSession().then(
      (r) => {
        if (!r) sessionLost();
      },
      // Mất mạng / server lỗi đúng lúc làm mới: KHÔNG đăng xuất, thử lại sau. Token có hết hạn trong lúc chờ thì
      // socket sẽ bị ngắt và reconnectWithFreshToken làm mới khi có mạng lại.
      () => {
        refreshTimer = setTimeout(run, REFRESH_RETRY_MS);
      },
    );
  };
  refreshTimer = setTimeout(run, delay);
}

/** Làm mới token thất bại vì không gọi được server thì thử lại sau chừng này. */
const REFRESH_RETRY_MS = 30_000;
const RECONNECT_RETRY_MS = 3_000;

/** Làm mới token rồi kết nối lại; hết phiên thì báo đăng xuất; không gọi được server thì thử lại sau. */
async function reconnectWithFreshToken(s: TandemSocket) {
  let r;
  try {
    r = await refreshSession();
  } catch {
    // Mất mạng / server đang khởi động lại: phiên chưa mất. Thử lại nếu socket này vẫn còn dùng (chưa đăng xuất).
    setTimeout(() => {
      if (socket === s && !s.connected) void reconnectWithFreshToken(s);
    }, RECONNECT_RETRY_MS);
    return;
  }
  if (r) s.connect();
  else sessionLost();
}

export function getSocket(): TandemSocket {
  if (socket) return socket;
  // Khi deploy, web (Vercel) và server (Render) khác domain: Vercel không chuyển tiếp được WebSocket,
  // nên socket nối thẳng tới server. Để trống (dev) thì dùng cùng domain qua proxy của Vite.
  const socketUrl: string | undefined = import.meta.env.VITE_SOCKET_URL || undefined;
  const s: TandemSocket = io(socketUrl, {
    autoConnect: false,
    // Chỉ WebSocket: không cần sticky session khi chạy nhiều server ở tuần 8.
    transports: ["websocket"],
    // Hàm: đọc lại token mới nhất ở MỖI lần (kết nối lại).
    auth: (cb) => cb({ token: getAccessToken() }),
  });

  s.on("connect_error", (err) => {
    // Server từ chối ở bước xác thực thì Socket.IO KHÔNG tự thử lại; lỗi mạng thì nó tự thử lại.
    const code = (err as Error & { data?: { code?: string } }).data?.code;
    if (code === "token_expired" || code === "unauthorized") void reconnectWithFreshToken(s);
  });
  s.on("disconnect", (reason) => {
    // Server chủ động ngắt (token hết hạn) thì cũng không tự kết nối lại.
    if (reason === "io server disconnect") void reconnectWithFreshToken(s);
  });

  const stopToken = onAccessToken((token) => {
    scheduleRefresh(token);
    if (token && s.connected) {
      s.emit("auth.refresh", token, (res) => {
        if (!res.ok) s.disconnect().connect();
      });
    }
  });
  scheduleRefresh(getAccessToken());

  // Tuần 6: trình duyệt báo mất/có mạng thì phản ứng ngay, không chờ ping hết hạn (~45 giây) mới biết kết nối đã chết,
  // trong lúc đó giao diện vẫn báo "Saving…" dù thực ra đang offline.
  const onOffline = () => s.io.engine?.close();
  const onOnline = () => {
    if (!s.connected) s.connect();
  };
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  stopListening = () => {
    stopToken();
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
  };

  s.connect();
  socket = s;
  return s;
}

/** Đăng xuất: đóng kết nối, lần sau mở lại với người mới. */
export function closeSocket() {
  clearTimeout(refreshTimer);
  stopListening?.();
  stopListening = null;
  socket?.disconnect();
  socket = null;
}
