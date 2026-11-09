import type { Card, Member } from "@tandem/shared";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties, HTMLAttributes } from "react";
import { formatDue } from "../format";
import { Avatar } from "./Avatar";

/** Một người khác đang mở thẻ để sửa (tuần 4). */
export interface Editor {
  member: Member;
  /** Tab của người đó đang bị ẩn. */
  away: boolean;
}

/** "Bình", "Bình and An", "Bình, An and Chi" */
export function joinNames(editors: Editor[]): string {
  const names = editors.map((e) => e.member.displayName);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Mặt thẻ: dùng cho thẻ trong cột và cho bản sao đi theo con trỏ khi kéo. */
export function CardFace(
  props: { card: Card; assignee?: Member; editors?: Editor[]; overlay?: boolean } & HTMLAttributes<HTMLDivElement>,
) {
  const { card, assignee, editors = [], overlay, className, style, ...rest } = props;
  const due = card.dueDate ? formatDue(card.dueDate) : null;
  const editing = editors.length > 0;
  // Viền theo màu của người đang sửa; tất cả đều đang ẩn tab thì viền đứt nét.
  const editingStyle = editing ? ({ "--editor-color": editors[0]!.member.avatarColor } as CSSProperties) : undefined;
  const allAway = editing && editors.every((e) => e.away);
  return (
    <div
      className={`card ${overlay ? "is-overlay" : ""} ${editing ? "is-being-edited" : ""} ${allAway ? "is-editor-away" : ""} ${className ?? ""}`}
      style={{ ...editingStyle, ...style }}
      {...rest}
    >
      {editing && (
        <span className="card-editors" aria-hidden>
          {editors.map((e) => (
            <Avatar key={e.member.id} name={e.member.displayName} color={e.member.avatarColor} size={22} />
          ))}
        </span>
      )}
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
export function SortableCard(props: {
  card: Card;
  assignee?: Member;
  editors?: Editor[];
  canEdit: boolean;
  onOpen: (id: string) => void;
}) {
  const { card, assignee, editors = [], canEdit, onOpen } = props;
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
        editors={editors}
        {...attributes}
        {...listeners}
        role="button"
        tabIndex={0}
        aria-label={editors.length > 0 ? `${card.title} (${joinNames(editors)} editing)` : card.title}
        onClick={() => onOpen(card.id)}
        onKeyDown={(e) => {
          listeners?.onKeyDown?.(e);
          if (e.key === "Enter" && !isDragging && !e.defaultPrevented) onOpen(card.id);
        }}
      />
    </li>
  );
}
