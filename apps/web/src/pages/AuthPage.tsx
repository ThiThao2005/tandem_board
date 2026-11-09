import { useState, type CSSProperties, type FormEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { errorMessage } from "../api";
import { useAuth } from "../auth";
import { Logo } from "../components/Layout";
import { toneAt, toneVars } from "../palette";

/** Bảng thu nhỏ minh họa: 3 cột theo tông trời, lúa, rêu. */
const MINI = [[false, true, false], [true, false], [false]];

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { state, login, register } = useAuth();
  const [params] = useSearchParams();
  const next = params.get("next");
  // Chỉ cho chuyển hướng nội bộ, tránh open redirect kiểu ?next=https://trang-la.com
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.status === "authed") return <Navigate to={target} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await login({ email, password });
      else await register({ email, password, displayName });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const otherLink = `${mode === "login" ? "/register" : "/login"}${next ? `?next=${encodeURIComponent(next)}` : ""}`;

  return (
    <div className="auth">
      <div className="auth-side">
        <Logo />
        <h1>
          Your whole team, one board, <em>in real time.</em>
        </h1>
        <p>Move cards, edit notes, and see each other's changes instantly. Keep working even when you go offline.</p>
        <div className="mini-board" aria-hidden>
          {MINI.map((cards, i) => (
            <div key={i} className="mini-lane" style={toneVars(toneAt(i)) as CSSProperties}>
              <b />
              {cards.map((tall, j) => (
                <div key={j} className={`mini-card ${tall ? "tall" : ""}`} />
              ))}
            </div>
          ))}
        </div>
      </div>
      <form className="auth-card" onSubmit={onSubmit}>
        <h2>{mode === "login" ? "Sign in" : "Create an account"}</h2>
        {mode === "register" && (
          <label className="field">
            <span>Display name</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={60} autoFocus />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            autoFocus={mode === "login"}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === "register" ? 8 : 1}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <p className="auth-switch">
          {mode === "login" ? "New to Tandem?" : "Already have an account?"}{" "}
          <Link to={otherLink}>{mode === "login" ? "Create an account" : "Sign in"}</Link>
        </p>
      </form>
    </div>
  );
}
