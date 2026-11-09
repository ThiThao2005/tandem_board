import { randomUUID } from "node:crypto";
import {
  BoardReplica,
  boardState,
  optimisticUpdate,
  type BoardOp,
  type BoardSnapshot,
  type OpRequest,
} from "@tandem/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { addMember, createBoard, registerUser, type TestUser } from "./helpers";
import { connect, join, sendOp, sleep, useRealtimeServer, waitFor, type ClientSocket } from "./socket-helpers";

useRealtimeServer();

/**
 * Một client mô phỏng, dùng đúng lõi đồng bộ của web (BoardReplica + optimisticUpdate):
 * nhận thao tác theo seq, thấy seq nhảy cóc thì vào lại phòng với lastSeq để lấy bù,
 * gửi thao tác kèm cập nhật lạc quan, bị từ chối thì bỏ bản lạc quan.
 */
class SimClient {
  replica: BoardReplica | null = null;
  private early: BoardOp[] = [];
  rejected = new Map<string, number>();
  private catchingUp = false;

  constructor(
    readonly user: TestUser,
    readonly socket: ClientSocket,
    readonly boardId: string,
  ) {
    socket.on("op", (op) => {
      if (!this.replica) this.early.push(op);
      else if (this.replica.receive(op) === "gap") void this.catchUp();
    });
  }

  async start() {
    const res = await join(this.socket, this.boardId);
    if (!res.ok || res.catchUp.kind !== "snapshot") throw new Error("join phải trả về ảnh chụp");
    this.replica = new BoardReplica(res.catchUp.snapshot);
    for (const op of this.early) this.replica.receive(op);
    this.early = [];
  }

  private async catchUp() {
    if (this.catchingUp) return;
    this.catchingUp = true;
    try {
      const r = this.replica!;
      const res = await join(this.socket, this.boardId, r.seq);
      if (!res.ok) throw new Error(res.error.message);
      if (res.catchUp.kind === "snapshot") r.reset(res.catchUp.snapshot);
      else for (const op of res.catchUp.ops) r.receive(op);
    } finally {
      this.catchingUp = false;
    }
  }

  /** Gửi tuần tự (chờ ack rồi mới gửi tiếp), giống web. */
  async submit(req: OpRequest) {
    const r = this.replica!;
    r.add({ request: req, apply: optimisticUpdate(r.view, req, { userId: this.user.id }) });
    const ack = await sendOp(this.socket, this.boardId, req);
    if (ack.ok) r.acknowledge(ack.op);
    else {
      r.reject(req.opId);
      this.rejected.set(ack.error.code, (this.rejected.get(ack.error.code) ?? 0) + 1);
    }
  }

  /** Chọn một thao tác ngẫu nhiên dựa trên những gì client này đang thấy. */
  pick([kind, x, y]: [number, number, number]): OpRequest {
    const view = this.replica!.view;
    const opId = randomUUID();
    const col = view.columns[x % view.columns.length]!;
    const card = view.cards.length > 0 ? view.cards[y % view.cards.length]! : null;
    if (kind < 30 || !card) {
      return { opId, type: "card.create", payload: { columnId: col.id, id: randomUUID(), title: `t${x}` } };
    }
    if (kind < 60) {
      const others = view.cards.filter((k) => k.columnId === col.id && k.id !== card.id);
      const at = y % (others.length + 1);
      return {
        opId,
        type: "card.move",
        payload: { cardId: card.id, columnId: col.id, afterCardId: others[at - 1]?.id ?? null, beforeCardId: others[at]?.id ?? null },
      };
    }
    if (kind < 75) {
      return { opId, type: "card.update", payload: { cardId: card.id, title: `đổi ${x}`, baseVersion: card.version } };
    }
    if (kind < 82) {
      return {
        opId,
        type: "card.update",
        payload: { cardId: card.id, dueDate: `2026-12-${String((x % 28) + 1).padStart(2, "0")}`, baseVersion: card.version },
      };
    }
    if (kind < 90) return { opId, type: "card.delete", payload: { cardId: card.id } };
    if (kind < 94 && view.columns.length < 6) {
      return { opId, type: "column.create", payload: { boardId: this.boardId, id: randomUUID(), title: `cột ${x}` } };
    }
    return { opId, type: "column.update", payload: { columnId: col.id, title: `cột ${y}` } };
  }
}

const SEED = 20261109;
const CLIENTS = 3;
const STEPS = 40;

describe("hội tụ", () => {
  it(`${CLIENTS} người × ${STEPS} thao tác ngẫu nhiên cùng lúc → ai cũng thấy bảng giống hệt server`, async () => {
    const owner = await registerUser("Chủ");
    const users = [owner];
    for (let i = 1; i < CLIENTS; i++) {
      const u = await registerUser(`Người ${i}`);
      await addMember(owner, u, "editor");
      users.push(u);
    }
    const boardId = (await createBoard(owner)).board.id;
    const clients = await Promise.all(users.map(async (u) => new SimClient(u, await connect(u.token), boardId)));
    await Promise.all(clients.map((c) => c.start()));

    const scripts = clients.map(
      (_, i) =>
        fc.sample(
          fc.array(fc.tuple(fc.nat(99), fc.nat(10_000), fc.nat(10_000)), { minLength: STEPS, maxLength: STEPS }),
          { seed: SEED + i, numRuns: 1 },
        )[0]!,
    );

    await Promise.all(
      clients.map(async (c, i) => {
        for (const step of scripts[i]!) {
          await c.submit(c.pick(step));
          await sleep(step[1] % 4); // xen kẽ các client
        }
      }),
    );

    const { rows } = await pool.query<{ seq: number }>("SELECT last_seq AS seq FROM boards WHERE id = $1", [boardId]);
    const finalSeq = rows[0]!.seq;
    await waitFor(
      () => clients.every((c) => c.replica!.seq === finalSeq && c.replica!.pendingOps.length === 0 && !c.replica!.hasGap),
      5000,
      "mọi client nhận đủ thao tác",
    );

    const server = boardState((await owner.get(`/api/boards/${boardId}`).expect(200)).body as BoardSnapshot);
    expect(server.seq).toBe(finalSeq);
    expect(server.cards.length).toBeGreaterThan(0);
    for (const c of clients) expect(boardState(c.replica!.view)).toEqual(server);

    // Nhật ký operations liên tục 1..N, không lỗ.
    const ops = await pool.query<{ seq: number }>("SELECT seq FROM operations WHERE board_id = $1 ORDER BY seq", [boardId]);
    expect(ops.rows.map((r) => r.seq)).toEqual(Array.from({ length: finalSeq }, (_, i) => i + 1));
    // Chỉ những lý do từ chối "hợp lệ" khi nhiều người cùng sửa.
    const reasons = new Set(clients.flatMap((c) => [...c.rejected.keys()]));
    for (const code of reasons) expect(["not_found", "card_deleted", "version_conflict", "column_not_empty"]).toContain(code);
  }, 30_000);
});
