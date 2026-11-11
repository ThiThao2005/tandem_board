/*
 * Biết tab nào còn sống (tuần 6), để một thay đổi chưa gửi chỉ do MỘT tab gửi.
 *
 * Mỗi tab giữ một Web Lock tên `tandem-tab:<tabId>` suốt đời tab; trình duyệt tự nhả khóa khi tab đóng hay sập.
 * `navigator.locks.query()` cho biết khóa nào đang được giữ → tab nào còn sống. Hàng đợi của tab đã chết được
 * tab khác nhận về (xem OutboxStorage.claim).
 *
 * Không có Web Locks (trình duyệt cũ) thì `liveTabs` trả về null và mọi tab khác bị coi là đã chết. Vẫn đúng,
 * vì server bỏ qua opId đã nhận: tệ nhất là hai tab cùng gửi một thao tác, server chỉ ghi một lần.
 */

const PREFIX = "tandem-tab:";

/** Định danh tab này; đổi mỗi lần tải trang. */
export const tabId: string = crypto.randomUUID();

/** Xong khi tab này đã giữ được khóa của mình (từ đó `query` mới thấy tab này là đang sống). */
let registration: Promise<void> | null = null;

/** Giữ khóa của tab này (gọi một lần, sớm; gọi lại cũng được). */
export function registerTab(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.locks) return Promise.resolve();
  registration ??= new Promise<void>((granted) => {
    navigator.locks
      .request(PREFIX + tabId, () => {
        granted();
        // Promise không bao giờ xong: khóa chỉ nhả khi tab đóng.
        return new Promise<never>(() => {});
      })
      .catch(() => granted());
  });
  return registration;
}

/** Các tab đang sống (kể cả tab này), hoặc null nếu trình duyệt không cho biết. */
export async function liveTabs(): Promise<ReadonlySet<string> | null> {
  if (typeof navigator === "undefined" || !navigator.locks) return null;
  await registerTab();
  const { held } = await navigator.locks.query();
  const alive = new Set<string>();
  for (const lock of held ?? []) {
    if (lock.name?.startsWith(PREFIX)) alive.add(lock.name.slice(PREFIX.length));
  }
  alive.add(tabId);
  return alive;
}
