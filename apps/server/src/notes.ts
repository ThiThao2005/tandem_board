import {
  NOTE_FIELD,
  NOTE_MAX_DOC_BYTES,
  noteSummary,
  type BoardOp,
  type NoteAwarenessState,
  type NoteClosedReason,
  type NoteSummary,
} from "@tandem/shared";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import { z } from "zod";
import { isPgError, pool, withTx } from "./db";
import { HttpError } from "./errors";
import { recordNoteSummary } from "./ops";

/*
 * Ghi chú nhiều người cùng gõ (tuần 5) — phía server.
 *
 * Mỗi ghi chú đang có người mở có MỘT Y.Doc trong bộ nhớ tiến trình (NoteDoc). Server không "trộn" văn bản:
 * Yjs là CRDT nên áp dụng các thay đổi theo thứ tự nào cũng ra cùng một kết quả. Việc của server:
 *   - nạp trạng thái từ DB khi người đầu tiên mở, trả lời bước đồng bộ cho người mở sau;
 *   - nhận thay đổi của editor (realtime.ts đã kiểm tra quyền), phát cho người khác trong phòng note:{cardId};
 *   - lưu vào DB sau SAVE_DEBOUNCE_MS kể từ lần gõ cuối (tối đa SAVE_MAX_WAIT_MS khi gõ liên tục);
 *   - làm sạch awareness (con trỏ): danh tính do server ghi, không ai mạo danh hay xóa con trỏ người khác;
 *   - không còn ai mở thì lưu nốt rồi bỏ khỏi bộ nhớ.
 *
 * Mất gì nếu server sập giữa hai lần lưu? Phần gõ trong ≤ 3 giây cuối chưa vào DB — nhưng các client vẫn còn
 * giữ nó trong Y.Doc của mình; kết nối lại là note.open trao đổi state vector và đẩy ngược lên server.
 * Chỉ mất hẳn nếu cả server sập VÀ người gõ đóng tab trước khi kết nối lại (tuần 6: y-indexeddb).
 *
 * Tuần 8 (nhiều server): lưu đã là "gộp" chứ không "ghi đè" nên không mất dữ liệu, nhưng Y.Doc trong bộ nhớ
 * của mỗi server cần nghe thay đổi của server khác (Redis pub/sub) thì người ở hai server mới thấy nhau.
 */

/** Gõ xong chừng này mới lưu (gom nhiều phím gõ vào một lần ghi DB). */
const SAVE_DEBOUNCE_MS = 500;
/** Gõ liên tục thì vẫn lưu ít nhất mỗi chừng này. */
const SAVE_MAX_WAIT_MS = 3_000;
/** Lưu lỗi (DB tạm mất) thì thử lại sau chừng này. */
const SAVE_RETRY_MS = 2_000;
/** Người cuối cùng đóng ghi chú: giữ Y.Doc thêm một lúc, mở lại ngay thì khỏi đọc DB. */
const UNLOAD_AFTER_MS = 15_000;
/** Một kết nối (một tab) chỉ cần một clientID awareness; cho dư một chút (editor được tạo lại). */
const MAX_CLIENT_IDS_PER_SOCKET = 4;

const FOREIGN_KEY_VIOLATION = "23503";

interface Session {
  userId: string;
  /** clientID awareness mà kết nối này sở hữu (để dọn con trỏ khi rời, và chặn sửa con trỏ người khác). */
  clientIds: Set<number>;
}

export interface NoteDoc {
  readonly cardId: string;
  readonly boardId: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /** socketId → phiên của kết nối đó. */
  readonly sessions: Map<string, Session>;
  /** clientID awareness → socketId sở hữu. */
  readonly owners: Map<number, string>;
  /** Kích thước ước lượng (byte) của trạng thái: chính xác lúc nạp/lưu, cộng dồn kích thước các thay đổi ở giữa. */
  bytes: number;
  /** Có thay đổi chưa lưu. */
  dirty: boolean;
  dirtySince: number;
  /** Người gõ gần nhất (ghi vào updated_by và actor của thao tác card.notes). */
  lastActor: string | null;
  saveTimer?: NodeJS.Timeout;
  saving: Promise<void> | null;
  unloadTimer?: NodeJS.Timeout;
  /** Đã bỏ khỏi bộ nhớ (thẻ bị xóa hẳn, server tắt). */
  dead: boolean;
}

