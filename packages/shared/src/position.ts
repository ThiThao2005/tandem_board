/**
 * Vị trí kiểu phân số (fractional indexing) cho thẻ và cột.
 *
 * Vị trí là một chuỗi; thứ tự của thẻ chính là thứ tự so sánh chuỗi theo byte
 * (JS `<` với ký tự ASCII, Postgres `COLLATE "C"`). Muốn chèn vào giữa hai thẻ thì
 * sinh một chuỗi nằm giữa hai chuỗi kia — không phải đánh số lại các thẻ khác.
 *
 * Định dạng (giống thư viện `fractional-indexing`, nên dữ liệu cũ vẫn dùng được):
 *
 *   khóa = phần nguyên + phần lẻ
 *   - Phần nguyên: 1 ký tự đầu cho biết độ dài, sau đó là các chữ số base 62.
 *       'a'..'z' → số không âm, dài 2..27 ký tự  ("a0", "a1", …, "az", "b00", …)
 *       'Z'..'A' → số âm,       dài 2..27 ký tự  ("Zz", "Zy", …, "Z0", "Yzz", …)
 *     Nhờ ký tự đầu mã hóa độ dài, thêm thẻ vào cuối/đầu cột chỉ làm chuỗi dài ra
 *     rất chậm (logarit), không phải dài thêm mỗi lần.
 *   - Phần lẻ: các chữ số base 62 phía sau, KHÔNG được kết thúc bằng '0'
 *     (nếu không "a0V" và "a0V0" là cùng một giá trị mà lại khác chuỗi).
 *
 * Phần ngẫu nhiên (jitter): khi hai người cùng chèn vào một khe (giữa A và B),
 * nếu chỉ lấy "điểm giữa" thì cả hai sinh ra CÙNG một chuỗi. Vì vậy sau điểm giữa
 * ta nối thêm vài chữ số ngẫu nhiên: hai chuỗi vẫn nằm giữa A và B nhưng khác nhau.
 */

export const POSITION_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = POSITION_DIGITS.length; // 62
const ZERO = POSITION_DIGITS[0]!;
const MAX_DIGIT = POSITION_DIGITS[BASE - 1]!;
const INTEGER_ZERO = "a0";
/** Số nguyên nhỏ nhất. Không được dùng làm khóa, để luôn còn chỗ chèn phía trước. */
const SMALLEST_INTEGER = "A" + ZERO.repeat(26);

/**
 * Số chữ số ngẫu nhiên nối vào sau điểm giữa. 62^4 ≈ 14,8 triệu khả năng:
 * xác suất hai người chèn cùng một khe mà trùng nhau là khoảng 1/14,8 triệu.
 */
export const JITTER_LENGTH = 4;

/**
 * Vị trí dài hơn ngưỡng này thì sắp xếp lại cả cột. Chèn liên tục vào cùng một khe
 * làm chuỗi dài thêm khoảng 1 ký tự sau mỗi 5–6 lần, nên phải chèn ~130 lần
 * vào đúng một chỗ mới chạm ngưỡng.
 */
export const POSITION_REBALANCE_LENGTH = 32;

export interface PositionOptions {
  /** Hàm sinh số ngẫu nhiên trong [0, 1). Truyền vào để test chạy lại y hệt. */
  random?: () => number;
  /** Số chữ số ngẫu nhiên; 0 = không thêm (kết quả tất định). */
  jitter?: number;
}

// ---------- Kiểm tra định dạng ----------

function digitValue(ch: string | undefined): number {
  return ch === undefined ? -1 : POSITION_DIGITS.indexOf(ch);
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  if (head >= "A" && head <= "Z") return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`Invalid position head: ${JSON.stringify(head)}`);
}

function integerPart(key: string): string {
  const len = integerLength(key[0] ?? "");
  if (len > key.length) throw new Error(`Invalid position: ${JSON.stringify(key)}`);
  return key.slice(0, len);
}

function assertKey(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error(`Invalid position: ${JSON.stringify(key)}`);
  const int = integerPart(key);
  for (let i = 1; i < key.length; i++) {
    if (digitValue(key[i]) < 0) throw new Error(`Invalid position: ${JSON.stringify(key)}`);
  }
  if (key.length > int.length && key.endsWith(ZERO)) {
    throw new Error(`Invalid position (trailing zero): ${JSON.stringify(key)}`);
  }
}

export function isValidPosition(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0) return false;
  try {
    assertKey(key);
    return true;
  } catch {
    return false;
  }
}

// ---------- Phần lẻ ----------

