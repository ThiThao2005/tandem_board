import { retryOption, type FailedOp } from "@tandem/shared";
import { useEffect, useRef } from "react";
import type { BoardSync } from "../sync/boardSync";

const FIELD_LABEL: Record<string, string> = {
  title: "title",
  dueDate: "due date",
  assigneeId: "assignee",
  columnId: "column",
};

/** Vì sao server không áp dụng được thay đổi này, bằng lời người dùng hiểu. */
function reason(f: FailedOp): string {
  const { error } = f;
  if (error.code === "version_conflict") {
    const fields = ((error.details as { fields?: string[] } | undefined)?.fields ?? []).map((x) => FIELD_LABEL[x] ?? x);
    return `Someone else changed the ${fields.join(" and ") || "card"} first.`;
  }
  if (error.code === "forbidden") return "You no longer have permission to edit here.";
  if (error.code === "not_found") return "What you changed no longer exists.";
  return error.message;
}

/**
 * Màn hình "N thay đổi không áp dụng được" (tuần 6): mọi thay đổi của mình mà server từ chối (thẻ đã bị xóa, ai đó
 * sửa trước, mất quyền…), thường gặp nhất khi vừa có mạng lại sau một thời gian offline. Không âm thầm bỏ đi: mỗi
 * thay đổi hiện đúng chữ đã gõ, lý do, và cách thử lại hợp lý nhất. Danh sách được lưu trên đĩa nên tải lại trang vẫn còn.
 */
export function FailedChanges({
  failed,
  sync,
  onClose,
}: {
  failed: readonly FailedOp[];
  sync: BoardSync | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // Xử lý hết rồi thì tự đóng.
  useEffect(() => {
    if (failed.length === 0) ref.current?.close();
  }, [failed.length]);

  return (
    <dialog
      ref={ref}
      className="dialog failed-dialog"
      aria-labelledby="failed-title"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current?.close()}
    >
      <div className="dialog-band failed-band" aria-hidden />
      <div className="dialog-body">
        <div className="dialog-head">
          <h2 id="failed-title" className="failed-title">
            {failed.length === 1 ? "1 change couldn’t be applied" : `${failed.length} changes couldn’t be applied`}
          </h2>
          <button className="icon-btn" aria-label="Close" onClick={() => ref.current?.close()}>
            ×
          </button>
        </div>
        <p className="muted failed-intro">
          These were made on your device but the server turned them down. Nothing was lost: you can see exactly what you
          changed, and try again or let it go.
        </p>

        <ul className="failed-list">
          {failed.map((f) => {
            const option = retryOption(f);
            return (
              <li key={f.opId} className="failed-item">
                <div className="failed-what">{f.label || "A change"}</div>
                <div className="failed-why">{reason(f)}</div>
                <div className="row failed-actions">
                  {option && (
                    <button className="btn btn-primary btn-sm" onClick={() => sync?.retryFailed(f.opId)}>
                      {option.label}
                    </button>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => sync?.dismissFailed([f.opId])}>
                    Dismiss
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        {failed.length > 1 && (
          <div className="dialog-foot">
            <span />
            <button className="btn btn-danger btn-sm" onClick={() => sync?.dismissFailed(failed.map((f) => f.opId))}>
              Dismiss all
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}