export interface NoteHooks {
  /** Phát thay đổi Yjs cho mọi người trong phòng của ghi chú, trừ kết nối gửi nó (nếu có). */
  broadcastUpdate(cardId: string, update: Uint8Array, exceptSocketId: string | null): void;
  /** Phát thao tác card.notes (tóm tắt đổi) cho phòng của bảng. Gọi SAU khi commit. */
  publishOp(op: BoardOp): void;
  /** Đóng ghi chú với mọi người đang mở (thẻ bị xóa hẳn…). */
  closeRoom(cardId: string, reason: NoteClosedReason): void;
}

// ---------- DB ----------

async function loadState(cardId: string): Promise<Uint8Array | null> {
  const { rows } = await pool.query<{ ydoc: Buffer }>("SELECT ydoc FROM card_notes WHERE card_id = $1", [cardId]);
  const ydoc = rows[0]?.ydoc;
  return ydoc && ydoc.byteLength > 0 ? new Uint8Array(ydoc) : null;
}

/**
 * Lưu: khóa dòng, GỘP trạng thái đang có trong DB với trạng thái trong bộ nhớ, ghi lại. Gộp chứ không ghi đè,
 * nên hai tiến trình (tuần 8) cùng lưu một ghi chú không làm mất phần của nhau. Nạp vào một Y.Doc mới rồi mã
 * hóa lại thì nội dung đã xóa được dọn (GC), ydoc không phình theo lịch sử gõ.
 */
async function persist(
  cardId: string,
  boardId: string,
  state: Uint8Array,
  actorId: string | null,
): Promise<{ summary: NoteSummary | null; bytes: number }> {
  return withTx(async (c) => {
    // Chưa có dòng thì tạo dòng rỗng trước, để FOR UPDATE có cái mà khóa (hai lần lưu đầu tiên song song
    // không ghi đè nhau). Thẻ đã bị xóa hẳn → vi phạm khóa ngoại, nơi gọi bắt lỗi đó.
    await c.query(
      `INSERT INTO card_notes (card_id, board_id, ydoc, updated_by) VALUES ($1, $2, '\\x'::bytea, $3)
       ON CONFLICT (card_id) DO NOTHING`,
      [cardId, boardId, actorId],
    );
    const { rows } = await c.query<{ ydoc: Buffer }>("SELECT ydoc FROM card_notes WHERE card_id = $1 FOR UPDATE", [cardId]);
    const doc = new Y.Doc();
    try {
      const stored = rows[0]?.ydoc;
      if (stored && stored.byteLength > 0) Y.applyUpdate(doc, new Uint8Array(stored));
      Y.applyUpdate(doc, state);
      const merged = Y.encodeStateAsUpdate(doc);
      await c.query("UPDATE card_notes SET ydoc = $2, updated_by = $3, updated_at = now() WHERE card_id = $1", [
        cardId,
        Buffer.from(merged),
        actorId,
      ]);
      return { summary: noteSummary(doc), bytes: merged.byteLength };
    } finally {
      doc.destroy();
    }
  });
}

// ---------- Awareness ----------

const invalidAwareness = () => new HttpError(400, "invalid_input", "Invalid awareness update");

/*
 * Vị trí con trỏ: y-prosemirror (y-tiptap) gửi { anchor, head }, mỗi cái là một Yjs RelativePosition dạng JSON.
 * Bên nhận gọi thẳng Y.createRelativePositionFromJSON(cursor.anchor) KHÔNG có try/catch: một cursor sai định
 * dạng (vd. `1`, `{ anchor: 1 }`) làm plugin vẽ con trỏ ném lỗi và hỏng editor của MỌI người đang mở ghi chú.
 * Vì vậy server chỉ chuyển tiếp cursor đúng định dạng, dựng lại chỉ với các trường hợp lệ; sai thì bỏ cursor.
 */
const yId = z.object({ client: z.number().int().nonnegative(), clock: z.number().int().nonnegative() });
const relativePosition = z
  .object({
    type: yId.nullable().optional(),
    // Chỉ cho tên gốc của ghi chú: tên lạ sẽ làm bên nhận tạo thêm kiểu gốc mới trong Y.Doc của họ.
    tname: z.literal(NOTE_FIELD).nullable().optional(),
    item: yId.nullable().optional(),
    assoc: z.number().int().min(-1).max(0).optional(),
  })
  .refine((p) => p.item != null || p.type != null || p.tname != null, "Empty relative position");
