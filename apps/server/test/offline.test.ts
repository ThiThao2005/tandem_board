import { randomUUID } from "node:crypto";
import {
  BoardReplica,
  boardState,
  isTransientError,
  MAX_CATCHUP_OPS,
  optimisticUpdate,
  type BoardOp,
  type OpRequest,
} from "@tandem/shared";
import { describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { executeOp } from "../src/ops";
import { addMember, createBoard, registerUser } from "./helpers";
import { connect, join, okOp, sendOp, sleep, useRealtimeServer, waitFor, type ClientSocket } from "./socket-helpers";

useRealtimeServer();

/*
 * Chế độ offline (tuần 6), phía server: các ca trong PLAN mục 6 còn lại.
 *  - Offline lâu, lỡ hàng trăm thao tác → vào lại nhận ẢNH CHỤP, hàng đợi vẫn gửi đủ, đúng một lần.
 *  - Cùng một người mở 2 tab, cả hai cùng gửi hàng đợi → mỗi thao tác chỉ ghi một lần.
 *  - Gửi bù cả hàng dài bị giới hạn tốc độ → thử lại (cùng opId) vẫn chỉ ghi một lần.
 */

const req = <T extends OpRequest["type"]>(type: T, payload: Extract<OpRequest, { type: T }>["payload"]) =>
  ({ opId: randomUUID(), type, payload }) as OpRequest;

/** Mọi dòng của bảng operations của một bảng, theo seq. */
async function opsOf(boardId: string) {
  const { rows } = await pool.query<{ seq: string; opId: string; type: string }>(
    `SELECT seq, op_id AS "opId", type FROM operations WHERE board_id = $1 ORDER BY seq`,
    [boardId],
  );
  return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
}

/** Gửi tuần tự một hàng đợi, như BoardSync.flush: thử lại (cùng opId) khi gặp lỗi tạm thời. */
async function flushQueue(socket: ClientSocket, boardId: string, queue: OpRequest[], replica?: BoardReplica) {
  const results: { ok: boolean; duplicate: boolean; code?: string }[] = [];
  for (const r of queue) {
    for (;;) {
      const ack = await sendOp(socket, boardId, r);
      if (ack.ok) {
        replica?.acknowledge(ack.op);
        results.push({ ok: true, duplicate: ack.duplicate });
        break;
      }
      if (isTransientError(ack.error)) {
        await sleep(100);
        continue;
      }
      replica?.reject(r.opId);
      results.push({ ok: false, duplicate: false, code: ack.error.code });
      break;
    }
  }
  return results;
}

/** Hàng đợi mà người dùng tạo lúc offline: thêm thẻ, rồi sửa và kéo CHÍNH thẻ đó (cái sau dựa vào cái trước). */
function offlineQueue(columns: { id: string }[]) {
  const cardId = randomUUID();
  return {
    cardId,
    queue: [
      req("card.create", { columnId: columns[0]!.id, id: cardId, title: "Tạo lúc offline" }),
      req("card.update", { cardId, title: "Sửa lúc offline" }),
      req("card.move", { cardId, columnId: columns[1]!.id, afterCardId: null, beforeCardId: null }),
    ],
  };
}

describe("offline lâu (lỡ hơn MAX_CATCHUP_OPS thao tác)", () => {
  it("vào lại nhận ảnh chụp, hàng đợi vẫn gửi đủ và đúng một lần, mọi bên hội tụ", async () => {
    const an = await registerUser("An");
    const binh = await registerUser("Bình");
    await addMember(an, binh, "editor");
    const board = await createBoard(an);

    // An vào bảng, rồi mất mạng.
    const anSocket1 = await connect(an.token);
    const first = await join(anSocket1, board.board.id);
    if (!first.ok || first.catchUp.kind !== "snapshot") throw new Error("phải nhận ảnh chụp");
    const replica = new BoardReplica(first.catchUp.snapshot);
    anSocket1.on("op", (op) => replica.receive(op));
    anSocket1.disconnect();

    // Lúc offline, An làm vài thao tác: hiện ngay (lạc quan) và xếp hàng.
    const { cardId, queue } = offlineQueue(board.columns);
    for (const r of queue) replica.add({ request: r, apply: optimisticUpdate(replica.view, r, { userId: an.id }) });
    expect(replica.view.cards.find((k) => k.id === cardId)?.title).toBe("Sửa lúc offline");
    const lastSeqWhenLeft = replica.seq;

    // Trong lúc đó Bình làm nhiều hơn mức gửi bù được (gọi thẳng executeOp để khỏi vướng giới hạn tốc độ của socket).
    const missed = MAX_CATCHUP_OPS + 20;
    const column = board.columns[2]!;
    for (let i = 0; i < missed; i++) {
      await executeOp(binh.id, req("card.create", { columnId: column.id, id: randomUUID(), title: `Của Bình ${i}` }));
    }

    // An có mạng lại: vào lại phòng với lastSeq → lỡ quá nhiều nên nhận ẢNH CHỤP.
    const anSocket2 = await connect(an.token);
    anSocket2.on("op", (op) => replica.receive(op));
    const rejoin = await join(anSocket2, board.board.id, lastSeqWhenLeft);
    if (!rejoin.ok) throw new Error(rejoin.error.message);
    expect(rejoin.catchUp.kind).toBe("snapshot");
    if (rejoin.catchUp.kind !== "snapshot") return;
    replica.reset(rejoin.catchUp.snapshot);
    expect(replica.seq).toBe(lastSeqWhenLeft + missed);
    // Thao tác chưa gửi của An không bị ảnh chụp đè mất: vẫn hiện trên bản của An.
    expect(replica.pendingOps).toHaveLength(queue.length);
    expect(replica.view.cards.find((k) => k.id === cardId)?.title).toBe("Sửa lúc offline");
    expect(replica.view.cards.length).toBe(missed + 1);

    // Gửi lại hàng đợi.
    const results = await flushQueue(anSocket2, board.board.id, queue, replica);
    expect(results.every((r) => r.ok && !r.duplicate)).toBe(true);
    await waitFor(() => replica.pendingOps.length === 0, 3000, "hàng chờ của An đã xác nhận hết");

    // Phía server: mỗi opId đúng một dòng, seq liên tục, thẻ ở đúng chỗ.
    const ops = await opsOf(board.board.id);
    expect(ops.map((o) => o.seq)).toEqual(Array.from({ length: ops.length }, (_, i) => i + 1));
    for (const r of queue) expect(ops.filter((o) => o.opId === r.opId)).toHaveLength(1);
    const server = (await an.get(`/api/boards/${board.board.id}`).expect(200)).body;
    const serverCard = server.cards.find((k: { id: string }) => k.id === cardId);
    expect(serverCard).toMatchObject({ title: "Sửa lúc offline", columnId: board.columns[1]!.id });

    // Bản của An khớp ảnh chụp mới của server (sau khi nhận hết bản phát).
    await waitFor(() => replica.seq === server.seq, 3000, "An nhận đủ bản phát");
    expect(boardState({ ...replica.view })).toEqual(boardState(server));
  }, 60_000);

  it("lỡ ít hơn ngưỡng thì chỉ nhận phần thiếu, không nhận ảnh chụp", async () => {
    const an = await registerUser("An");
    const binh = await registerUser("Bình");
    await addMember(an, binh, "editor");
    const board = await createBoard(an);
    const socket = await connect(an.token);
    const first = await join(socket, board.board.id);
    if (!first.ok || first.catchUp.kind !== "snapshot") throw new Error("phải nhận ảnh chụp");
    const lastSeq = first.catchUp.snapshot.seq;
    socket.disconnect();

    for (let i = 0; i < 5; i++) {
      await executeOp(binh.id, req("card.create", { columnId: board.columns[0]!.id, id: randomUUID(), title: `Thẻ ${i}` }));
    }
    const again = await connect(an.token);
    const rejoin = await join(again, board.board.id, lastSeq);
    expect(rejoin.ok && rejoin.catchUp.kind).toBe("ops");
    if (rejoin.ok && rejoin.catchUp.kind === "ops") {
      expect(rejoin.catchUp.ops.map((o) => o.seq)).toEqual([lastSeq + 1, lastSeq + 2, lastSeq + 3, lastSeq + 4, lastSeq + 5]);
    }
  });
});

describe("một người mở 2 tab, cả hai cùng gửi hàng đợi", () => {
  it("mỗi thao tác chỉ ghi và chỉ phát MỘT lần, kể cả khi hai tab gửi song song", async () => {
    const an = await registerUser("An");
    const binh = await registerUser("Bình");
    await addMember(an, binh, "editor");
    const board = await createBoard(an);

    // Binh quan sát: số bản phát của từng opId.
    const observer = await connect(binh.token);
    await join(observer, board.board.id);
    const seen = new Map<string, number>();
    observer.on("op", (op: BoardOp) => seen.set(op.opId, (seen.get(op.opId) ?? 0) + 1));

    const tab1 = await connect(an.token);
    const tab2 = await connect(an.token);
    await join(tab1, board.board.id);
    await join(tab2, board.board.id);

    // Cả hai tab cùng có hàng đợi này (vd. tab cũ sập, hai tab mới đều nạp từ đĩa trước khi một bên kịp nhận về).
    const { cardId, queue } = offlineQueue(board.columns);
    const [r1, r2] = await Promise.all([
      flushQueue(tab1, board.board.id, queue),
      flushQueue(tab2, board.board.id, queue),
    ]);
    expect([...r1, ...r2].every((r) => r.ok)).toBe(true);
    // Mỗi thao tác được thực hiện một lần: một trong hai lần gửi là bản chính, lần kia là "trùng".
    for (let i = 0; i < queue.length; i++) {
      expect([r1[i]!.duplicate, r2[i]!.duplicate].filter(Boolean)).toHaveLength(1);
    }

    await waitFor(() => queue.every((r) => seen.get(r.opId) === 1), 3000, "Bình nhận mỗi thao tác đúng một lần");
    await sleep(100);
    for (const r of queue) expect(seen.get(r.opId)).toBe(1);

    const ops = await opsOf(board.board.id);
    for (const r of queue) expect(ops.filter((o) => o.opId === r.opId)).toHaveLength(1);
    expect(ops.map((o) => o.seq)).toEqual(Array.from({ length: ops.length }, (_, i) => i + 1));

    // Thẻ chỉ có một bản, ở đúng trạng thái cuối, và version cho thấy mỗi thao tác chỉ chạy một lần
    // (tạo = 1, sửa tiêu đề = 2, kéo = 3).
    const server = (await an.get(`/api/boards/${board.board.id}`).expect(200)).body;
    const cards = server.cards.filter((k: { id: string }) => k.id === cardId);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: "Sửa lúc offline", columnId: board.columns[1]!.id, version: 3 });
  });

  it("hai tab gửi hàng đợi so le (tab 2 gửi lại sau khi tab 1 đã xong) cũng chỉ ghi một lần", async () => {
    const an = await registerUser("An");
    const board = await createBoard(an);
    const tab1 = await connect(an.token);
    const tab2 = await connect(an.token);
    await join(tab1, board.board.id);
    await join(tab2, board.board.id);

    const { queue } = offlineQueue(board.columns);
    await flushQueue(tab1, board.board.id, queue);
    const again = await flushQueue(tab2, board.board.id, queue);
    expect(again.every((r) => r.ok && r.duplicate)).toBe(true);
    expect((await opsOf(board.board.id)).filter((o) => queue.some((q) => q.opId === o.opId))).toHaveLength(queue.length);
  });

  it("người khác không dùng được opId của mình để đọc kết quả (op_id_taken)", async () => {
    const an = await registerUser("An");
    const binh = await registerUser("Bình");
    await addMember(an, binh, "editor");
    const board = await createBoard(an);
    const anSocket = await connect(an.token);
    const binhSocket = await connect(binh.token);
    await join(anSocket, board.board.id);
    await join(binhSocket, board.board.id);

    const mine = req("card.create", { columnId: board.columns[0]!.id, id: randomUUID(), title: "Của An" });
    okOp(await sendOp(anSocket, board.board.id, mine));
    const stolen = await sendOp(binhSocket, board.board.id, mine);
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.error.code).toBe("op_id_taken");
  });
});

