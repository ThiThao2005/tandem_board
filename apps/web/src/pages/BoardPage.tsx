import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { comparePositioned, type Card, type Column, type Member, type OpRequest, type PresenceUser } from "@tandem/shared";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router";
import { useMe } from "../auth";
import { Avatar } from "../components/Avatar";
import { CardDialog } from "../components/CardDialog";
import { InlineEdit } from "../components/InlineEdit";
import { CardFace, SortableCard, type Editor } from "../components/SortableCard";
import { toneAt, toneVars, type Tone } from "../palette";
import type { BoardSync, SyncStatus } from "../sync/boardSync";
import { useBoardSync } from "../sync/useBoardSync";
import { useToast } from "../toast";

/** Ý định khi thả thẻ: nằm ở cột nào, sau thẻ nào, trước thẻ nào. */
export interface MoveIntent {
  columnId: string;
  afterCardId: string | null;
  beforeCardId: string | null;
}

export type CardPatch = Partial<Pick<Card, "title" | "dueDate" | "assigneeId" | "columnId">>;

const FIELD_LABEL: Record<string, string> = {
  title: "title",
  dueDate: "due date",
  assigneeId: "assignee",
  columnId: "column",
};

/**
 * Mọi thay đổi đi qua WebSocket dưới dạng thao tác (op): hiện ngay trên màn hình (lạc quan), server
 * quyết định rồi phát cho mọi người. Server từ chối thì bảng tự về đúng trạng thái và hiện thông báo.
 */
export function useBoardActions(sync: BoardSync | null, boardId: string) {
  const toast = useToast();
  const submit = (req: OpRequest, ctx?: Parameters<BoardSync["submit"]>[1]) => sync?.submit(req, ctx);
  const opId = () => crypto.randomUUID();

  const restore = (cardId: string, card?: Card) =>
    submit({ opId: opId(), type: "card.restore", payload: { cardId } }, { restoreCard: card });

  return {
    restore,
    renameBoard: (title: string) => submit({ opId: opId(), type: "board.update", payload: { boardId, title } }),
    addColumn: (title: string) =>
      submit({ opId: opId(), type: "column.create", payload: { boardId, id: crypto.randomUUID(), title } }),
    renameColumn: (columnId: string, title: string) =>
      submit({ opId: opId(), type: "column.update", payload: { columnId, title } }),
    deleteColumn: (columnId: string) => submit({ opId: opId(), type: "column.delete", payload: { columnId } }),
    addCard: (columnId: string, title: string) =>
      submit({ opId: opId(), type: "card.create", payload: { columnId, id: crypto.randomUUID(), title } }),
    /** `force` = bỏ baseVersion, tức ghi đè (nút "Use mine" sau khi xung đột). */
    updateCard: (card: Card, patch: CardPatch, force = false) =>
      submit({
        opId: opId(),
        type: "card.update",
        payload: { ...patch, cardId: card.id, ...(force ? {} : { baseVersion: card.version }) },
      }),
    /** Vị trí lạc quan do optimisticUpdate tự tính từ ý định; server vẫn tính lại từ hàng xóm hiện tại. */
    moveCard: (card: Card, intent: MoveIntent) =>
      submit({ opId: opId(), type: "card.move", payload: { cardId: card.id, ...intent } }),
    deleteCard: (card: Card) => {
      submit({ opId: opId(), type: "card.delete", payload: { cardId: card.id } });
      toast({ message: `Deleted “${card.title}”`, action: { label: "Undo", run: () => restore(card.id, card) } });
    },
  };
}

/** Thứ tự thẻ theo từng cột: columnId → danh sách id thẻ. */
type Order = Record<string, string[]>;

function columnOf(order: Order, id: UniqueIdentifier): string | undefined {
  const key = String(id);
  if (key in order) return key; // id của chính cột (thả vào vùng trống của cột)
  return Object.keys(order).find((col) => order[col]!.includes(key));
}

