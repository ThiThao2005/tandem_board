import type { AuthResult, LoginInput, RegisterInput, User } from "@tandem/shared";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, refreshSession, ServerUnreachable, setAccessToken, setSessionLostHandler } from "./api";
import { closeSocket } from "./realtime";
import { wipeOfflineData } from "./sync/offlineStore";

/**
 * unreachable: chưa biết đã đăng nhập hay chưa vì không gọi được server (mất mạng, server đang khởi động lại).
 * Không đẩy ra trang đăng nhập (cookie phiên vẫn còn), mà thử lại cho tới khi gọi được.
 */
type AuthState =
  | { status: "loading" }
  | { status: "unreachable" }
  | { status: "anon" }
  | { status: "authed"; user: User };

/** Không gọi được server lúc mở app: thử lại sau chừng này (và ngay khi trình duyệt báo có mạng). */
const UNREACHABLE_RETRY_MS = 3_000;

interface AuthContextValue {
  state: AuthState;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const queryClient = useQueryClient();

  useEffect(() => {
    setSessionLostHandler(() => {
      closeSocket();
      setState({ status: "anon" });
    });
    let cancelled = false;
    let waiting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      clearTimeout(timer);
      waiting = false;
      refreshSession().then(
        (r) => {
          if (!cancelled) setState(r ? { status: "authed", user: r.user } : { status: "anon" });
        },
        (err: unknown) => {
          if (cancelled) return;
          if (!(err instanceof ServerUnreachable)) {
            setState({ status: "anon" });
            return;
          }
          setState({ status: "unreachable" });
          waiting = true;
          timer = setTimeout(attempt, UNREACHABLE_RETRY_MS);
        },
      );
    };
    // Có mạng lại thì thử ngay, không chờ hết hẹn giờ.
    const onOnline = () => {
      if (waiting) attempt();
    };
    window.addEventListener("online", onOnline);
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const accept = useCallback((r: AuthResult) => {
    setAccessToken(r.accessToken);
    setState({ status: "authed", user: r.user });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      login: async (input) => accept(await api<AuthResult>("/auth/login", { method: "POST", body: input })),
      register: async (input) => accept(await api<AuthResult>("/auth/register", { method: "POST", body: input })),
      logout: async () => {
        await api("/auth/logout", { method: "POST" }).catch(() => {});
        closeSocket();
        // Đăng xuất chủ động: xóa dữ liệu offline trên máy này (hàng đợi, ghi chú đã lưu) để người dùng sau không đọc được.
        // Mất phiên do hết hạn thì KHÔNG xóa: đăng nhập lại là gửi tiếp được.
        await wipeOfflineData();
        setAccessToken(null);
        queryClient.clear();
        setState({ status: "anon" });
      },
    }),
    [state, accept, queryClient],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/** Dùng trong trang đã đăng nhập. */
export function useMe(): User {
  const { state } = useAuth();
  if (state.status !== "authed") throw new Error("Not signed in");
  return state.user;
}
