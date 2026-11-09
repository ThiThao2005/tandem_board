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
import {
  comparePositioned,
  positionBetween,
  type BoardSnapshot,
  type Card,
  type CardMoveResult,
  type Column,
  type Member,
} from "@tandem/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router";
import { api, ApiError, errorMessage } from "../api";
import { Avatar } from "../components/Avatar";
import { CardDialog } from "../components/CardDialog";
import { InlineEdit } from "../components/InlineEdit";
import { CardFace, SortableCard } from "../components/SortableCard";
import { toneAt, toneVars, type Tone } from "../palette";
import { useToast } from "../toast";

/** Ý định khi thả thẻ: nằm ở cột nào, sau thẻ nào, trước thẻ nào. */
export interface MoveIntent {
  columnId: string;
  afterCardId: string | null;
  beforeCardId: string | null;
}

/**
 * Chưa có realtime: mỗi thao tác gọi REST rồi tải lại ảnh chụp bảng.
 * Riêng kéo thả thì cập nhật lạc quan: thẻ nằm ngay chỗ mới, server từ chối thì trả về chỗ cũ.
 * Tuần 3 sẽ chuyển mọi thao tác sang WebSocket.
 */
export function useBoardActions(boardId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["board", boardId];
  const reload = () => qc.invalidateQueries({ queryKey: key });

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

  /** Gắn id thẻ vào lỗi "thẻ đã bị xóa" để nút "Restore" biết thẻ nào. */
  const tagDeleted = (cardId: string) => (err: unknown) => {
    if (err instanceof ApiError && err.code === "card_deleted") err.details = { cardId };
    throw err;
  };

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
        api<Card>(`/cards/${card.id}`, { method: "PATCH", body: { ...patch, baseVersion: card.version } }).catch(
          tagDeleted(card.id),
        ),
      ),
    /**
     * Kéo thả. `optimisticPosition` do client tự tính để thẻ nằm ngay chỗ mới; server vẫn
     * tự tính lại từ hàng xóm hiện tại (client chỉ gửi ý định), rồi ta tải lại bảng.
     * Phải gọi đồng bộ cùng lúc với việc bỏ trạng thái kéo, để không nháy về chỗ cũ.
     */
    moveCard: (card: Card, intent: MoveIntent, optimisticPosition: string | null) => {
      // Hủy lần tải đang chạy dở, kẻo nó trả về dữ liệu cũ đè lên cập nhật lạc quan.
      void qc.cancelQueries({ queryKey: key });
      if (optimisticPosition !== null) {
        qc.setQueryData<BoardSnapshot>(key, (snap) =>
          snap && {
            ...snap,
            cards: snap.cards.map((k) =>
              k.id === card.id ? { ...k, columnId: intent.columnId, position: optimisticPosition } : k,
            ),
          },
        );
      }
      return run(() =>
        api<CardMoveResult>(`/cards/${card.id}/move`, { method: "POST", body: intent }).catch(tagDeleted(card.id)),
      );
    },
    deleteCard: async (card: Card) => {
      const ok = await run(() => api<Card>(`/cards/${card.id}`, { method: "DELETE" }));
      if (ok) toast({ message: `Deleted “${card.title}”`, action: { label: "Undo", run: () => void restore(card.id) } });
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

export function BoardPage() {
  const { boardId = "" } = useParams();
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const board = useQuery({
    queryKey: ["board", boardId],
    queryFn: () => api<BoardSnapshot>(`/boards/${boardId}`),
  });
  const actions = useBoardActions(boardId);

  /** Trong lúc kéo: thứ tự tạm thời (thẻ đã "nhảy" sang cột đang rê qua). */
  const [drag, setDrag] = useState<{ activeId: string; order: Order } | null>(null);

  const columns = board.data?.columns;
  const cards = board.data?.cards;
  const cardById = useMemo(() => new Map((cards ?? []).map((k) => [k.id, k])), [cards]);
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

  if (board.error) return <div className="page"><p className="form-error">{errorMessage(board.error)}</p></div>;
  if (!board.data) return <div className="page muted">Loading board…</div>;

  const { members, role } = board.data;
  const canEdit = role !== "viewer";
  const memberById = new Map(members.map((m) => [m.id, m]));
  const openCard = board.data.cards.find((c) => c.id === openCardId) ?? null;
  const order = drag?.order ?? savedOrder;
  const columnTitle = (id: string | undefined) => board.data.columns.find((c) => c.id === id)?.title ?? "a column";
  const activeCard = drag ? cardById.get(drag.activeId) : undefined;
  /** Cột mà thẻ đang kéo sẽ rơi vào nếu thả ngay bây giờ. */
  const targetColumn = drag ? columnOf(order, drag.activeId) : undefined;
  const activeTone = toneAt(Math.max(0, board.data.columns.findIndex((c) => c.id === targetColumn)));

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

    let optimistic: string | null = null;
    try {
      const prev = intent.afterCardId ? cardById.get(intent.afterCardId)!.position : null;
      const next = intent.beforeCardId ? cardById.get(intent.beforeCardId)!.position : null;
      optimistic = positionBetween(prev, next);
    } catch {
      // Hai hàng xóm trùng vị trí (rất hiếm): bỏ qua cập nhật lạc quan, chờ server.
    }
    actions.moveCard(card, intent, optimistic);
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
          {board.data.columns.map((col, index) => (
            <Lane
              key={col.id}
              column={col}
              tone={toneAt(index)}
              // `order` chụp lúc bắt đầu kéo: cột vừa được thêm trong lúc kéo (tuần 3: người khác thêm
              // qua realtime) chưa có trong đó, nên dùng thứ tự đã lưu thay vì làm sập trang.
              cards={(order[col.id] ?? savedOrder[col.id] ?? []).flatMap((id) => cardById.get(id) ?? [])}
              isDropTarget={targetColumn === col.id}
              memberById={memberById}
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
              overlay
              style={toneVars(activeTone) as CSSProperties}
            />
          )}
        </DragOverlay>
      </DndContext>

      {openCard && (
        <CardDialog
          card={openCard}
          columns={board.data.columns}
          tone={toneAt(Math.max(0, board.data.columns.findIndex((c) => c.id === openCard.columnId)))}
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
  isDropTarget: boolean;
  memberById: Map<string, Member>;
  canEdit: boolean;
  actions: Actions;
  onOpen: (id: string) => void;
}) {
  const { column, tone, cards, isDropTarget, memberById, canEdit, actions, onOpen } = props;
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  // Cả cột là vùng thả, để thả được vào cột trống hoặc vào khoảng trống dưới thẻ cuối.
  const { setNodeRef } = useDroppable({ id: column.id, disabled: !canEdit });

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