const cursorSchema = z.object({ anchor: relativePosition, head: relativePosition }).nullable();

/**
 * Làm sạch một awareness update của client trước khi áp dụng và phát lại:
 *  - bỏ các mục của clientID thuộc kết nối KHÁC (không cho xóa/sửa con trỏ của người khác);
 *  - `user` luôn do server điền theo tài khoản (không cho mạo danh), chỉ giữ `cursor` và `typing`;
 *  - viewer không bao giờ "đang gõ".
 * Định dạng (y-protocols): varUint số mục, rồi mỗi mục varUint clientID, varUint clock, varString JSON.
 */
export function sanitizeAwareness(
  update: Uint8Array,
  note: Pick<NoteDoc, "owners">,
  socketId: string,
  session: Session,
  user: NoteAwarenessState["user"],
  canEdit: boolean,
): { update: Uint8Array; clientIds: number[] } | null {
  const entries: { clientId: number; clock: number; state: NoteAwarenessState | null }[] = [];
  try {
    const dec = decoding.createDecoder(update);
    const count = decoding.readVarUint(dec);
    if (count > MAX_CLIENT_IDS_PER_SOCKET) throw invalidAwareness();
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(dec);
      const clock = decoding.readVarUint(dec);
      const raw = JSON.parse(decoding.readVarString(dec)) as unknown;
      const owner = note.owners.get(clientId);
      if (owner !== undefined && owner !== socketId) continue;
      let state: NoteAwarenessState | null = null;
      if (raw !== null && typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        state = { user, typing: canEdit && r.typing === true };
        if (r.cursor !== undefined) {
          const cursor = cursorSchema.safeParse(r.cursor);
          if (cursor.success) state.cursor = cursor.data;
        }
      }
      entries.push({ clientId, clock, state });
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw invalidAwareness();
  }
  if (entries.length === 0) return null;
  const ids = new Set([...session.clientIds, ...entries.map((e) => e.clientId)]);
  if (ids.size > MAX_CLIENT_IDS_PER_SOCKET) throw invalidAwareness();

  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, entries.length);
  for (const e of entries) {
    encoding.writeVarUint(enc, e.clientId);
    encoding.writeVarUint(enc, e.clock);
    encoding.writeVarString(enc, JSON.stringify(e.state));
  }
  return { update: encoding.toUint8Array(enc), clientIds: entries.map((e) => e.clientId) };
}

// ---------- Kho ghi chú trong bộ nhớ ----------

export class NoteStore {
  private docs = new Map<string, NoteDoc>();
  private loading = new Map<string, Promise<NoteDoc>>();

  constructor(private readonly hooks: NoteHooks) {}

  get(cardId: string): NoteDoc | undefined {
    return this.docs.get(cardId);
  }

  /** Số ghi chú đang nằm trong bộ nhớ (test kiểm tra không rò). */
  get size(): number {
    return this.docs.size;
  }

  /**
   * Mở ghi chú cho một kết nối: nạp từ DB nếu chưa có trong bộ nhớ (nhiều người mở cùng lúc chỉ nạp một
   * lần), rồi gắn kết nối vào NGAY (đồng bộ) — để lần dọn bộ nhớ đang chờ không bỏ mất ghi chú vừa mở.
   */
  async open(cardId: string, boardId: string, socketId: string, userId: string): Promise<NoteDoc> {
    for (;;) {
      const note = this.docs.get(cardId) ?? (await this.load(cardId, boardId));
      if (note.dead) continue; // vừa bị bỏ trong lúc chờ: nạp lại
      if (note.boardId !== boardId) throw new HttpError(404, "not_found", "Not found");
      clearTimeout(note.unloadTimer);
      note.unloadTimer = undefined;
      if (!note.sessions.has(socketId)) note.sessions.set(socketId, { userId, clientIds: new Set() });
      return note;
    }
  }

