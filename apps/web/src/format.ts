/** "1 member", "3 members" */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "Nov 16, 2026" */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Hạn của thẻ dạng "Nov 16"; overdue = đã qua ngày hôm nay. */
export function formatDue(date: string): { label: string; overdue: boolean } {
  const [y, m, d] = date.split("-").map(Number);
  const due = new Date(y!, m! - 1, d!);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return {
    label: due.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    overdue: due < today,
  };
}
