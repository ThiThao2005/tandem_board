import type { ApiErrorBody, AuthResult } from "@tandem/shared";

/**
 * Access token chỉ nằm trong bộ nhớ (không lưu localStorage) để mã độc chèn vào trang khó lấy được.
 * Refresh token nằm trong cookie httpOnly; tải lại trang thì gọi /auth/refresh để lấy access token mới.
 */
let accessToken: string | null = null;
let refreshing: Promise<AuthResult | null> | null = null;
let onSessionLost: () => void = () => {};

export function setAccessToken(token: string | null) {
  accessToken = token;
}
export function setSessionLostHandler(fn: () => void) {
  onSessionLost = fn;
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

async function doRefresh(): Promise<AuthResult | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("/api/auth/refresh", { method: "POST" });
    if (res.ok) {
      const data = (await res.json()) as AuthResult;
      accessToken = data.accessToken;
      return data;
    }
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    // Tab khác vừa làm mới xong và đã ghi cookie mới → chờ một chút rồi thử lại.
    if (body?.error.code === "refresh_race") {
      await sleep(250 * (attempt + 1));
      continue;
    }
    break;
  }
  accessToken = null;
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
    if (await refreshSession()) {
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
