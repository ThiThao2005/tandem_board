import fc from "fast-check";
import { generateKeyBetween } from "fractional-indexing";
import { describe, expect, it } from "vitest";
import {
  evenPositions,
  isValidPosition,
  JITTER_LENGTH,
  keyBetween,
  needsRebalance,
  positionBetween,
  POSITION_REBALANCE_LENGTH,
} from "../src/position";

/** Bộ sinh số ngẫu nhiên có seed (mulberry32), để test fail thì chạy lại được y hệt. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function expectStrictlyBetween(key: string, a: string | null, b: string | null) {
  expect(isValidPosition(key)).toBe(true);
  if (a !== null) expect(key > a, `${key} > ${a}`).toBe(true);
  if (b !== null) expect(key < b, `${key} < ${b}`).toBe(true);
}

function expectSortedUnique(keys: string[]) {
  for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!, `${keys[i - 1]} < ${keys[i]}`).toBe(true);
}

/** Chèn n lần vào các chỗ ngẫu nhiên của một danh sách, trả về danh sách vị trí. */
function randomInserts(n: number, pickIndex: (len: number) => number, options: Parameters<typeof positionBetween>[2]) {
  const list: string[] = [];
  for (let i = 0; i < n; i++) {
    const at = pickIndex(list.length + 1); // chèn trước phần tử thứ `at`
    const key = positionBetween(list[at - 1] ?? null, list[at] ?? null, options);
    list.splice(at, 0, key);
  }
  return list;
}

describe("keyBetween (tất định)", () => {
  it.each([
    [null, null, "a0"],
    ["a0", null, "a1"],
    ["a1", null, "a2"],
    [null, "a0", "Zz"],
    ["a0", "a1", "a0V"],
    ["a0", "a0V", "a0G"],
    ["a0V", "a1", "a0l"],
    ["az", null, "b00"],
    ["Zz", null, "a0"],
    [null, "Zz", "Zy"],
    [null, "Z0", "Yzz"],
    ["b00", null, "b01"],
    ["a1", "a3", "a2"],
    [null, "a0V", "a0"],
  ])("giữa %s và %s là %s", (a, b, expected) => {
    expect(keyBetween(a, b)).toBe(expected);
  });

  it("báo lỗi khi a >= b", () => {
    expect(() => keyBetween("a1", "a1")).toThrow();
    expect(() => keyBetween("a2", "a1")).toThrow();
  });

  it("báo lỗi khi vị trí sai định dạng", () => {
    for (const bad of ["", "a", "b0", "a0V0", "a1 ", "a0_", "!0"]) {
      expect(isValidPosition(bad), bad).toBe(false);
      expect(() => keyBetween(bad, null), bad).toThrow();
    }
    expect(isValidPosition("A" + "0".repeat(26))).toBe(false);
  });

  it("cho kết quả giống hệt thư viện fractional-indexing (so sánh chéo)", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 60 }), (picks) => {
        const list: string[] = [];
        for (const p of picks) {
          const at = p % (list.length + 1);
          const a = list[at - 1] ?? null;
          const b = list[at] ?? null;
          const ours = keyBetween(a, b);
          expect(ours).toBe(generateKeyBetween(a, b));
          list.splice(at, 0, ours);
        }
      }),
      { seed: 20261109, numRuns: 300 },
    );
  });

  it("thêm liên tục vào cuối/đầu cột, chuỗi dài ra rất chậm", () => {
    let last: string | null = null;
    let first: string | null = null;
    for (let i = 0; i < 5000; i++) {
      last = keyBetween(last, null);
      first = keyBetween(null, first);
    }
    expect(last!.length).toBeLessThanOrEqual(4);
    expect(first!.length).toBeLessThanOrEqual(4);
  });
});

