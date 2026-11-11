import type { ApiErrorBody, AuthResult } from "@tandem/shared";

/**
 * Access token chỉ nằm trong bộ nhớ (không lưu localStorage) để mã độc chèn vào trang khó lấy được.
 * Refresh token nằm trong cookie httpOnly; tải lại trang thì gọi /auth/refresh để lấy access token mới.
 */
let accessToken: string | null = null;
let refreshing: Promise<AuthResult | null> | null = null;
let onSessionLost: () => void = () => {};
const tokenListeners = new Set<(token: string | null) => void>();

function setToken(token: string | null) {
  accessToken = token;
  for (const fn of tokenListeners) fn(token);
}

export function setAccessToken(token: string | null) {
  setToken(token);
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Báo mỗi khi access token đổi (đăng nhập, làm mới, đăng xuất). Socket dùng để gửi auth.refresh. */
export function onAccessToken(fn: (token: string | null) => void): () => void {
  tokenListeners.add(fn);
  return () => tokenListeners.delete(fn);
}
export function setSessionLostHandler(fn: () => void) {
  onSessionLost = fn;
}
export function sessionLost() {
  onSessionLost();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Không gọi được server khi làm mới phiên: mất mạng, server đang khởi động lại, hoặc lỗi 5xx (proxy của Vite trả 500
 * khi API chưa chạy). KHÔNG phải hết phiên: cookie refresh vẫn còn, có mạng / server sống lại là làm mới được.
 * Trước đây trường hợp này bị coi như hết phiên → bị đẩy ra trang đăng nhập (giữa phiên, ở lần tự làm mới mỗi
 * ~14 phút), hoặc kẹt "Loading…" mãi khi tải trang lúc đang offline (fetch ném lỗi mà không ai bắt).
 */
export class ServerUnreachable extends Error {
  constructor() {
    super("Can't reach the server");
  }
}

async function doRefresh(): Promise<AuthResult | null> {
  let unreachable = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch("/api/auth/refresh", { method: "POST" });
    } catch {
      unreachable = true; // mất mạng
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const data = (await res.json()) as AuthResult;
      setToken(data.accessToken);
      return data;
    }
    if (res.status >= 500) {
      unreachable = true; // server lỗi / đang khởi động lại
      await sleep(500 * 2 ** attempt);
      continue;
    }
    unreachable = false;
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    // Tab khác vừa làm mới xong và đã ghi cookie mới → chờ một chút rồi thử lại.
    if (body?.error.code === "refresh_race") {
      await sleep(250 * (attempt + 1));
      continue;
    }
    break;
  }
  // Giữ nguyên access token đang có: có thể vẫn còn hạn, và phiên chưa hề mất.
  if (unreachable) throw new ServerUnreachable();
  setToken(null);
  return null;
}

/** Nhiều request cùng gặp 401 thì chỉ làm mới một lần (single-flight). */
export function refreshSession(): Promise<AuthResult | null> {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

interface Options {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
}

export async function api<T>(path: string, { method = "GET", body }: Options = {}): Promise<T> {
  const send = () =>
    fetch(`/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await send();
  if (res.status === 401 && !path.startsWith("/auth/")) {
    let refreshed: AuthResult | null;
    try {
      refreshed = await refreshSession();
    } catch (err) {
      // Không làm mới được vì mất mạng / server lỗi: báo lỗi cho lần gọi này, KHÔNG đăng xuất.
      if (err instanceof ServerUnreachable) throw new ApiError(0, "unreachable", "Can't reach the server");
      throw err;
    }
    if (refreshed) {
      res = await send();
    } else {
      onSessionLost();
    }
  }
  if (res.status === 204) return undefined as T;

  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? "unknown", err?.message ?? "Something went wrong, please try again", err?.details);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) return "Can't reach the server";
  return "Something went wrong, please try again";
}