/** Người KHÁC đang mở từng thẻ để sửa: cardId → danh sách người. Người chưa có trong danh sách thành viên thì bỏ qua. */
function editorsByCard(presence: PresenceUser[], memberById: Map<string, Member>, meId: string): Map<string, Editor[]> {
  const result = new Map<string, Editor[]>();
  for (const p of presence) {
    const member = memberById.get(p.userId);
    if (!p.cardId || p.userId === meId || !member) continue;
    const list = result.get(p.cardId) ?? [];
    list.push({ member, away: p.status === "away", typing: p.typing });
    result.set(p.cardId, list);
  }
  return result;
}

export function BoardPage() {
  const { boardId = "" } = useParams();
  const me = useMe();
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const toast = useToast();
  const openCardRef = useRef(openCardId);
  openCardRef.current = openCardId;
  // Các hàm xử lý sự kiện bên dưới cần actions và danh sách thành viên mới nhất.
  const actionsRef = useRef<Actions | null>(null);
  const membersRef = useRef<Member[]>([]);

  const { sync, state } = useBoardSync(boardId, {
    onRejected: (req, err) => {
      const actions = actionsRef.current;
      if (err.code === "card_deleted") {
        const cardId = (err.details as { cardId?: string } | undefined)?.cardId;
        toast({
          message: `${err.message}. Your change wasn't saved.`,
          tone: "error",
          action: cardId && actions ? { label: "Restore", run: () => actions.restore(cardId) } : undefined,
        });
      } else if (err.code === "version_conflict" && req.type === "card.update") {
        const { fields = [], card } = (err.details ?? {}) as { fields?: string[]; card?: Card };
        const { cardId: _id, baseVersion: _v, ...patch } = req.payload;
        const what = fields.map((f) => FIELD_LABEL[f] ?? f).join(" and ") || "card";
        toast({
          message: `Someone else just changed the ${what}${card ? ` of “${card.title}”` : ""}. Your change wasn't saved.`,
          tone: "error",
          action: card && actions ? { label: "Use mine", run: () => actions.updateCard(card, patch, true) } : undefined,
        });
      } else {
        toast({ message: err.message, tone: "error" });
      }
    },
    onNoteRejected: (_cardId, err) => {
      const message =
        err.code === "forbidden"
          ? "You can only view these notes now. Your latest note changes weren't saved."
          : err.code === "note_too_large"
            ? "This note is too long. Your latest change wasn't saved."
            : `${err.message}. Your latest note changes weren't saved.`;
      toast({ message, tone: "error" });
    },
    onRemoteOp: (op) => {
      // Thẻ đang mở bị người khác xóa: hộp thoại tự đóng (thẻ biến mất), báo ai xóa và cho khôi phục.
      if (op.type === "card.delete" && op.payload.card.id === openCardRef.current) {
        const who = membersRef.current.find((m) => m.id === op.actorId)?.displayName ?? "Someone";
        const card = op.payload.card;
        toast({
          message: `${who} deleted “${card.title}”.`,
          tone: "error",
          action: { label: "Restore", run: () => actionsRef.current?.restore(card.id, card) },
        });
      }
    },
  });
  const actions = useBoardActions(sync, boardId);
  actionsRef.current = actions;
  membersRef.current = state.board?.members ?? [];
  const view = state.board;
  const canEdit = view ? view.role !== "viewer" : false;

  // Mở thẻ (khi có quyền sửa) thì báo cho người khác để thẻ được tô viền bên họ.
  useEffect(() => {
    sync?.setPresence({ cardId: canEdit ? openCardId : null });
  }, [sync, openCardId, canEdit]);

  /** Trong lúc kéo: thứ tự tạm thời (thẻ đã "nhảy" sang cột đang rê qua). */
  const [drag, setDrag] = useState<{ activeId: string; order: Order } | null>(null);

  const columns = view?.columns;
  const cards = view?.cards;
  const cardById = useMemo(() => new Map((cards ?? []).map((k) => [k.id, k])), [cards]);

  // Thẻ đang mở biến khỏi bảng (mình hoặc người khác xóa): quên luôn, để khi được khôi phục thì
  // hộp thoại không tự bật lại. Hộp thoại bị gỡ trước khi sự kiện "close" kịp chạy nên phải làm ở đây.
  useEffect(() => {
    if (openCardId && cards && !cards.some((k) => k.id === openCardId)) setOpenCardId(null);
  }, [openCardId, cards]);
  const savedOrder = useMemo<Order>(() => {
    const order: Order = {};
    for (const col of columns ?? []) order[col.id] = [];
    // Cập nhật lạc quan chỉ đổi vị trí chứ không xếp lại mảng, nên phải sắp xếp ở đây.
    for (const k of [...(cards ?? [])].sort(comparePositioned)) order[k.columnId]?.push(k.id);
    return order;
  }, [columns, cards]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Màn hình cảm ứng: nhấn giữ 200ms mới kéo, để vuốt vẫn cuộn được trang.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  if (state.status === "gone") {
    return (
      <div className="page">
        <p className="form-error">{state.error}</p>
        <Link to="/">← Back to your workspaces</Link>
      </div>
    );
  }
  if (!view) return <div className="page muted">Connecting to the board…</div>;

  const { members } = view;
  const memberById = new Map(members.map((m) => [m.id, m]));
  const editing = editorsByCard(state.presence, memberById, me.id);
  const openCard = view.cards.find((c) => c.id === openCardId) ?? null;
  const order = drag?.order ?? savedOrder;
  const columnTitle = (id: string | undefined) => view.columns.find((c) => c.id === id)?.title ?? "a column";
  const activeCard = drag ? cardById.get(drag.activeId) : undefined;
  /** Cột mà thẻ đang kéo sẽ rơi vào nếu thả ngay bây giờ. */
  const targetColumn = drag ? columnOf(order, drag.activeId) : undefined;
  const activeTone = toneAt(Math.max(0, view.columns.findIndex((c) => c.id === targetColumn)));

  function onDragStart({ active }: DragStartEvent) {
    setDrag({ activeId: String(active.id), order: savedOrder });
  }

  /** Rê sang cột khác: chuyển thẻ sang danh sách của cột đó ngay, để các thẻ kia dạt ra chừa chỗ. */
  function onDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    // Đọc kích thước ngay bây giờ, không đọc trong hàm cập nhật state (React có thể gọi nó muộn hơn).
    const dragged = active.rect.current.translated;
    const below = dragged !== null && dragged.top > over.rect.top + over.rect.height / 2;
    setDrag((d) => {
      if (!d) return d;
      const from = columnOf(d.order, active.id);
      const to = columnOf(d.order, over.id);
      if (!from || !to || from === to) return d;
      const target = d.order[to]!;
      const overIndex = target.indexOf(String(over.id));
      // Rê vào vùng trống của cột → cuối cột; rê lên một thẻ → trên hoặc dưới thẻ đó.
      const index = overIndex >= 0 ? overIndex + (below ? 1 : 0) : target.length;
      return {
        ...d,
        order: {
          ...d.order,
          [from]: d.order[from]!.filter((id) => id !== d.activeId),
          [to]: [...target.slice(0, index), d.activeId, ...target.slice(index)],
        },
      };
    });
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    const current = drag;
    if (!current || !over) {
      setDrag(null);
      return;
    }
    let order = current.order;
    const col = columnOf(order, active.id);
    // Kéo trong cùng một cột: chỉ lúc thả mới đổi thứ tự.
    if (col && col === columnOf(order, over.id) && String(over.id) !== col) {
      const items = order[col]!;
      order = { ...order, [col]: arrayMove(items, items.indexOf(current.activeId), items.indexOf(String(over.id))) };
    }

    const card = cardById.get(current.activeId);
    if (!col || !card) {
      setDrag(null);
      return;
    }
    const items = order[col]!;
    const index = items.indexOf(card.id);
    const intent: MoveIntent = { columnId: col, afterCardId: items[index - 1] ?? null, beforeCardId: items[index + 1] ?? null };

    // Thả về đúng chỗ cũ thì không gửi gì.
    const before = savedOrder[card.columnId] ?? [];
    const oldIndex = before.indexOf(card.id);
    if (
      col === card.columnId &&
      intent.afterCardId === (before[oldIndex - 1] ?? null) &&
      intent.beforeCardId === (before[oldIndex + 1] ?? null)
    ) {
      setDrag(null);
      return;
    }

    // Ghi thao tác (kèm cập nhật lạc quan) CÙNG LÚC với bỏ trạng thái kéo, để thẻ không nháy về chỗ cũ.
    actions.moveCard(card, intent);
    setDrag(null);
  }

  /** Lời đọc cho trình đọc màn hình (mặc định của dnd-kit đọc id, không đọc tên thẻ). */
  const title = (id: UniqueIdentifier) => cardById.get(String(id))?.title ?? "card";
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up “${title(active.id)}”.`,
    onDragOver: ({ active, over }) =>
      over ? `“${title(active.id)}” is over ${columnTitle(columnOf(order, over.id))}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over ? `Dropped “${title(active.id)}” in ${columnTitle(columnOf(order, over.id))}.` : `Dropped “${title(active.id)}”.`,
    onDragCancel: ({ active }) => `Cancelled. “${title(active.id)}” is back where it was.`,
  };

  return (
    <div className="board-page">
      <div className="board-header">
        <nav className="crumbs">
          <Link to={`/w/${view.board.workspaceId}`}>← Back to workspace</Link>
        </nav>
        <InlineEdit
          className="board-title"
          value={view.board.title}
          disabled={!canEdit}
          maxLength={120}
          onSave={actions.renameBoard}
        />
        <PresenceBar members={members} presence={state.presence} meId={me.id} connected={state.status === "live"} />
        {!canEdit && <span className="badge">View only</span>}
        <SyncBadge status={state.status} pending={state.pending} />
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDrag(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable: "To move a card, press Space. Use the arrow keys to move it, Space to drop, Escape to cancel.",
          },
        }}
      >
        <div className="lanes">
          {view.columns.map((col, index) => (
            <Lane
              key={col.id}
              column={col}
              tone={toneAt(index)}
              // `order` chụp lúc bắt đầu kéo: cột vừa được thêm trong lúc kéo (tuần 3: người khác thêm
              // qua realtime) chưa có trong đó, nên dùng thứ tự đã lưu thay vì làm sập trang.
              cards={(order[col.id] ?? savedOrder[col.id] ?? []).flatMap((id) => cardById.get(id) ?? [])}
              isDropTarget={targetColumn === col.id}
              memberById={memberById}
              editing={editing}
              canEdit={canEdit}
              actions={actions}
              onOpen={setOpenCardId}
            />
          ))}
          {canEdit && <NewLane onAdd={actions.addColumn} />}
        </div>
        <DragOverlay dropAnimation={{ duration: 160, easing: "ease-out" }}>
          {activeCard && (
            <CardFace
              card={activeCard}
              assignee={activeCard.assigneeId ? memberById.get(activeCard.assigneeId) : undefined}
              editors={editing.get(activeCard.id)}
              overlay
              style={toneVars(activeTone) as CSSProperties}
            />
          )}
        </DragOverlay>
      </DndContext>

      {openCard && (
        <CardDialog
          card={openCard}
          columns={view.columns}
          tone={toneAt(Math.max(0, view.columns.findIndex((c) => c.id === openCard.columnId)))}
          members={members}
          others={editing.get(openCard.id) ?? []}
          canEdit={canEdit}
          actions={actions}
          sync={sync}
          me={me}
          onClose={() => setOpenCardId(null)}
        />
      )}
    </div>
  );
}