describe("gửi bù cả hàng dài", () => {
  it("bị giới hạn tốc độ thì thử lại cùng opId: không thao tác nào bị bỏ hay ghi trùng", async () => {
    const an = await registerUser("An");
    const board = await createBoard(an);
    const socket = await connect(an.token);
    await join(socket, board.board.id);

    // Nhiều hơn mức dồn tối đa của xô giới hạn (40) nên chắc chắn gặp rate_limited giữa chừng.
    const queue = Array.from({ length: 70 }, (_, i) =>
      req("card.create", { columnId: board.columns[0]!.id, id: randomUUID(), title: `Thẻ ${i}` }),
    );
    let limited = 0;
    const results: boolean[] = [];
    for (const r of queue) {
      for (;;) {
        const ack = await sendOp(socket, board.board.id, r);
        if (ack.ok) {
          results.push(true);
          break;
        }
        // Đúng như BoardSync: đây là lỗi tạm thời, KHÔNG phải thao tác bị từ chối.
        expect(isTransientError(ack.error)).toBe(true);
        limited++;
        await sleep(100);
      }
    }
    expect(limited).toBeGreaterThan(0);
    expect(results).toHaveLength(queue.length);

    const ops = await opsOf(board.board.id);
    for (const r of queue) expect(ops.filter((o) => o.opId === r.opId)).toHaveLength(1);
    expect(ops.map((o) => o.seq)).toEqual(Array.from({ length: ops.length }, (_, i) => i + 1));
  }, 30_000);
});
