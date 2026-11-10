import type { Card, Column, Member, User } from "@tandem/shared";
import { lazy, Suspense, useEffect, useRef, type CSSProperties } from "react";
import type { CardPatch, useBoardActions } from "../pages/BoardPage";
import { toneVars, type Tone } from "../palette";
import type { BoardSync } from "../sync/boardSync";
import { useNote } from "../sync/useNote";
import { Avatar } from "./Avatar";
import { InlineEdit } from "./InlineEdit";
import { joinNames, type Editor } from "./SortableCard";

// TipTap + ProseMirror nặng (~700 KB): chỉ tải khi mở thẻ lần đầu, bảng vẫn mở nhanh.
const NoteEditor = lazy(() => import("./NoteEditor").then((m) => ({ default: m.NoteEditor })));

export function CardDialog(props: {
  card: Card;
  columns: Column[];
  tone: Tone;
  members: Member[];
  /** Người khác cũng đang mở thẻ này (tuần 4). */
  others: Editor[];
  canEdit: boolean;
  actions: ReturnType<typeof useBoardActions>;
  /** Đồng bộ của bảng: ghi chú (tuần 5) dùng chung kết nối với bảng. */
  sync: BoardSync | null;
  me: User;
  onClose: () => void;
}) {
  const { card, columns, tone, members, others, canEdit, actions, sync, me, onClose } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const { note, state: noteState } = useNote(sync, card.id, { id: me.id, name: me.displayName, color: me.avatarColor });

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const update = (patch: CardPatch) => actions.updateCard(card, patch);

  return (
    <dialog
      ref={ref}
      className="dialog"
      style={toneVars(tone) as CSSProperties}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current?.close()}
    >
      <div className="dialog-band" aria-hidden />
      <div className="dialog-body">
        <div className="dialog-head">
          <InlineEdit
            className="dialog-title"
            value={card.title}
            disabled={!canEdit}
            maxLength={500}
            onSave={(title) => update({ title })}
          />
          <button className="icon-btn" aria-label="Close" onClick={() => ref.current?.close()}>
            ×
          </button>
        </div>

        {/* Luôn có phần tử (kể cả khi trống) để trình đọc màn hình đọc khi có người mở/đóng thẻ. */}
        <div className={`dialog-presence ${others.length > 0 ? "has-others" : ""}`} role="status" aria-live="polite">
          {others.length > 0 && (
            <>
              <span className="avatars-inline" aria-hidden>
                {others.map((e) => (
                  <Avatar key={e.member.id} name={e.member.displayName} color={e.member.avatarColor} size={22} />
                ))}
              </span>
              <span>
                {joinNames(others)} {others.length === 1 ? "is" : "are"} also editing this card
                {others.every((e) => e.away) ? " (away)" : ""}.
              </span>
              {others.some((e) => e.typing) && <span className="typing-pill">typing in notes</span>}
            </>
          )}
        </div>

        <div className="dialog-fields">
          <label className="field">
            <span>Column</span>
            <select
              value={card.columnId}
              disabled={!canEdit}
              onChange={(e) => update({ columnId: e.target.value })}
            >
              {columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Assignee</span>
            <select
              value={card.assigneeId ?? ""}
              disabled={!canEdit}
              onChange={(e) => update({ assigneeId: e.target.value || null })}
            >
              <option value="">— Unassigned —</option>
              {members
                .filter((m) => m.role !== "viewer" || m.id === card.assigneeId)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>Due date</span>
            <input
              type="date"
              value={card.dueDate ?? ""}
              disabled={!canEdit}
              onChange={(e) => update({ dueDate: e.target.value || null })}
            />
          </label>
        </div>

        <section className="dialog-notes" aria-label="Notes">
          <div className="dialog-notes-head">
            <h3>Notes</h3>
            {card.note && card.note.total > 0 && <ChecklistProgress done={card.note.done} total={card.note.total} />}
          </div>
          {note ? (
            <Suspense fallback={<div className="note note-loading muted small">Loading editor…</div>}>
              <NoteEditor note={note} state={noteState} canEdit={canEdit} onEscape={() => ref.current?.close()} />
            </Suspense>
          ) : (
            <div className="note note-loading muted small">Loading notes…</div>
          )}
        </section>

        {canEdit && (
          <div className="dialog-foot">
            <span className="muted small">Version {card.version}</span>
            <button
              className="btn btn-danger btn-sm"
              onClick={() => {
                ref.current?.close();
                void actions.deleteCard(card);
              }}
            >
              Delete card
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}

/** Thanh tiến độ checklist: "2/5" + vạch đầy dần, xanh khi xong hết. */
export function ChecklistProgress({ done, total, compact = false }: { done: number; total: number; compact?: boolean }) {
  const complete = total > 0 && done === total;
  return (
    <span
      className={`checklist-progress ${complete ? "is-complete" : ""} ${compact ? "is-compact" : ""}`}
      title={`${done} of ${total} checklist items done`}
      aria-label={`${done} of ${total} checklist items done`}
    >
      <span className="checklist-icon" aria-hidden>
        ☑
      </span>
      {done}/{total}
      {!compact && (
        <span className="checklist-bar" aria-hidden>
          <span style={{ width: `${(done / total) * 100}%` }} />
        </span>
      )}
    </span>
  );
}