type Actions = ReturnType<typeof useBoardActions>;

/**
 * Dãy avatar thành viên: ai đang mở bảng thì sáng và có chấm (xanh = đang xem, vàng = tab đang ẩn),
 * ai không mở thì mờ. Người đang online đứng trước, theo thứ tự vào bảng.
 */
function PresenceBar(props: { members: Member[]; presence: PresenceUser[]; meId: string; connected: boolean }) {
  const { members, presence, meId, connected } = props;
  const byUser = new Map(presence.map((p, i) => [p.userId, { ...p, index: i }]));
  const statusOf = (id: string) => {
    const p = byUser.get(id);
    if (p) return p.status;
    // Chính mình: đang xem trang này thì chắc chắn online, kể cả khi danh sách chưa tới.
    return id === meId ? "active" : "offline";
  };
  const rank = (id: string) => byUser.get(id)?.index ?? (id === meId ? -1 : Infinity);
  const sorted = [...members].sort((a, b) => rank(a.id) - rank(b.id));
  const online = members.filter((m) => statusOf(m.id) !== "offline").length;
  return (
    <div
      className="avatars"
      role="group"
      aria-label={connected ? `${online} of ${members.length} members online` : "Members"}
    >
      {sorted.map((m) => (
        <Avatar
          key={m.id}
          name={m.displayName}
          isMe={m.id === meId}
          color={m.avatarColor}
          // Mất kết nối thì không biết ai đang online: không hiện chấm thay vì hiện thông tin cũ.
          presence={connected ? statusOf(m.id) : undefined}
        />
      ))}
    </div>
  );
}

