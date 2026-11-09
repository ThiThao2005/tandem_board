import type { Card, Member } from "@tandem/shared";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties, HTMLAttributes } from "react";
import { formatDue } from "../format";
import { Avatar } from "./Avatar";

/** Mặt thẻ: dùng cho thẻ trong cột và cho bản sao đi theo con trỏ khi kéo. */
export function CardFace(
  props: { card: Card; assignee?: Member; overlay?: boolean } & HTMLAttributes<HTMLDivElement>,
) {
  const { card, assignee, overlay, className, ...rest } = props;
  const due = card.dueDate ? formatDue(card.dueDate) : null;
  return (
    <div className={`card ${overlay ? "is-overlay" : ""} ${className ?? ""}`} {...rest}>
      <span className="card-title">{card.title}</span>
      {(due || assignee) && (
        <span className="card-meta">
          {due && <span className={`chip ${due.overdue ? "chip-overdue" : ""}`}>⏱ {due.label}</span>}
          {assignee && <Avatar name={assignee.displayName} color={assignee.avatarColor} size={22} />}
        </span>
      )}
    </div>
  );
}

/**
 * Thẻ kéo được. Chuột: nhấn giữ rồi kéo quá 6px mới tính là kéo, nên bấm vẫn mở thẻ.
 * Bàn phím: Tab tới thẻ, Space để nhấc, mũi tên để dời, Space/Enter để thả, Esc để hủy.
 * Enter khi không kéo thì mở thẻ.
 */
export function SortableCard(props: { card: Card; assignee?: Member; canEdit: boolean; onOpen: (id: string) => void }) {
  const { card, assignee, canEdit, onOpen } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    disabled: !canEdit,
  });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };

  return (
    <li ref={setNodeRef} style={style} className={isDragging ? "card-slot is-placeholder" : "card-slot"}>
      <CardFace
        card={card}
        assignee={assignee}
        {...attributes}
        {...listeners}
        role="button"
        tabIndex={0}
        aria-label={card.title}
        onClick={() => onOpen(card.id)}
        onKeyDown={(e) => {
          listeners?.onKeyDown?.(e);
          if (e.key === "Enter" && !isDragging && !e.defaultPrevented) onOpen(card.id);
        }}
      />
    </li>
  );
}
