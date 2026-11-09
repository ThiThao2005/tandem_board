import type { Card, Column, Member } from "@tandem/shared";
import { useEffect, useRef, type CSSProperties } from "react";
import type { CardPatch, useBoardActions } from "../pages/BoardPage";
import { toneVars, type Tone } from "../palette";
import { InlineEdit } from "./InlineEdit";

export function CardDialog(props: {
  card: Card;
  columns: Column[];
  tone: Tone;
  members: Member[];
  canEdit: boolean;
  actions: ReturnType<typeof useBoardActions>;
  onClose: () => void;
}) {
  const { card, columns, tone, members, canEdit, actions, onClose } = props;
  const ref = useRef<HTMLDialogElement>(null);

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

        <div className="dialog-note muted small">Collaborative notes are coming in week 5.</div>

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
