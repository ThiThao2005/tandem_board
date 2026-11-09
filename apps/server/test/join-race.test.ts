import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { addMember, createBoard, registerUser } from "./helpers";
import { connect, errorCode, join, okOp, sendOp, sleep, useRealtimeServer, waitFor } from "./socket-helpers";

/*
 * Lỗi tìm ra lúc review tuần 4: board.join cho socket vào phòng TRƯỚC rồi mới kiểm tra quyền. Với DB ở xa
 * (Supabase: 100–300 ms mỗi lượt), trong khoảng chờ đó người ngoài nhóm nhận được mọi thao tác phát cho bảng.
 * DB trên máy quá nhanh để bắt gặp khoảng này, nên ở đây làm bước đọc lúc vào phòng chậm như DB ở xa.
 */
vi.mock("../src/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/access")>();
  return {
    ...actual,
    // Bước kiểm tra quyền khi vào phòng (catchUp gọi requireBoard) chậm như DB ở xa.
    requireBoard: async (...args: Parameters<typeof actual.requireBoard>) => {
      await new Promise((r) => setTimeout(r, 200));
      return actual.requireBoard(...args);
    },
  };
});

useRealtimeServer();

describe("vào phòng khi DB chậm", () => {
  it("người ngoài nhóm không nghe được thao tác trong lúc server đang kiểm tra quyền", async () => {
    const a = await registerUser("An");
    const snap = await createBoard(a);
    const boardId = snap.board.id;
    const todo = snap.columns[0]!.id;
    const sa = await connect(a.token);
    expect((await join(sa, boardId)).ok).toBe(true);

    const stranger = await registerUser("Người lạ");
    const ss = await connect(stranger.token);
    const joining = join(ss, boardId);
    await sleep(50); // người lạ đang chờ kiểm tra quyền
    okOp(await sendOp(sa, boardId, { opId: randomUUID(), type: "card.create", payload: { columnId: todo, id: randomUUID(), title: "bí mật" } }));
    expect(errorCode(await joining)).toBe("not_found");
    await sleep(100);
    expect(ss.received).toEqual([]);
  });

  it("thành viên vào phòng lúc đang có thao tác: không lỡ thao tác nào (nhận qua phát hoặc qua phần lấy bù)", async () => {
    const a = await registerUser("An");
    const b = await registerUser("Bình");
    await addMember(a, b, "editor");
    const snap = await createBoard(a);
    const boardId = snap.board.id;
    const todo = snap.columns[0]!.id;
    const sa = await connect(a.token);
    expect((await join(sa, boardId)).ok).toBe(true);

    const sb = await connect(b.token);
    const joining = join(sb, boardId, 0);
    await sleep(50);
    const op = okOp(await sendOp(sa, boardId, { opId: randomUUID(), type: "card.create", payload: { columnId: todo, id: randomUUID(), title: "mới" } }));
    const ack = await joining;
    if (!ack.ok || ack.catchUp.kind !== "ops") throw new Error("expected ops catch-up");
    const caughtUp = ack.catchUp.ops;
    // Bản phát có thể còn đang trên đường: chờ một chút rồi mới kết luận.
    await waitFor(() => [...caughtUp, ...sb.received].some((o) => o.seq === op.seq), 2000, "thao tác tới");
  });
});
