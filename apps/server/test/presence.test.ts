import { PRESENCE_ACTIVE_TTL_MS, type Card } from "@tandem/shared";
import { describe, expect, it } from "vitest";
import { sweepPresence } from "../src/realtime";
import { addMember, createBoard, registerUser } from "./helpers";
import {
  connect,
  errorCode,
  join,
  lastPresence,
  sleep,
  updatePresence,
  useRealtimeServer,
  waitFor,
  type ClientSocket,
} from "./socket-helpers";

useRealtimeServer();

/** An (chủ) và Bình (editor) cùng nhóm, một bảng có một thẻ, cả hai đã mở socket (chưa vào bảng). */
async function setup() {
  const a = await registerUser("An");
  const b = await registerUser("Bình");
  await addMember(a, b, "editor");
  const snap = await createBoard(a);
  const boardId = snap.board.id;
  const card = (await a.post(`/api/columns/${snap.columns[0]!.id}/cards`, { title: "Thẻ" }).expect(201)).body as Card;
  const sa = await connect(a.token);
  const sb = await connect(b.token);
  return { a, b, boardId, cardId: card.id, sa, sb };
}

const ok = async (p: Promise<{ ok: boolean }>) => expect((await p).ok).toBe(true);

/** Chờ tới khi danh sách presence mới nhất `socket` nhận được bằng `expected`. */
function waitForPresence(socket: ClientSocket, boardId: string, expected: [string, string, string | null][]) {
  return waitFor(
    () => JSON.stringify(lastPresence(socket, boardId)) === JSON.stringify(expected),
    2000,
    `presence = ${JSON.stringify(expected)}`,
  );
}

