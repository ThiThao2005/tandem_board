import type { AuthResult, LoginInput, RegisterInput, User } from "@tandem/shared";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, refreshSession, setAccessToken, setSessionLostHandler } from "./api";

type AuthState = { status: "loading" } | { status: "anon" } | { status: "authed"; user: User };

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
    setSessionLostHandler(() => setState({ status: "anon" }));
    refreshSession().then((r) => setState(r ? { status: "authed", user: r.user } : { status: "anon" }));
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
