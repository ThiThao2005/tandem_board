import { ROLE_LABEL, ROLES, type Board, type Invitation, type Role, type WorkspaceDetail } from "@tandem/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { formatDate, plural } from "../format";
import { useMe } from "../auth";
import { Avatar } from "../components/Avatar";
import { toneFor, toneVars } from "../palette";
import { useToast } from "../toast";

export function WorkspacePage() {
  const { workspaceId = "" } = useParams();
  const me = useMe();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [boardTitle, setBoardTitle] = useState("");

  const detail = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api<WorkspaceDetail>(`/workspaces/${workspaceId}`),
  });
  const boards = useQuery({
    queryKey: ["boards", workspaceId],
    queryFn: () => api<Board[]>(`/workspaces/${workspaceId}/boards`),
  });

  const onError = (err: unknown) => toast({ message: errorMessage(err), tone: "error" });
  const refresh = () => qc.invalidateQueries({ queryKey: ["workspace", workspaceId] });

  const createBoard = useMutation({
    mutationFn: (title: string) => api<Board>(`/workspaces/${workspaceId}/boards`, { method: "POST", body: { title } }),
    onSuccess: (b) => navigate(`/b/${b.id}`),
    onError,
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api(`/workspaces/${workspaceId}/members/${userId}`, { method: "PATCH", body: { role } }),
    onSettled: refresh,
    onError,
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => api(`/workspaces/${workspaceId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: (_d, userId) => {
      if (userId === me.id) {
        qc.invalidateQueries({ queryKey: ["workspaces"] });
        navigate("/");
      } else refresh();
    },
    onError,
  });

  if (detail.error) return <div className="page"><p className="form-error">{errorMessage(detail.error)}</p></div>;
  if (!detail.data) return <div className="page muted">Loading…</div>;

  const { workspace, role, members } = detail.data;
  const isOwner = role === "owner";
  const canEdit = role !== "viewer";

  function onCreateBoard(e: FormEvent) {
    e.preventDefault();
    if (boardTitle.trim()) createBoard.mutate(boardTitle.trim());
  }

  return (
    <div className="page">
      <nav className="crumbs">
        <Link to="/">Workspaces</Link> / <span>{workspace.name}</span>
      </nav>
      <h1 className="page-title">{workspace.name}</h1>
      <p className="page-sub">
        {plural(members.length, "member")} · your role: {ROLE_LABEL[role]}
      </p>

      <div className="workspace-layout">
        <section>
          <h2 className="section-title">Boards</h2>
          <div className="grid">
            {boards.data?.map((b) => (
              <Link
                key={b.id}
                to={`/b/${b.id}`}
                className="tile tile-toned"
                style={toneVars(toneFor(b.id)) as CSSProperties}
              >
                <span className="tile-title">{b.title}</span>
                <span className="tile-dots" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
              </Link>
            ))}
            {canEdit && (
              <form className="tile tile-new" onSubmit={onCreateBoard}>
                <input
                  placeholder="New board name…"
                  value={boardTitle}
                  onChange={(e) => setBoardTitle(e.target.value)}
                  maxLength={120}
                />
                <button className="btn btn-primary btn-sm" disabled={!boardTitle.trim() || createBoard.isPending}>
                  Create board
                </button>
              </form>
            )}
          </div>
          {boards.data?.length === 0 && !canEdit && <p className="muted">This workspace has no boards yet.</p>}
        </section>

        <aside className="panel">
          <h2 className="section-title">Members ({members.length})</h2>
          <ul className="members">
            {members.map((m) => (
              <li key={m.id}>
                <Avatar name={m.displayName} color={m.avatarColor} />
                <div className="member-info">
                  <span>
                    {m.displayName}
                    {m.id === me.id && <span className="muted"> (you)</span>}
                  </span>
                  <span className="muted small">{m.email}</span>
                </div>
                {isOwner && m.id !== me.id ? (
                  <select
                    value={m.role}
                    onChange={(e) => changeRole.mutate({ userId: m.id, role: e.target.value as Role })}
                    aria-label={`Role of ${m.displayName}`}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="badge">{ROLE_LABEL[m.role]}</span>
                )}
                {(isOwner || m.id === me.id) && (
                  <button
                    className="btn btn-ghost btn-sm"
                    title={m.id === me.id ? "Leave workspace" : "Remove from workspace"}
                    onClick={() => {
                      const q = m.id === me.id ? "Leave this workspace?" : `Remove ${m.displayName} from the workspace?`;
                      if (confirm(q)) removeMember.mutate(m.id);
                    }}
                  >
                    {m.id === me.id ? "Leave" : "Remove"}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {isOwner && <InvitePanel workspaceId={workspaceId} />}
        </aside>
      </div>
    </div>
  );
}

function InvitePanel({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [link, setLink] = useState<string | null>(null);

  const invitations = useQuery({
    queryKey: ["invitations", workspaceId],
    queryFn: () => api<Invitation[]>(`/workspaces/${workspaceId}/invitations`),
  });
  const create = useMutation({
    mutationFn: () =>
      api<{ token: string }>(`/workspaces/${workspaceId}/invitations`, { method: "POST", body: { role } }),
    onSuccess: ({ token }) => {
      setLink(`${location.origin}/invite/${token}`);
      qc.invalidateQueries({ queryKey: ["invitations", workspaceId] });
    },
    onError: (err) => toast({ message: errorMessage(err), tone: "error" }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/invitations/${id}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["invitations", workspaceId] }),
  });

  return (
    <div className="invite">
      <h3 className="section-title">Invite people</h3>
      <div className="row">
        <select value={role} onChange={(e) => setRole(e.target.value as "editor" | "viewer")} aria-label="Role">
          <option value="editor">{ROLE_LABEL.editor}</option>
          <option value="viewer">{ROLE_LABEL.viewer}</option>
        </select>
        <button className="btn btn-primary btn-sm" onClick={() => create.mutate()} disabled={create.isPending}>
          Create invite link
        </button>
      </div>
      {link && (
        <div className="invite-link">
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <button
            className="btn btn-sm"
            onClick={() => navigator.clipboard.writeText(link).then(() => toast({ message: "Link copied" }))}
          >
            Copy
          </button>
          <p className="muted small">This link is shown only once and expires in 7 days.</p>
        </div>
      )}
      {!!invitations.data?.length && (
        <ul className="invites">
          {invitations.data.map((i) => (
            <li key={i.id}>
              <span>
                {ROLE_LABEL[i.role]} · expires {formatDate(i.expiresAt)}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => revoke.mutate(i.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
