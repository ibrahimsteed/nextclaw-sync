/** Existing unknown writes remain quarantined even in a native-only build. */
export const TRANSPORT_PAUSED =
  "NextClaw: 写入结果未知，已暂停同步。客户端取消不能撤销服务端写入；请由管理员确认旧请求已结束后核对恢复。重载、切换传输或重复读取不会解除暂停。";
export function mutationPending(storage: Pick<Storage, "getItem">, key: string): boolean {
  // Do not clear unrecognized or empty journals: absence is the only safe state.
  return storage.getItem(key) !== null || storage.getItem(key + ":recovery") !== null;
}
