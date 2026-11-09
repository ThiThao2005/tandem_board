import type { ReactNode } from "react";
import { Link } from "react-router";
import { useAuth, useMe } from "../auth";
import { Avatar } from "./Avatar";

export function Logo() {
  return (
    <span className="logo">
      <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
        <circle cx="12" cy="16" r="8" fill="#7fae74" />
        <circle cx="20" cy="16" r="8" fill="#d98258" fillOpacity=".9" />
      </svg>
      tandem
    </span>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const me = useMe();
  const { logout } = useAuth();
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="topbar-home">
          <Logo />
        </Link>
        <div className="topbar-user">
          <Avatar name={me.displayName} color={me.avatarColor} />
          <span className="topbar-name">{me.displayName}</span>
          <button className="btn btn-ghost btn-sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
