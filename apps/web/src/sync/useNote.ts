import { useEffect, useState, useSyncExternalStore } from "react";
import type { BoardSync } from "./boardSync";
import type { NoteSnapshot, NoteSync } from "./noteSync";

const EMPTY: NoteSnapshot = {
  status: "connecting",
  unsynced: false,
  canEdit: null,
  peers: [],
  docVersion: 0,
  closedReason: null,
};
const noopSubscribe = () => () => {};

/** Mở đồng bộ ghi chú của một thẻ khi hộp thoại thẻ mở, trả lại khi đóng (BoardSync giữ tiếp nếu chưa gửi xong). */
export function useNote(
  sync: BoardSync | null,
  cardId: string,
  me: { id: string; name: string; color: string },
): { note: NoteSync | null; state: NoteSnapshot } {
  const [note, setNote] = useState<NoteSync | null>(null);
  const { id, name, color } = me;

  useEffect(() => {
    if (!sync) return;
    const n = sync.acquireNote(cardId, { id, name, color });
    setNote(n);
    return () => {
      sync.releaseNote(cardId);
      setNote(null);
    };
  }, [sync, cardId, id, name, color]);

  const state = useSyncExternalStore(note?.subscribe ?? noopSubscribe, note?.getSnapshot ?? (() => EMPTY));
  return { note, state };
}
