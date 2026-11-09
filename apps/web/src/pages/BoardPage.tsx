import type { BoardSnapshot, Card, Column, Member } from "@tandem/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router";
import { api, ApiError, errorMessage } from "../api";
import { Avatar } from "../components/Avatar";
import { CardDialog } from "../components/CardDialog";
import { InlineEdit } from "../components/InlineEdit";
import { formatDue } from "../format";
import { toneAt, toneVars, type Tone } from "../palette";
import { useToast } from "../toast";

/**
 * Tuần 1 chưa có realtime: mỗi thao tác gọi REST rồi tải lại ảnh chụp bảng.
 * Tuần 3 sẽ thay bằng thao tác qua WebSocket + cập nhật lạc quan.
 */
export function useBoardActions(boardId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const reload = () => qc.invalidateQueries({ queryKey: ["board", boardId] });

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError && err.code === "card_deleted") {
        const cardId = (err.details as { cardId?: string } | undefined)?.cardId;
        toast({
          message: `${err.message}.`,
          tone: "error",
          action: cardId ? { label: "Restore", run: () => void restore(cardId) } : undefined,
        });
      } else if (err instanceof ApiError && err.code === "version_conflict") {
        toast({ message: "Someone else just edited this card. Loaded the latest version.", tone: "error" });
      } else {
        toast({ message: errorMessage(err), tone: "error" });
      }
      return undefined;
    } finally {
      await reload();
    }
  }

  const restore = (cardId: string) => run(() => api<Card>(`/cards/${cardId}/restore`, { method: "POST" }));

  return {
    renameBoard: (title: string) => run(() => api(`/boards/${boardId}`, { method: "PATCH", body: { title } })),
    addColumn: (title: string) => run(() => api(`/boards/${boardId}/columns`, { method: "POST", body: { title } })),
    renameColumn: (id: string, title: string) => run(() => api(`/columns/${id}`, { method: "PATCH", body: { title } })),
    deleteColumn: (id: string) => run(() => api(`/columns/${id}`, { method: "DELETE" })),
    addCard: (columnId: string, title: string) =>
      run(() => api(`/columns/${columnId}/cards`, { method: "POST", body: { id: crypto.randomUUID(), title } })),
    updateCard: (card: Card, patch: Record<string, unknown>) =>
      run(() =>
        api<Card>(`/cards/${card.id}`, { method: "PATCH", body: { ...patch, baseVersion: card.version } }).catch((err) => {
          // Gắn id thẻ vào lỗi để nút "Khôi phục" biết thẻ nào.
          if (err instanceof ApiError && err.code === "card_deleted") err.details = { cardId: card.id };
          throw err;
        }),
      ),
    deleteCard: async (card: Card) => {
      const ok = await run(() => api<Card>(`/cards/${card.id}`, { method: "DELETE" }));
      if (ok) toast({ message: `Deleted “${card.title}”`, action: { label: "Undo", run: () => void restore(card.id) } });
    },
  };
}

export function BoardPage() {
  const { boardId = "" } = useParams();
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const board = useQuery({
    queryKey: ["board", boardId],
    queryFn: () => api<BoardSnapshot>(`/boards/${boardId}`),
  });
  const actions = useBoardActions(boardId);

  if (board.error) return <div className="page"><p className="form-error">{errorMessage(board.error)}</p></div>;
  if (!board.data) return <div className="page muted">Loading board…</div>;

  const { columns, cards, members, role } = board.data;
  const canEdit = role !== "viewer";
  const memberById = new Map(members.map((m) => [m.id, m]));
  const openCard = cards.find((c) => c.id === openCardId) ?? null;

  return (
    <div className="board-page">
      <div className="board-header">
        <nav className="crumbs">
          <Link to={`/w/${board.data.board.workspaceId}`}>← Back to workspace</Link>
        </nav>
        <InlineEdit
          className="board-title"
          value={board.data.board.title}
          disabled={!canEdit}
          maxLength={120}
          onSave={actions.renameBoard}
        />
        <div className="avatars">
          {members.map((m) => (
            <Avatar key={m.id} name={m.displayName} color={m.avatarColor} />
          ))}
        </div>
        {!canEdit && <span className="badge">View only</span>}
      </div>

      <div className="lanes">
        {columns.map((col, index) => (
          <Lane
            key={col.id}
            column={col}
            tone={toneAt(index)}
            cards={cards.filter((c) => c.columnId === col.id)}
            memberById={memberById}
            canEdit={canEdit}
            actions={actions}
            onOpen={setOpenCardId}
          />
        ))}
        {canEdit && <NewLane onAdd={actions.addColumn} />}
      </div>

      {openCard && (
        <CardDialog
          card={openCard}
          columns={columns}
          tone={toneAt(Math.max(0, columns.findIndex((c) => c.id === openCard.columnId)))}
          members={members}
          canEdit={canEdit}
          actions={actions}
          onClose={() => setOpenCardId(null)}
        />
      )}
    </div>
  );
}

type Actions = ReturnType<typeof useBoardActions>;

function Lane(props: {
  column: Column;
  tone: Tone;
  cards: Card[];
  memberById: Map<string, Member>;
  canEdit: boolean;
  actions: Actions;
  onOpen: (id: string) => void;
}) {
  const { column, tone, cards, memberById, canEdit, actions, onOpen } = props;
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  async function submit() {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    await actions.addCard(column.id, title);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      setAdding(false);
      setDraft("");
    }
  }

  return (
    <section className="lane" aria-label={column.title} style={toneVars(tone) as CSSProperties}>
      <header className="lane-header">
        <span className="lane-dot" aria-hidden />
        <InlineEdit
          className="lane-title"
          value={column.title}
          disabled={!canEdit}
          maxLength={80}
          onSave={(t) => actions.renameColumn(column.id, t)}
        />
        <span className="lane-count">{cards.length}</span>
        {canEdit && (
          <button
            className="icon-btn"
            title="Delete column"
            aria-label={`Delete column ${column.title}`}
            onClick={() => confirm(`Delete column “${column.title}”?`) && actions.deleteColumn(column.id)}
          >
            ×
          </button>
        )}
      </header>

      <ol className="lane-cards">
        {cards.map((card) => {
          const assignee = card.assigneeId ? memberById.get(card.assigneeId) : undefined;
          const due = card.dueDate ? formatDue(card.dueDate) : null;
          return (
            <li key={card.id}>
              <button className="card" onClick={() => onOpen(card.id)}>
                <span className="card-title">{card.title}</span>
                {(due || assignee) && (
                  <span className="card-meta">
                    {due && <span className={`chip ${due.overdue ? "chip-overdue" : ""}`}>⏱ {due.label}</span>}
                    {assignee && <Avatar name={assignee.displayName} color={assignee.avatarColor} size={22} />}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>

      {canEdit &&
        (adding ? (
          <div className="lane-add">
            <textarea
              autoFocus
              rows={2}
              placeholder="Card title… (press Enter to add)"
              value={draft}
              maxLength={500}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <div className="row">
              <button className="btn btn-primary btn-sm" onClick={() => void submit()} disabled={!draft.trim()}>
                Add card
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <button className="lane-add-btn" onClick={() => setAdding(true)}>
            + Add a card
          </button>
        ))}
    </section>
  );
}

function NewLane({ onAdd }: { onAdd: (title: string) => Promise<unknown> }) {
  const [title, setTitle] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await onAdd(title.trim());
    setTitle("");
  }
  return (
    <form className="lane lane-new" onSubmit={submit}>
      <input placeholder="+ Add a column" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
      {title.trim() && <button className="btn btn-primary btn-sm">Add</button>}
    </form>
  );
}
