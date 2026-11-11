import type { ReactNode } from "react";
import { Link } from "react-router";
import { useAuth, useMe } from "../auth";
import { countUnsent } from "../sync/offlineStore";
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

  async function signOut() {
    // Thay đổi chưa gửi nằm trên máy này; đăng xuất là xóa chúng (người dùng sau cùng trình duyệt không được đọc).
    const unsent = await countUnsent(me.id);
    if (unsent > 0 && !confirm(`${unsent} ${unsent === 1 ? "change hasn't" : "changes haven't"} reached the server yet. Signing out will discard ${unsent === 1 ? "it" : "them"}. Sign out anyway?`)) {
      return;
    }
    await logout();
  }

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="topbar-home">
          <Logo />
        </Link>
        <div className="topbar-user">
          <Avatar name={me.displayName} color={me.avatarColor} />
          <span className="topbar-name">{me.displayName}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
