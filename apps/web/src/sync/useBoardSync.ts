import { useEffect, useState, useSyncExternalStore } from "react";
import { useMe } from "../auth";
import { getSocket } from "../realtime";
import { BoardSync, type SyncEvents, type SyncSnapshot } from "./boardSync";

const EMPTY: SyncSnapshot = {
  status: "connecting",
  board: null,
  pending: 0,
  error: null,
  presence: [],
  failed: [],
  durable: true,
};
const noopSubscribe = () => () => {};

/**
 * Mở đồng bộ cho một bảng khi trang được mở, đóng khi rời trang.
 * `events` được đọc qua ref của BoardSync nên truyền hàm mới mỗi lần render cũng không sao.
 */
export function useBoardSync(boardId: string, events: SyncEvents): { sync: BoardSync | null; state: SyncSnapshot } {
  const me = useMe();
  const [sync, setSync] = useState<BoardSync | null>(null);
  const [eventsRef] = useState(() => ({ current: events }));
  eventsRef.current = events;

  useEffect(() => {
    const s = new BoardSync(boardId, getSocket(), me.id, {
      onRemoteOp: (op) => eventsRef.current.onRemoteOp(op),
      onNoteRejected: (cardId, err) => eventsRef.current.onNoteRejected(cardId, err),
    });
    s.start();
    setSync(s);
    return () => {
      s.stop();
      setSync(null);
    };
  }, [boardId, me.id, eventsRef]);

  // Tab bị ẩn → "away" chứ không phải offline (trình duyệt làm chậm heartbeat của tab ẩn, server chờ lâu hơn).
  useEffect(() => {
    if (!sync) return;
    const update = () => sync.setPresence({ status: document.visibilityState === "hidden" ? "away" : "active" });
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [sync]);

  // Còn thay đổi chưa tới server mà KHÔNG lưu được xuống đĩa (IndexedDB bị chặn) mà đóng tab: hỏi lại trước.
  // Bình thường (tuần 6) mọi thứ chưa gửi đã nằm trên đĩa nên đóng tab không mất gì.
  useEffect(() => {
    if (!sync) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (sync.unsyncedNotes > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sync]);

  const state = useSyncExternalStore(sync?.subscribe ?? noopSubscribe, sync?.getSnapshot ?? (() => EMPTY));
  return { sync, state };
}