describe("ai đang online trên bảng", () => {
  it("vào bảng thì nhận ngay danh sách; người vào sau hiện bên người vào trước", async () => {
    const { a, b, boardId, sa, sb } = await setup();
    await ok(join(sa, boardId));
    // Danh sách được gửi trước ack trên cùng kết nối nên đã có sẵn khi join xong.
    expect(lastPresence(sa, boardId)).toEqual([[a.id, "active", null]]);

    await ok(join(sb, boardId));
    expect(lastPresence(sb, boardId)).toEqual([
      [a.id, "active", null],
      [b.id, "active", null],
    ]);
    await waitForPresence(sa, boardId, [
      [a.id, "active", null],
      [b.id, "active", null],
    ]);
  });

  it("mở thẻ, ẩn tab thì người khác thấy; heartbeat không đổi gì thì không phát lại", async () => {
    const { a, b, boardId, cardId, sa, sb } = await setup();
    await ok(join(sa, boardId));
    await ok(join(sb, boardId));

    await ok(updatePresence(sb, boardId, "active", cardId));
    await waitForPresence(sa, boardId, [
      [a.id, "active", null],
      [b.id, "active", cardId],
    ]);

    const before = sa.presence.length;
    for (let i = 0; i < 3; i++) await ok(updatePresence(sb, boardId, "active", cardId)); // heartbeat
    await sleep(100);
    expect(sa.presence.length).toBe(before);

    // Vào lại phòng để lấy bù (seq nhảy cóc) không làm mất trạng thái đang mở thẻ.
    await ok(join(sb, boardId, 0));
    expect(lastPresence(sb, boardId)).toEqual([
      [a.id, "active", null],
      [b.id, "active", cardId],
    ]);

    await ok(updatePresence(sb, boardId, "away", cardId));
    await waitForPresence(sa, boardId, [
      [a.id, "active", null],
      [b.id, "away", cardId],
    ]);
  });

  it("một người mở 2 tab: đóng một tab vẫn online, rời bảng ở tab còn lại thì biến mất", async () => {
    const { a, b, boardId, sa, sb } = await setup();
    const sb2 = await connect(b.token);
    await ok(join(sa, boardId));
    await ok(join(sb, boardId));
    await ok(join(sb2, boardId));
    await waitForPresence(sa, boardId, [
      [a.id, "active", null],
      [b.id, "active", null],
    ]);

    sb.disconnect();
    await sleep(150);
    expect(lastPresence(sa, boardId)).toEqual([
      [a.id, "active", null],
      [b.id, "active", null],
    ]);

    sb2.emit("board.leave", { boardId });
    await waitForPresence(sa, boardId, [[a.id, "active", null]]);
  });

  it("mất kết nối thì người khác thấy ngay (không phải chờ hết hạn heartbeat)", async () => {
    const { a, boardId, sa, sb } = await setup();
    await ok(join(sa, boardId));
    await ok(join(sb, boardId));
    await waitFor(() => lastPresence(sa, boardId)?.length === 2, 2000, "A thấy B");
    sb.disconnect();
    await waitForPresence(sa, boardId, [[a.id, "active", null]]);
  });

  it("chưa vào bảng hoặc không có quyền thì không chen presence vào được", async () => {
    const { a, boardId, cardId, sa, sb } = await setup();
    await ok(join(sa, boardId));

    // B là thành viên nhưng chưa vào bảng.
    expect(errorCode(await updatePresence(sb, boardId, "active"))).toBe("not_joined");

    // Người ngoài nhóm: vào bảng bị từ chối, nên cũng không gửi presence được.
    const outsider = await registerUser("Người ngoài");
    const so = await connect(outsider.token);
    expect(errorCode(await join(so, boardId))).toBe("not_found");
    expect(errorCode(await updatePresence(so, boardId, "active", cardId))).toBe("not_joined");

    await sleep(100);
    expect(lastPresence(sa, boardId)).toEqual([[a.id, "active", null]]);
  });

  it("dữ liệu sai thì báo invalid_input", async () => {
    const { boardId, sa } = await setup();
    await ok(join(sa, boardId));
    expect(errorCode(await updatePresence(sa, boardId, "active", "khong-phai-uuid"))).toBe("invalid_input");
    expect(errorCode(await sa.emitWithAck("presence.update", { boardId, status: "busy" as never, cardId: null }))).toBe(
      "invalid_input",
    );
  });

  it("bị xóa khỏi nhóm thì biến khỏi danh sách và không gửi presence được nữa", async () => {
    const { a, b, boardId, sa, sb } = await setup();
    await ok(join(sa, boardId));
    await ok(join(sb, boardId));
    await waitFor(() => lastPresence(sa, boardId)?.length === 2, 2000, "A thấy B");

    await a.del(`/api/workspaces/${a.workspaceId}/members/${b.id}`).expect(204);
    await waitForPresence(sa, boardId, [[a.id, "active", null]]);
    expect(errorCode(await updatePresence(sb, boardId, "active"))).toBe("not_joined");
  });

  it("bảng bị xóa thì mọi người bị đưa khỏi bảng, không gửi presence vào đó được nữa", async () => {
    const { a, boardId, sa, sb } = await setup();
    await ok(join(sa, boardId));
    await ok(join(sb, boardId));
    await a.del(`/api/boards/${boardId}`).expect(204);
    await waitFor(async () => errorCode(await updatePresence(sb, boardId, "active")) === "not_joined", 2000, "B bị đưa khỏi bảng");
  });

  it("tab ẩn (heartbeat thưa) không bị coi là offline nhầm; tab đang hiện im quá 30 giây thì bị dọn, gửi lại thì quay về", async () => {
    const { a, b, boardId, sa, sb } = await setup();
    await ok(join(sa, boardId));
    await ok(join(sb, boardId));
    await ok(updatePresence(sa, boardId, "away"));
    await waitForPresence(sa, boardId, [
      [a.id, "away", null],
      [b.id, "active", null],
    ]);

    // 31 giây không ai gửi gì: socket của B vẫn mở (vd. kết nối "treo") nhưng B đã im quá lâu.
    sweepPresence(Date.now() + PRESENCE_ACTIVE_TTL_MS + 1000);
    await waitForPresence(sa, boardId, [[a.id, "away", null]]);

    // Heartbeat kế tiếp của B (vẫn còn trong phòng) đưa B trở lại danh sách.
    await ok(updatePresence(sb, boardId, "active"));
    await waitForPresence(sa, boardId, [
      [a.id, "away", null],
      [b.id, "active", null],
    ]);
  });
});