/**
 * Chuỗi chữ số nằm giữa a và b, coi như hai phân số 0.a và 0.b (b = null nghĩa là 1).
 * Yêu cầu a < b và cả hai không kết thúc bằng '0'.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Bỏ qua phần đầu giống nhau ("a" thiếu chữ số coi như '0').
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? digitValue(a[0]) : 0;
  const db = b !== null ? digitValue(b[0]) : BASE;
  if (db - da > 1) {
    // Còn chỗ ở ngay chữ số này: lấy chữ số ở giữa.
    return POSITION_DIGITS[Math.round((da + db) / 2)]!;
  }
  // Hai chữ số liền nhau (vd. '4' và '5').
  if (b !== null && b.length > 1) {
    // b = "5xyz" > "5" > a, nên chỉ cần lấy "5".
    return b.slice(0, 1);
  }
  // Giữ chữ số của a rồi tìm tiếp ở chữ số sau, không còn cận trên.
  return POSITION_DIGITS[da]! + midpoint(a.slice(1), null);
}

// ---------- Phần nguyên ----------

function incrementInteger(x: string): string | null {
  const head = x[0]!;
  const digits = x.slice(1).split("");
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = digitValue(digits[i]) + 1;
    if (d === BASE) {
      digits[i] = ZERO;
    } else {
      digits[i] = POSITION_DIGITS[d]!;
      carry = false;
    }
  }
  if (!carry) return head + digits.join("");
  // Tràn số: đổi ký tự đầu để tăng độ dài phần nguyên.
  if (head === "Z") return INTEGER_ZERO; // -1 + 1 = 0
  if (head === "z") return null; // hết chỗ (không thể xảy ra trong thực tế)
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > "a") digits.push(ZERO); // số dương: dài thêm 1
  else digits.pop(); // số âm: ngắn đi 1
  return next + digits.join("");
}

function decrementInteger(x: string): string | null {
  const head = x[0]!;
  const digits = x.slice(1).split("");
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = digitValue(digits[i]) - 1;
    if (d === -1) {
      digits[i] = MAX_DIGIT;
    } else {
      digits[i] = POSITION_DIGITS[d]!;
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join("");
  if (head === "a") return "Z" + MAX_DIGIT; // 0 - 1 = -1
  if (head === "A") return null;
  const next = String.fromCharCode(head.charCodeAt(0) - 1);
  if (next < "Z") digits.push(MAX_DIGIT); // số âm: dài thêm 1
  else digits.pop(); // số dương: ngắn đi 1
  return next + digits.join("");
}

// ---------- API ----------

/**
 * Khóa tất định nằm giữa a và b (null = đầu/cuối danh sách), ngắn nhất có thể.
 * Cho kết quả giống hệt `generateKeyBetween` của thư viện fractional-indexing.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) assertKey(a);
  if (b !== null) assertKey(b);
  if (a !== null && b !== null && a >= b) {
    throw new Error(`Position ${JSON.stringify(a)} must be less than ${JSON.stringify(b)}`);
  }

  if (a === null) {
    if (b === null) return INTEGER_ZERO;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint("", fb);
    if (ib < b) return ib; // b có phần lẻ → chính phần nguyên của b nhỏ hơn b
    const prev = decrementInteger(ib);
    if (prev === null) throw new Error("Cannot create a position before this one");
    return prev;
  }

  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  if (b === null) {
    const next = incrementInteger(ia);
    return next === null ? ia + midpoint(fa, null) : next;
  }

  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const next = incrementInteger(ia);
  if (next === null) throw new Error("Cannot create a position after this one");
  if (next < b) return next;
  return ia + midpoint(fa, null);
}

function randomDigits(count: number, random: () => number): string {
  let s = "";
  for (let i = 0; i < count; i++) {
    // Chữ số cuối khác '0' để khóa vẫn hợp lệ.
    const min = i === count - 1 ? 1 : 0;
    s += POSITION_DIGITS[min + Math.floor(random() * (BASE - min))]!;
  }
  return s;
}

/**
 * Vị trí ngẫu nhiên nằm giữa a và b (null = đầu/cuối danh sách).
 *
 * Cách làm: lấy khóa tất định k nằm giữa, rồi nối thêm chữ số ngẫu nhiên.
 * k + đuôi luôn > k > a. Để k + đuôi < b thì k không được là tiền tố của b
 * (vd. k = "a1", b = "a1V": "a1" + "z" > "a1V"). Khi đó lấy tiếp khóa nằm giữa k và b;
 * khóa mới dài hơn k nhưng ngắn hơn b, nên vòng lặp luôn dừng.
 */
export function positionBetween(a: string | null, b: string | null, options: PositionOptions = {}): string {
  const { random = Math.random, jitter = JITTER_LENGTH } = options;
  let key = keyBetween(a, b);
  if (jitter <= 0) return key;
  while (b !== null && b.startsWith(key)) key = keyBetween(key, b);
  return key + randomDigits(jitter, random);
}

/**
 * n vị trí ngắn, tăng dần ("a0", "a1", …, "az", "b00", …) để sắp xếp lại cả cột.
 * Không thêm jitter: việc sắp xếp lại do server làm khi đang khóa cột.
 */
export function evenPositions(n: number): string[] {
  const keys: string[] = [];
  let key = INTEGER_ZERO;
  for (let i = 0; i < n; i++) {
    keys.push(key);
    key = incrementInteger(key)!;
  }
  return keys;
}

export function needsRebalance(position: string): boolean {
  return position.length > POSITION_REBALANCE_LENGTH;
}

/** So sánh theo vị trí, trùng vị trí thì theo id — cùng thứ tự với `ORDER BY position, id`. */
export function comparePositioned(a: { position: string; id: string }, b: { position: string; id: string }): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
