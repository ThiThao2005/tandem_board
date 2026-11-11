import { isTransientError, type FailedOp, type Outbox, type OutboxRecord } from "@tandem/shared";
import type { TandemSocket } from "../realtime";

/*
 * Gửi nốt hàng đợi sau khi rời trang bảng (tuần 6).
 *
 * Người dùng sửa xong rồi chuyển sang trang khác ngay: thao tác đang chờ ack (Supabase ở xa thì ~1,5 s) hoặc còn
 * xếp hàng phía sau KHÔNG được bỏ — nếu không, người khác không thấy thay đổi cho tới khi người này quay lại bảng.
 * `op` không đòi socket phải đang ở trong phòng của bảng, nên gửi được dù đã `board.leave`.
 *
 * Làm đúng như BoardSync.flush nhưng đơn giản hơn (không còn giao diện để cập nhật): lần lượt từng cái, gửi lại cùng
 * opId khi mất ack (server chống ghi trùng), chờ kết nối khi đang offline. Thao tác bị server từ chối thì ghi vào
 * danh sách "không áp dụng được" (lưu trên đĩa) để lần sau mở bảng người dùng thấy, không âm thầm bỏ đi.
 */

const ACK_TIMEOUT_MS = 15_000;
/** Lỗi server (5xx) lặp lại chừng này lần thì coi là thao tác bị từ chối, để một thao tác "độc" không chặn cả hàng. */
const MAX_SERVER_ERRORS = 5;

export interface Drain {
  cancel(): void;
}

export function drainInBackground(
  socket: TandemSocket,
  outbox: Outbox,
  boardId: string,
  items: readonly Pick<OutboxRecord, "request" | "label" | "restoreCard">[],
): Drain {
  let cancelled = false;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  const connected = () =>
    socket.connected
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const done = () => {
            socket.off("connect", done);
            wake = null;
            resolve();
          };
          socket.on("connect", done);
          wake = done;
        });

  const onManualDisconnect = (reason: string) => {
    // Đăng xuất (closeSocket): không còn ai để gửi cho.
    if (reason === "io client disconnect") cancel();
  };
  const cancel = () => {
    cancelled = true;
    socket.off("disconnect", onManualDisconnect);
    wake?.();
  };
  socket.on("disconnect", onManualDisconnect);

  void (async () => {
    const left = new Set(items.map((i) => i.request.opId));
    for (const item of items) {
      const req = item.request;
      let serverErrors = 0;
      while (!cancelled) {
        await connected();
        if (cancelled) break;
        const ack = await socket
          .timeout(ACK_TIMEOUT_MS)
          .emitWithAck("op", { ...req, boardId })
          .catch(() => null);
        if (cancelled) break;
        if (ack === null) {
          await sleep(1000);
          continue;
        }
        if (ack.ok) break;
        const transient = isTransientError(ack.error);
        if (transient && (ack.error.status < 500 || ++serverErrors < MAX_SERVER_ERRORS)) {
          await sleep(ack.error.code === "rate_limited" ? 300 : 1000);
          continue;
        }
        const failed: FailedOp = {
          opId: req.opId,
          userId: outbox.userId,
          boardId,
          request: req,
          label: item.label,
          error: ack.error,
          failedAt: new Date().toISOString(),
          ...(item.restoreCard && { restoreCard: item.restoreCard }),
        };
        outbox.fail(failed);
        break;
      }
      if (cancelled) return;
      left.delete(req.opId);
      outbox.retain(left);
    }
    socket.off("disconnect", onManualDisconnect);
  })();

  return { cancel };
}
