/** "Lan Nguyen" → "LN", "Lan" → "L" */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Trạng thái online hiện trên avatar (tuần 4). Không truyền thì không hiện chấm. */
export type AvatarPresence = "active" | "away" | "offline";

const PRESENCE_LABEL: Record<AvatarPresence, string> = { active: "online", away: "away", offline: "offline" };

export function Avatar({
  name,
  color,
  size = 28,
  presence,
  isMe = false,
}: {
  name: string;
  color: string;
  size?: number;
  presence?: AvatarPresence;
  /** Thêm "(you)" vào chú thích (không vào chữ viết tắt). */
  isMe?: boolean;
}) {
  const label = isMe ? `${name} (you)` : name;
  return (
    <span
      className={`avatar ${presence ? `has-presence presence-${presence}` : ""}`}
      title={presence ? `${label} — ${PRESENCE_LABEL[presence]}` : label}
      style={{ background: color, width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials(name)}
      {presence && presence !== "offline" && <span className="avatar-dot" aria-hidden />}
    </span>
  );
}
