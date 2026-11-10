import { NOTE_FIELD } from "@tandem/shared";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";
import type { NotePeer, NoteSnapshot, NoteSync } from "../sync/noteSync";
import { Avatar } from "./Avatar";

/*
 * Ghi chú nhiều người cùng gõ (tuần 5): TipTap (ProseMirror) gắn vào Y.Doc của NoteSync.
 *  - Collaboration: nội dung nằm trong Y.XmlFragment, mọi bản sao tự hội tụ (Yjs). Hoàn tác (Ctrl+Z) của
 *    extension này chỉ hoàn tác thay đổi CỦA MÌNH, không xóa chữ người khác vừa gõ.
 *  - CollaborationCaret: con trỏ + vùng chọn của người khác, kèm tên, theo màu avatar.
 *  - Checklist ("[ ] " đầu dòng) — tiến độ hiện trên mặt thẻ (server tự tóm tắt khi lưu).
 */

export function NoteEditor(props: {
  note: NoteSync;
  state: NoteSnapshot;
  canEdit: boolean;
  /** Esc trong editor: ProseMirror tự chặn phím Esc (preventDefault) nên <dialog> không tự đóng được. */
  onEscape?: () => void;
}) {
  const { note, state, onEscape } = props;
  // Viewer, hoặc server nói không được sửa, hoặc ghi chú đã bị đóng → chỉ xem.
  const editable = props.canEdit && state.canEdit !== false && state.status !== "closed";
  // Y.Doc bị thay (server từ chối, phải tải lại) → tạo lại editor gắn vào doc mới.
  return <NoteEditorInner key={state.docVersion} note={note} state={state} editable={editable} onEscape={onEscape} />;
}

function NoteEditorInner(props: { note: NoteSync; state: NoteSnapshot; editable: boolean; onEscape?: () => void }) {
  const { note, state, editable } = props;
  // Đọc qua ref: editor chỉ được tạo một lần cho mỗi Y.Doc, còn hàm onEscape đổi mỗi lần render.
  const onEscape = useRef(props.onEscape);
  onEscape.current = props.onEscape;
  const editor = useEditor(
    {
      extensions: [
        // Collaboration có lịch sử hoàn tác riêng (chỉ thay đổi của mình), nên tắt undoRedo của StarterKit.
        StarterKit.configure({ undoRedo: false, heading: { levels: [2, 3] }, link: { openOnClick: !editable, autolink: true } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({
          placeholder: editable ? "Write a note… type “[ ] ” for a checklist, “## ” for a heading" : "No notes yet.",
        }),
        Collaboration.configure({ document: note.doc, field: NOTE_FIELD }),
        CollaborationCaret.configure({ provider: { awareness: note.awareness }, user: note.user }),
      ],
      editable,
      editorProps: {
        handleKeyDown: (_view, event) => {
          if (event.key !== "Escape" || !onEscape.current) return false;
          onEscape.current();
          return true;
        },
        attributes: {
          class: "note-content",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": "Card notes",
        },
      },
    },
    [note.doc],
  );

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  return (
    <div className={`note ${editable ? "" : "is-readonly"}`}>
      {editable && editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
      <NoteFooter state={state} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  // Chỉ vẽ lại thanh công cụ khi trạng thái nút đổi, không phải mỗi phím gõ.
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      h2: e.isActive("heading", { level: 2 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
    }),
  });
  const chain = () => editor.chain().focus();
  const buttons: { key: keyof typeof active; label: string; title: string; run: () => void }[] = [
    { key: "bold", label: "B", title: "Bold (Ctrl+B)", run: () => chain().toggleBold().run() },
    { key: "italic", label: "I", title: "Italic (Ctrl+I)", run: () => chain().toggleItalic().run() },
    { key: "strike", label: "S", title: "Strikethrough", run: () => chain().toggleStrike().run() },
    { key: "code", label: "</>", title: "Inline code", run: () => chain().toggleCode().run() },
    { key: "h2", label: "H", title: "Heading", run: () => chain().toggleHeading({ level: 2 }).run() },
    { key: "bullet", label: "•", title: "Bullet list", run: () => chain().toggleBulletList().run() },
    { key: "ordered", label: "1.", title: "Numbered list", run: () => chain().toggleOrderedList().run() },
    { key: "task", label: "☑", title: "Checklist", run: () => chain().toggleTaskList().run() },
    { key: "quote", label: "❝", title: "Quote", run: () => chain().toggleBlockquote().run() },
  ];
  return (
    <div className="note-toolbar" role="toolbar" aria-label="Formatting">
      {buttons.map((b) => (
        <button
          key={b.key}
          type="button"
          className={`note-tool tool-${b.key} ${active[b.key] ? "is-active" : ""}`}
          title={b.title}
          aria-label={b.title}
          aria-pressed={active[b.key]}
          // Giữ vùng chọn trong editor khi bấm nút.
          onMouseDown={(e) => e.preventDefault()}
          onClick={b.run}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

/** "Lan is typing…", "Lan and Bình are typing…" */
export function typingLine(peers: NotePeer[]): string | null {
  const names = [...new Set(peers.filter((p) => p.typing).map((p) => p.name))];
  if (names.length === 0) return null;
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${who} ${names.length === 1 ? "is" : "are"} typing…`;
}

function NoteFooter({ state }: { state: NoteSnapshot }) {
  const typing = typingLine(state.peers);
  // Một người mở ở nhiều tab thì chỉ hiện một avatar.
  const viewers = [...new Map(state.peers.map((p) => [p.userId, p])).values()];
  const [label, tone] =
    state.status === "closed"
      ? [state.closedReason === "card_deleted" ? "This card was deleted" : "Closed", "offline"]
      : state.status === "offline"
        ? [state.unsynced ? "Offline · changes kept, will sync" : "Offline", "offline"]
        : state.status === "connecting"
          ? ["Connecting…", "offline"]
          : state.unsynced || state.status === "saving"
            ? ["Saving…", "saving"]
            : ["Saved", "live"];
  return (
    <div className="note-foot">
      <span className="note-peers" aria-hidden={viewers.length === 0}>
        {viewers.map((p) => (
          <span key={p.userId} className={`note-peer ${p.typing ? "is-typing" : ""}`} style={{ color: p.color }}>
            <Avatar name={p.name} color={p.color} size={20} />
          </span>
        ))}
        {/* Luôn có phần tử để trình đọc màn hình đọc khi có người bắt đầu gõ. */}
        <span className="note-typing" role="status" aria-live="polite">
          {typing && (
            <>
              {typing}
              <span className="typing-dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
            </>
          )}
        </span>
      </span>
      <span className={`note-status sync-${tone}`} role="status" aria-live="polite">
        <span className="sync-dot" aria-hidden />
        {label}
      </span>
    </div>
  );
}