  private load(cardId: string, boardId: string): Promise<NoteDoc> {
    let p = this.loading.get(cardId);
    if (p) return p;
    p = (async () => {
      const state = await loadState(cardId);
      const doc = new Y.Doc();
      if (state) Y.applyUpdate(doc, state);
      const awareness = new Awareness(doc);
      // Server không có con trỏ của riêng mình.
      awareness.setLocalState(null);
      const note: NoteDoc = {
        cardId,
        boardId,
        doc,
        awareness,
        sessions: new Map(),
        owners: new Map(),
        bytes: state?.byteLength ?? 0,
        dirty: false,
        dirtySince: 0,
        lastActor: null,
        saving: null,
        dead: false,
      };
      // Mọi thay đổi THẬT SỰ được tích hợp (gửi trùng thì Yjs không phát sự kiện) → phát cho người khác.
      doc.on("update", (update: Uint8Array, origin: unknown) => {
        this.hooks.broadcastUpdate(cardId, update, typeof origin === "string" ? origin : null);
      });
      this.docs.set(cardId, note);
      return note;
    })().finally(() => this.loading.delete(cardId));
    this.loading.set(cardId, p);
    return p;
  }

  /**
   * Áp dụng thay đổi của một editor (realtime.ts đã kiểm tra quyền). Ném lỗi nếu ghi chú quá lớn hoặc
   * dữ liệu hỏng — khi đó client phải đồng bộ lại từ đầu, vì bản của nó đã lệch với server.
   */
  applyUpdate(cardId: string, update: Uint8Array, socketId: string, userId: string) {
    const note = this.docs.get(cardId);
    if (!note || note.dead || !note.sessions.has(socketId)) {
      throw new HttpError(409, "note_not_open", "Open the note first");
    }
    if (note.bytes + update.byteLength > NOTE_MAX_DOC_BYTES) {
      throw new HttpError(413, "note_too_large", "This note is too long");
    }
    try {
      // Đọc thử trước: dữ liệu rác thì báo lỗi ở đây, chưa đụng vào Y.Doc.
      Y.decodeUpdate(update);
      Y.applyUpdate(note.doc, update, socketId);
    } catch {
      throw new HttpError(400, "invalid_input", "Invalid note update");
    }
    note.bytes += update.byteLength;
    note.lastActor = userId;
    if (!note.dirty) {
      note.dirty = true;
      note.dirtySince = Date.now();
    }
    this.scheduleSave(note);
  }

  /** Áp dụng awareness của một kết nối; trả về bản đã làm sạch để phát cho người khác (null nếu bỏ hết). */
  applyAwareness(
    cardId: string,
    update: Uint8Array,
    socketId: string,
    user: NoteAwarenessState["user"],
    canEdit: boolean,
  ): Uint8Array | null {
    const note = this.docs.get(cardId);
    const session = note?.sessions.get(socketId);
    if (!note || note.dead || !session) return null;
    const clean = sanitizeAwareness(update, note, socketId, session, user, canEdit);
    if (!clean) return null;
    for (const id of clean.clientIds) {
      session.clientIds.add(id);
      note.owners.set(id, socketId);
    }
    applyAwarenessUpdate(note.awareness, clean.update, socketId);
    return clean.update;
  }

  /** Con trỏ của mọi người đang mở (gửi cho người vừa mở). */
  awarenessOf(note: NoteDoc): Uint8Array | null {
    const ids = [...note.awareness.getStates().keys()];
    return ids.length > 0 ? encodeAwarenessUpdate(note.awareness, ids) : null;
  }

  /**
   * Kết nối rời ghi chú (đóng hộp thoại, mất kết nối, bị đưa khỏi bảng). Trả về awareness update xóa con
   * trỏ của kết nối đó để phát cho người còn lại. Không còn ai thì hẹn lưu nốt rồi bỏ khỏi bộ nhớ.
   */
  detach(cardId: string, socketId: string): Uint8Array | null {
    const note = this.docs.get(cardId);
    const session = note?.sessions.get(socketId);
    if (!note || !session) return null;
    note.sessions.delete(socketId);
    const ids = [...session.clientIds].filter((id) => note.awareness.getStates().has(id));
    for (const id of session.clientIds) note.owners.delete(id);
    let removal: Uint8Array | null = null;
    if (ids.length > 0) {
      removeAwarenessStates(note.awareness, ids, "server");
      removal = encodeAwarenessUpdate(note.awareness, ids);
    }
    if (note.sessions.size === 0) this.scheduleUnload(note);
    return removal;
  }

