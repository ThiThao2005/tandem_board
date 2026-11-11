import {
  MemoryOutboxStorage,
  type FailedOp,
  type NewOutboxRecord,
  type OutboxRecord,
  type OutboxStorage,
} from "@tandem/shared";
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";
import { NOTE_DB_PREFIX } from "./noteStore";
import { countPendingNotes, wipePendingNotes } from "./pendingNotes";

/*
 * Nơi lưu hàng đợi offline trong IndexedDB (tuần 6), dùng chung giữa mọi tab của cùng một trình duyệt.
 *
 *   outbox  — thay đổi chưa gửi. Khóa `order` tự tăng (toàn cục) nên giữ đúng thứ tự xếp hàng giữa các tab.
 *   failed  — thay đổi bị server từ chối, chờ người dùng xem. Giữ qua tải lại trang: không âm thầm bỏ đi.
 *
 * Việc nhận hàng đợi của tab đã đóng (`claim`) chạy trong MỘT transaction readwrite: IndexedDB tuần tự hóa
 * các transaction ghi trên cùng một object store, nên hai tab cùng nhận một lúc thì mỗi bản ghi chỉ về một tab.
 */

const DB_NAME = "tandem-offline";

interface OfflineDB extends DBSchema {
  outbox: {
    key: number;
    value: OutboxRecord;
    indexes: { byBoard: [string, string]; byOpId: string };
  };
  failed: {
    key: string;
    value: FailedOp;
    indexes: { byBoard: [string, string] };
  };
}

let dbPromise: Promise<IDBPDatabase<OfflineDB>> | null = null;

function open(): Promise<IDBPDatabase<OfflineDB>> {
  dbPromise ??= openDB<OfflineDB>(DB_NAME, 1, {
    upgrade(db) {
      const outbox = db.createObjectStore("outbox", { keyPath: "order", autoIncrement: true });
      outbox.createIndex("byBoard", ["userId", "boardId"]);
      outbox.createIndex("byOpId", "opId", { unique: true });
      const failed = db.createObjectStore("failed", { keyPath: "opId" });
      failed.createIndex("byBoard", ["userId", "boardId"]);
    },
    // Tab khác nâng cấp schema / xóa DB: đóng kết nối này để không chặn họ, lần sau mở lại.
    terminated() {
      dbPromise = null;
    },
    blocking() {
      void dbPromise?.then((db) => db.close());
      dbPromise = null;
    },
  }).catch((err: unknown) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

class IdbOutboxStorage implements OutboxStorage {
  async add(rec: NewOutboxRecord) {
    const db = await open();
    // `order` do IndexedDB gán (autoIncrement) nên không có trong bản ghi mới.
    await db.add("outbox", rec as OutboxRecord);
  }

  async remove(opIds: string[]) {
    const db = await open();
    const tx = db.transaction("outbox", "readwrite");
    const index = tx.store.index("byOpId");
    for (const opId of opIds) {
      const key = await index.getKey(opId);
      if (key !== undefined) await tx.store.delete(key);
    }
    await tx.done;
  }

  async claim(userId: string, boardId: string, me: string, liveOwners: ReadonlySet<string> | null) {
    const db = await open();
    const tx = db.transaction("outbox", "readwrite");
    const all = await tx.store.index("byBoard").getAll([userId, boardId]);
    const taken: OutboxRecord[] = [];
    for (const r of all) {
      if (r.owner !== me && liveOwners?.has(r.owner)) continue; // tab đó còn sống, nó tự gửi
      const mine = r.owner === me ? r : { ...r, owner: me };
      if (mine !== r) await tx.store.put(mine);
      taken.push(mine);
    }
    await tx.done;
    return taken.sort((a, b) => a.order - b.order);
  }

  async addFailed(rec: FailedOp) {
    const db = await open();
    await db.put("failed", rec);
  }

  async listFailed(userId: string, boardId: string) {
    const db = await open();
    const list = await db.getAllFromIndex("failed", "byBoard", [userId, boardId]);
    return list.sort((a, b) => a.failedAt.localeCompare(b.failedAt));
  }

  async removeFailed(opIds: string[]) {
    const db = await open();
    const tx = db.transaction("failed", "readwrite");
    for (const opId of opIds) await tx.store.delete(opId);
    await tx.done;
  }
}

/** IndexedDB nếu dùng được; không thì bộ nhớ (hàng đợi vẫn chạy, chỉ là tải lại trang thì mất). */
export function createOfflineStorage(): OutboxStorage {
  if (typeof indexedDB === "undefined") return new MemoryOutboxStorage();
  return new IdbOutboxStorage();
}

/**
 * Số thay đổi chưa gửi của một người (mọi bảng) — để cảnh báo trước khi đăng xuất. Gồm cả ghi chú còn chữ chưa tới
 * server (trước đây không đếm: đăng xuất xóa IndexedDB là mất chữ gõ lúc offline mà không được hỏi).
 */
export async function countUnsent(userId: string): Promise<number> {
  let n = countPendingNotes(userId);
  try {
    const db = await open();
    for (const r of await db.getAll("outbox")) if (r.userId === userId) n++;
  } catch {
    // Không mở được IndexedDB: chỉ đếm được ghi chú.
  }
  return n;
}

/**
 * Đăng xuất: xóa mọi dữ liệu offline trên máy này (hàng đợi, thay đổi bị từ chối, ghi chú đã lưu) để người
 * dùng sau trên cùng trình duyệt không đọc được. Dữ liệu chưa gửi bị bỏ — nơi gọi phải hỏi người dùng trước.
 */
export async function wipeOfflineData(): Promise<void> {
  try {
    (await dbPromise)?.close();
  } catch {
    // Chưa mở được thì không có gì để đóng.
  }
  dbPromise = null;
  wipePendingNotes();
  await deleteDB(DB_NAME).catch(() => {});
  // Ghi chú (y-indexeddb) mỗi thẻ một cơ sở dữ liệu, tên bắt đầu bằng NOTE_DB_PREFIX.
  const dbs = (await indexedDB.databases?.().catch(() => [])) ?? [];
  await Promise.all(
    dbs.flatMap((d) => (d.name?.startsWith(NOTE_DB_PREFIX) ? [deleteDB(d.name).catch(() => {})] : [])),
  );
}