/** Trạng thái kết nối: người dùng biết thay đổi của mình đã tới server chưa. */
function SyncBadge({ status, pending }: { status: SyncStatus; pending: number }) {
  const [label, tone] =
    status === "live"
      ? pending > 0
        ? ["Saving…", "saving"]
        : ["Live", "live"]
      : status === "reconnecting"
        ? [pending > 0 ? `Offline · ${pending} unsent` : "Reconnecting…", "offline"]
        : ["Connecting…", "offline"];
  return (
    <span className={`sync-badge sync-${tone}`} role="status" aria-live="polite">
      <span className="sync-dot" aria-hidden />
      {label}
    </span>
  );
}

function Lane(props: {
  column: Column;
  tone: Tone;
  cards: Card[];
  isDropTarget: boolean;
  memberById: Map<string, Member>;
  editing: Map<string, Editor[]>;
  canEdit: boolean;
  actions: Actions;
  onOpen: (id: string) => void;
}) {
  const { column, tone, cards, isDropTarget, memberById, editing, canEdit, actions, onOpen } = props;
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  // Cả cột là vùng thả, để thả được vào cột trống hoặc vào khoảng trống dưới thẻ cuối.
  const { setNodeRef } = useDroppable({ id: column.id, disabled: !canEdit });

  function submit() {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    actions.addCard(column.id, title);
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
    <section
      ref={setNodeRef}
      className={`lane ${isDropTarget ? "is-over" : ""}`}
      aria-label={column.title}
      style={toneVars(tone) as CSSProperties}
    >
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

      <SortableContext items={cards.map((k) => k.id)} strategy={verticalListSortingStrategy}>
        <ol className="lane-cards">
          {cards.map((card) => (
            <SortableCard
              key={card.id}
              card={card}
              assignee={card.assigneeId ? memberById.get(card.assigneeId) : undefined}
              editors={editing.get(card.id)}
              canEdit={canEdit}
              onOpen={onOpen}
            />
          ))}
        </ol>
      </SortableContext>

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

function NewLane({ onAdd }: { onAdd: (title: string) => unknown }) {
  const [title, setTitle] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onAdd(title.trim());
    setTitle("");
  }
  return (
    <form className="lane lane-new" onSubmit={submit}>
      <input placeholder="+ Add a column" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
      {title.trim() && <button className="btn btn-primary btn-sm">Add</button>}
    </form>
  );
}