  /** Các ghi chú đang mở của một bảng (bảng bị xóa / người bị xóa khỏi nhóm). */
  cardsOfBoard(boardId: string): string[] {
    return [...this.docs.values()].filter((n) => n.boardId === boardId).map((n) => n.cardId);
  }

  // ---------- Lưu ----------

  private scheduleSave(note: NoteDoc) {
    clearTimeout(note.saveTimer);
    const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, note.dirtySince + SAVE_MAX_WAIT_MS - Date.now()));
    note.saveTimer = setTimeout(() => void this.save(note), wait);
  }

  /** Lưu nếu có thay đổi. Gọi song song cũng chỉ một lần lưu chạy tại một thời điểm. */
  async save(note: NoteDoc): Promise<void> {
    while (note.saving) await note.saving;
    if (!note.dirty || note.dead) return;
    clearTimeout(note.saveTimer);
    note.dirty = false;
    note.dirtySince = 0;
    const state = Y.encodeStateAsUpdate(note.doc);
    const actor = note.lastActor;
    note.saving = (async () => {
      try {
        const { summary, bytes } = await persist(note.cardId, note.boardId, state, actor);
        note.bytes = bytes;
        // Tóm tắt (có chữ / tiến độ checklist) đổi thì ghi thành thao tác có seq và phát cho bảng.
        const op = await recordNoteSummary(note.boardId, note.cardId, summary, actor);
        if (op) this.hooks.publishOp(op);
      } catch (err) {
        if (isPgError(err, FOREIGN_KEY_VIOLATION)) {
          // Thẻ đã bị xóa hẳn (xóa cột): ghi chú cũng không còn chỗ để lưu.
          this.kill(note, "card_deleted");
          return;
        }
        console.error(`Saving note ${note.cardId} failed`, err);
        // Giữ lại để lưu lần sau; thay đổi vẫn nằm trong Y.Doc.
        if (!note.dirty) {
          note.dirty = true;
          note.dirtySince = Date.now();
        }
        if (!note.dead) {
          clearTimeout(note.saveTimer);
          note.saveTimer = setTimeout(() => void this.save(note), SAVE_RETRY_MS);
        }
      }
    })().finally(() => {
      note.saving = null;
    });
    await note.saving;
  }

  // ---------- Bỏ khỏi bộ nhớ ----------

  private scheduleUnload(note: NoteDoc) {
    clearTimeout(note.unloadTimer);
    note.unloadTimer = setTimeout(() => void this.unload(note), UNLOAD_AFTER_MS);
    note.unloadTimer.unref();
  }

  private async unload(note: NoteDoc) {
    await this.save(note);
    // Có người mở lại trong lúc lưu, hoặc lưu lỗi (còn thay đổi chưa lưu): giữ lại.
    if (note.sessions.size > 0 || note.dirty || note.dead) return;
    this.drop(note);
  }

  private drop(note: NoteDoc) {
    note.dead = true;
    clearTimeout(note.saveTimer);
    clearTimeout(note.unloadTimer);
    note.awareness.destroy();
    note.doc.destroy();
    if (this.docs.get(note.cardId) === note) this.docs.delete(note.cardId);
  }

  /** Bỏ ghi chú ngay, báo cho người đang mở. */
  private kill(note: NoteDoc, reason: NoteClosedReason) {
    if (note.dead) return;
    this.drop(note);
    this.hooks.closeRoom(note.cardId, reason);
  }

  /** Dùng trong test: bỏ khỏi bộ nhớ ngay (sau khi lưu), như thể đã hết thời gian chờ. */
  async unloadNow(cardId: string) {
    const note = this.docs.get(cardId);
    if (!note) return;
    await this.save(note);
    if (!note.dirty) this.drop(note);
  }

  /** Lưu mọi ghi chú còn thay đổi (tắt server, test). */
  async flushAll() {
    await Promise.all([...this.docs.values()].map((n) => this.save(n)));
  }

  /** Tắt server: lưu hết rồi bỏ hết. */
  async closeAll() {
    await this.flushAll();
    for (const note of [...this.docs.values()]) this.drop(note);
  }
}