describe("positionBetween (có jitter)", () => {
  it("luôn nằm giữa hai vị trí và có đúng JITTER_LENGTH chữ số ngẫu nhiên", () => {
    const key = positionBetween("a0", "a1", { random: seeded(1) });
    expectStrictlyBetween(key, "a0", "a1");
    expect(key.startsWith("a0V")).toBe(true);
    expect(key.length).toBe("a0V".length + JITTER_LENGTH);
  });

  it("hai người chèn vào cùng một khe nhận hai vị trí khác nhau", () => {
    // Đo đúng tình huống thật: mỗi lượt có 2 người cùng chèn vào giữa "a0" và "a1".
    // (Không gom 2000 khóa vào một Set: theo nghịch lý ngày sinh, 2000 khóa trong
    //  62^4 khả năng có ~13% xác suất xuất hiện một cặp trùng, test sẽ chập chờn.)
    const random = seeded(123);
    for (let round = 0; round < 10_000; round++) {
      const alice = positionBetween("a0", "a1", { random });
      const bob = positionBetween("a0", "a1", { random });
      expectStrictlyBetween(alice, "a0", "a1");
      expectStrictlyBetween(bob, "a0", "a1");
      expect(alice).not.toBe(bob);
    }
    // Không có jitter thì chắc chắn trùng — đó là lý do cần jitter.
    expect(positionBetween("a0", "a1", { jitter: 0 })).toBe(positionBetween("a0", "a1", { jitter: 0 }));
  });

  it("vẫn nhỏ hơn b khi điểm giữa là tiền tố của b", () => {
    // keyBetween("a0", "a1V") = "a1" là tiền tố của "a1V": nối đuôi trực tiếp có thể vượt quá b.
    expect(keyBetween("a0", "a1V")).toBe("a1");
    for (let i = 0; i < 500; i++) expectStrictlyBetween(positionBetween("a0", "a1V"), "a0", "a1V");
    // Tiền tố lồng nhiều tầng.
    for (let i = 0; i < 500; i++) expectStrictlyBetween(positionBetween(null, "a0001"), null, "a0001");
    for (let i = 0; i < 500; i++) expectStrictlyBetween(positionBetween("a0", "a0001"), "a0", "a0001");
  });

  it("chữ số ngẫu nhiên cuối cùng không bao giờ là '0' (kể cả khi random() trả về 0)", () => {
    const key = positionBetween("a0", "a1", { random: () => 0 });
    expectStrictlyBetween(key, "a0", "a1");
    expect(key).toBe("a0V0001");
  });

  it("jitter: 0 cho kết quả tất định", () => {
    expect(positionBetween("a0", "a1", { jitter: 0 })).toBe("a0V");
  });

  it("thuộc tính: chèn ngẫu nhiên nhiều lần, danh sách luôn tăng dần và không trùng", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 80 }), fc.integer(), (picks, seed) => {
        const random = seeded(seed);
        let i = 0;
        const list = randomInserts(picks.length, (len) => picks[i++]! % len, { random });
        for (const key of list) expect(isValidPosition(key)).toBe(true);
        expectSortedUnique(list);
      }),
      { seed: 42, numRuns: 300 },
    );
  });

  it("thuộc tính: với mọi a < b hợp lệ, kết quả nằm giữa a và b", () => {
    const pool = randomInserts(300, (len) => Math.floor(seeded(7)() * len), { random: seeded(8) });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: pool.length - 1 }),
        fc.integer({ min: 0, max: pool.length - 1 }),
        fc.integer(),
        (i, j, seed) => {
          fc.pre(i !== j);
          const [a, b] = i < j ? [pool[i]!, pool[j]!] : [pool[j]!, pool[i]!];
          expectStrictlyBetween(positionBetween(a, b, { random: seeded(seed) }), a, b);
          expectStrictlyBetween(positionBetween(null, a, { random: seeded(seed) }), null, a);
          expectStrictlyBetween(positionBetween(b, null, { random: seeded(seed) }), b, null);
        },
      ),
      { seed: 2026, numRuns: 1000 },
    );
  });
});

describe("sắp xếp lại khi chuỗi quá dài", () => {
  it("chèn mãi vào cùng một khe thì chuỗi dài ra và chạm ngưỡng sắp xếp lại", () => {
    const random = seeded(99);
    const a = "a0";
    let b = "a1";
    let inserts = 0;
    while (!needsRebalance(b)) {
      b = positionBetween(a, b, { random });
      expectStrictlyBetween(b, a, null);
      inserts++;
    }
    expect(b.length).toBe(POSITION_REBALANCE_LENGTH + 1);
    // Đủ nhiều để không phải sắp xếp lại thường xuyên.
    expect(inserts).toBeGreaterThan(100);
  });

  it("evenPositions sinh n vị trí ngắn, tăng dần", () => {
    expect(evenPositions(0)).toEqual([]);
    expect(evenPositions(3)).toEqual(["a0", "a1", "a2"]);
    const many = evenPositions(5000);
    expectSortedUnique(many);
    expect(many.every(isValidPosition)).toBe(true);
    expect(Math.max(...many.map((k) => k.length))).toBeLessThanOrEqual(4);
  });

  it("sau khi sắp xếp lại vẫn chèn tiếp được vào giữa", () => {
    const [x, y] = evenPositions(2);
    expectStrictlyBetween(positionBetween(x!, y!), x!, y!);
  });
});
