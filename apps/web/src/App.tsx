import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { BoardPage } from "./pages/BoardPage";
import { HomePage } from "./pages/HomePage";
import { InvitePage } from "./pages/InvitePage";
import { AuthPage } from "./pages/AuthPage";
import { WorkspacePage } from "./pages/WorkspacePage";

function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === "loading") return <div className="splash">Loading…</div>;
  if (state.status === "unreachable") {
    return (
      <div className="splash" role="status" aria-live="polite">
        Can't reach the server. Retrying…
        <br />
        <span className="muted small">Your unsent changes are saved on this device.</span>
      </div>
    );
  }
  if (state.status === "anon") {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <Layout>{children}</Layout>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
      <Route path="/w/:workspaceId" element={<RequireAuth><WorkspacePage /></RequireAuth>} />
      <Route path="/b/:boardId" element={<RequireAuth><BoardPage /></RequireAuth>} />
      <Route path="/invite/:token" element={<RequireAuth><InvitePage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
