import { PRESENCE_ACTIVE_TTL_MS, PRESENCE_AWAY_TTL_MS, PRESENCE_HEARTBEAT_MS } from "@tandem/shared";
import { describe, expect, it } from "vitest";
import { PresenceStore } from "../src/presence";

// Lớp thuần, thời gian truyền vào bằng tay: không cần chờ thật.
const B = "bang-1";
const active = { status: "active" as const, cardId: null };
const away = { status: "away" as const, cardId: null };

describe("PresenceStore", () => {
  it("báo có thay đổi khi danh sách đổi, heartbeat giữ nguyên trạng thái thì không", () => {
    const p = new PresenceStore();
    expect(p.set(B, "s1", "an", active, 0)).toBe(true);
    expect(p.set(B, "s1", "an", active, 15_000)).toBe(false); // heartbeat
    expect(p.set(B, "s1", "an", { status: "active", cardId: "the-1" }, 16_000)).toBe(true);
    expect(p.list(B)).toEqual([{ userId: "an", status: "active", cardId: "the-1", typing: false }]);
  });

  it("heartbeat gia hạn: tab gửi đều thì không bao giờ bị dọn", () => {
    const p = new PresenceStore();
    for (let t = 0; t <= 10 * 60_000; t += PRESENCE_HEARTBEAT_MS) {
      p.set(B, "s1", "an", active, t);
      expect(p.sweep(t + PRESENCE_HEARTBEAT_MS - 1)).toEqual([]);
    }
    expect(p.list(B)).toHaveLength(1);
  });

  it("tab đang hiện im quá 30 giây thì bị coi là offline", () => {
    const p = new PresenceStore();
    p.set(B, "s1", "an", active, 0);
    expect(p.sweep(PRESENCE_ACTIVE_TTL_MS)).toEqual([]);
    expect(p.sweep(PRESENCE_ACTIVE_TTL_MS + 1)).toEqual([B]);
    expect(p.list(B)).toEqual([]);
    expect(p.boardCount).toBe(0); // không để lại Map rỗng
  });

  it("tab ẨN có heartbeat bị trình duyệt làm chậm còn 1 lần/phút vẫn không bị coi là offline nhầm", () => {
    const p = new PresenceStore();
    p.set(B, "s1", "an", active, 0);
    p.set(B, "s1", "an", away, 1_000); // chuyển sang tab khác
    // Chrome làm chậm hẹn giờ của tab ẩn: heartbeat 15 giây thành 60 giây.
    for (let t = 61_000; t <= 30 * 60_000; t += 60_000) {
      expect(p.sweep(t - 1)).toEqual([]);
      p.set(B, "s1", "an", away, t);
    }
    expect(p.list(B)).toEqual([{ userId: "an", status: "away", cardId: null, typing: false }]);
  });

  it("tab ẩn mà im hẳn (bị trình duyệt đóng băng) thì cuối cùng vẫn bị dọn", () => {
    const p = new PresenceStore();
    p.set(B, "s1", "an", away, 0);
    expect(p.sweep(PRESENCE_AWAY_TTL_MS)).toEqual([]);
    expect(p.sweep(PRESENCE_AWAY_TTL_MS + 1)).toEqual([B]);
  });

  it("một người mở 2 tab: gộp thành một dòng, active nếu có tab đang hiện", () => {
    const p = new PresenceStore();
    p.set(B, "tab1", "an", away, 0);
    expect(p.set(B, "tab2", "an", active, 1)).toBe(true);
    expect(p.list(B)).toEqual([{ userId: "an", status: "active", cardId: null, typing: false }]);
    // Đóng tab đang hiện → còn tab ẩn.
    expect(p.remove(B, "tab2")).toBe(true);
    expect(p.list(B)).toEqual([{ userId: "an", status: "away", cardId: null, typing: false }]);
    // Đóng nốt → không còn ai.
    expect(p.remove(B, "tab1")).toBe(true);
    expect(p.list(B)).toEqual([]);
    expect(p.boardCount).toBe(0);
  });

  it("đóng một trong hai tab cùng trạng thái thì danh sách không đổi, không phải phát", () => {
    const p = new PresenceStore();
    p.set(B, "tab1", "an", active, 0);
    p.set(B, "tab2", "an", active, 1);
    expect(p.remove(B, "tab1")).toBe(false);
    expect(p.remove(B, "khong-co")).toBe(false);
  });

  it("mở thẻ ở nhiều tab: lấy tab mở gần nhất; đóng thẻ ở tab đó thì quay về thẻ của tab kia", () => {
    const p = new PresenceStore();
    p.set(B, "tab1", "an", { status: "active", cardId: "the-X" }, 0);
    p.set(B, "tab2", "an", { status: "active", cardId: "the-Y" }, 10);
    // Heartbeat của tab 1 sau đó không làm nó thành "mới mở".
    p.set(B, "tab1", "an", { status: "active", cardId: "the-X" }, 20);
    expect(p.list(B)[0]!.cardId).toBe("the-Y");
    p.set(B, "tab2", "an", active, 30);
    expect(p.list(B)[0]!.cardId).toBe("the-X");
  });

  it("ensure không đè trạng thái client đã kịp gửi", () => {
    const p = new PresenceStore();
    expect(p.ensure(B, "s1", "an", 0)).toBe(true);
    p.set(B, "s1", "an", { status: "away", cardId: "the-1" }, 1);
    expect(p.ensure(B, "s1", "an", 2)).toBe(false);
    expect(p.list(B)).toEqual([{ userId: "an", status: "away", cardId: "the-1", typing: false }]);
  });

  it("xếp theo lúc vào bảng, không đổi thứ tự khi ai đó cập nhật", () => {
    const p = new PresenceStore();
    p.set(B, "s-binh", "binh", active, 5);
    p.set(B, "s-an", "an", active, 1);
    p.set(B, "s-chi", "chi", active, 9);
    p.set(B, "s-an", "an", away, 20);
    expect(p.list(B).map((u) => u.userId)).toEqual(["an", "binh", "chi"]);
  });

  it("các bảng tách biệt nhau", () => {
    const p = new PresenceStore();
    p.set("bang-1", "s1", "an", active, 0);
    p.set("bang-2", "s2", "binh", active, 0);
    expect(p.list("bang-1").map((u) => u.userId)).toEqual(["an"]);
    expect(p.list("bang-2").map((u) => u.userId)).toEqual(["binh"]);
    expect(p.sweep(PRESENCE_ACTIVE_TTL_MS + 1).sort()).toEqual(["bang-1", "bang-2"]);
  });
});
