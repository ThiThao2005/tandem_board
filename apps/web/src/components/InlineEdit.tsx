import { useEffect, useState } from "react";

/** Chữ bấm vào thì thành ô nhập; Enter/blur để lưu, Esc để hủy. */
export function InlineEdit(props: {
  value: string;
  onSave: (value: string) => unknown;
  disabled?: boolean;
  maxLength?: number;
  className?: string;
}) {
  const { value, onSave, disabled, maxLength, className } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (disabled || !editing) {
    return (
      <span
        className={`${className ?? ""} ${disabled ? "" : "editable"}`}
        role={disabled ? undefined : "button"}
        tabIndex={disabled ? undefined : 0}
        onClick={() => !disabled && setEditing(true)}
        onKeyDown={(e) => !disabled && e.key === "Enter" && setEditing(true)}
      >
        {value}
      </span>
    );
  }

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onSave(next);
  };

  return (
    <input
      className={`${className ?? ""} inline-input`}
      autoFocus
      value={draft}
      maxLength={maxLength}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      }}
    />
  );
}
