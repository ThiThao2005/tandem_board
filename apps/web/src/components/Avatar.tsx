/** "Lan Nguyen" → "LN", "Lan" → "L" */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function Avatar({ name, color, size = 28 }: { name: string; color: string; size?: number }) {
  return (
    <span
      className="avatar"
      title={name}
      style={{ background: color, width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials(name)}
    </span>
  );
}
