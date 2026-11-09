import { ROLE_LABEL, type WorkspaceSummary } from "@tandem/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties, type FormEvent } from "react";
import { Link } from "react-router";
import { api, errorMessage } from "../api";
import { plural } from "../format";
import { toneFor, toneVars } from "../palette";
import { useToast } from "../toast";

export function HomePage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => api<WorkspaceSummary[]>("/workspaces") });

  const create = useMutation({
    mutationFn: (n: string) => api<WorkspaceSummary>("/workspaces", { method: "POST", body: { name: n } }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (err) => toast({ message: errorMessage(err), tone: "error" }),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  }

  return (
    <div className="page">
      <h1 className="page-title">Your workspaces</h1>
      <p className="page-sub">Pick a workspace to open its boards, or create a new one for your next project.</p>
      {workspaces.isPending && <p className="muted">Loading…</p>}
      {workspaces.error && <p className="form-error">{errorMessage(workspaces.error)}</p>}
      <div className="grid">
        {workspaces.data?.map((w) => (
          <Link
            key={w.id}
            to={`/w/${w.id}`}
            className="tile tile-toned"
            style={toneVars(toneFor(w.id)) as CSSProperties}
          >
            <span className="tile-title">{w.name}</span>
            <span className="tile-meta">
              <span className="badge">{ROLE_LABEL[w.role]}</span>
              {plural(w.memberCount, "member")}
            </span>
          </Link>
        ))}
        <form className="tile tile-new" onSubmit={onSubmit}>
          <input placeholder="New workspace name…" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <button className="btn btn-primary btn-sm" disabled={!name.trim() || create.isPending}>
            Create workspace
          </button>
        </form>
      </div>
    </div>
  );
}
