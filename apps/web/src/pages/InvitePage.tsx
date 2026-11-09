import { ROLE_LABEL, type InvitationPreview } from "@tandem/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { api, errorMessage } from "../api";

export function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => api<InvitationPreview>(`/invitations/token/${encodeURIComponent(token)}`),
  });
  const accept = useMutation({
    mutationFn: () =>
      api<{ workspaceId: string }>(`/invitations/token/${encodeURIComponent(token)}/accept`, { method: "POST" }),
    onSuccess: ({ workspaceId }) => {
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      navigate(`/w/${workspaceId}`, { replace: true });
    },
  });

  if (preview.data?.alreadyMember) return <Navigate to={`/w/${preview.data.workspaceId}`} replace />;

  return (
    <div className="page page-narrow">
      <div className="panel center">
        {preview.isPending && <p className="muted">Checking invitation…</p>}
        {preview.error && (
          <>
            <p className="form-error">{errorMessage(preview.error)}</p>
            <Link to="/">Go to home</Link>
          </>
        )}
        {preview.data && (
          <>
            <p className="muted">{preview.data.invitedBy ?? "Someone"} invited you to join</p>
            <h1 className="page-title">{preview.data.workspaceName}</h1>
            <p>
              Role: <strong>{ROLE_LABEL[preview.data.role]}</strong>
            </p>
            {accept.error && <p className="form-error">{errorMessage(accept.error)}</p>}
            <button className="btn btn-primary" onClick={() => accept.mutate()} disabled={accept.isPending}>
              Join workspace
            </button>
          </>
        )}
      </div>
    </div>
  );
}
