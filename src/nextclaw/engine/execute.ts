import {
  clearPrevSyncRecordByVaultAndProfile,
  upsertPrevSyncRecordByVaultAndProfile,
  type NextclawSyncRecord,
} from "../../localdb";
import {
  errorOf,
  folder,
  mtime,
  name,
  observation,
  rawPath,
  type PlanItem,
  type SyncInput,
} from "./model";

const parseList = (bytes: ArrayBuffer): string[] => {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string"))
    throw new Error("插件清单不是字符串数组");
  return value;
};
export async function mergePlugins(
  input: SyncInput,
  item: PlanItem,
  bytes: ArrayBuffer
) {
  const remoteList = parseList(bytes);
  const localList = item.local
    ? parseList(await input.fsLocal.readFile(name(item.local)))
    : [];
  const old = item.record?.remoteList ?? [];
  const combined = [...remoteList];
  for (const id of localList) {
    if (remoteList.includes(id) || old.includes(id)) continue;
    // An id names exactly one plugin directory, not an arbitrary path.
    if (!id || id === "." || id === ".." || /[/\\\0]/.test(id)) continue;
    try {
      const manifest = await input.fsLocal.stat(
        `${input.configDir}/plugins/${id}/manifest.json`
      );
      if (!folder(name(manifest))) combined.push(id);
    } catch (e) {
      // Missing local manifests exclude stale ids. Other errors must not silently disable plugins.
      const error = e as { code?: string; status?: number; message?: string };
      if (
        error.code !== "ENOENT" &&
        error.status !== 404 &&
        !error.message?.includes("does not exist")
      )
        throw e;
    }
  }
  if (!combined.includes(input.pluginId)) combined.push(input.pluginId);
  return {
    bytes: new TextEncoder().encode(
      JSON.stringify([...new Set(combined)], null, 2)
    ).buffer,
    remoteList,
  };
}

export async function executePlan(
  input: SyncInput,
  plan: Record<string, PlanItem>,
  errors: Error[]
) {
  const { fsLocal: localFs, fsRemote: remoteFs } = input;
  let failures = Object.values(plan).filter((p) => p.error).length;
  let done = 0;
  const operations = Object.entries(plan).filter(
    ([, p]) => p.decision !== "none" && p.decision !== "error"
  );
  const total = operations.length;
  const completed = new Set<string>();
  async function run([key, item]: [string, PlanItem]) {
    if (failures >= 10) return;
    try {
      for (const [other, parent] of Object.entries(plan)) {
        if (
          folder(other) &&
          key.startsWith(other) &&
          other !== key &&
          ["mkdirLocal", "mkdirRemote"].includes(parent.decision) &&
          !completed.has(other)
        )
          throw new Error(`父目录未创建：${other}`);
        if (
          folder(key) &&
          ["deleteLocal", "deleteRemote"].includes(item.decision) &&
          other.startsWith(key) &&
          other !== key &&
          parent.error
        )
          throw new Error(`子项失败，保留目录：${other}`);
      }
      let l = item.local,
        r = item.remote;
      let remoteList = item.record?.remoteList;
      const clear = () =>
        clearPrevSyncRecordByVaultAndProfile(
          input.db,
          input.vaultRandomID,
          input.profileID,
          item.record?.key ?? key
        );
      switch (item.decision) {
        case "pull": {
          let bytes = await remoteFs.readFile(name(r!));
          if (
            key ===
            `${input.configDir.normalize("NFC").replace(/\/$/, "")}/community-plugins.json`
          ) {
            try {
              const merged = await mergePlugins(input, item, bytes);
              bytes = merged.bytes;
              remoteList = merged.remoteList;
            } catch (e) {
              // §6.7 explicitly requires raw fallback for malformed JSON, not for I/O failure.
              if (
                !(e instanceof SyntaxError) &&
                errorOf(e).message !== "插件清单不是字符串数组"
              )
                throw e;
              const warning = new Error(
                `${key}：插件清单格式错误，写入远端原文`
              );
              errors.push(warning);
              item.reason += `；${warning.message}`;
              item.error = warning.message;
              remoteList = undefined;
            }
          }
          if (item.trash && l) await localFs.rm(name(l));
          // D8: compare NFC, but use the original remote spelling for writes.
          l = await localFs.writeFile(
            name(r!),
            bytes,
            mtime(r!, "remote"),
            mtime(r!, "remote")
          );
          break;
        }
        case "push":
          r = await remoteFs.writeFile(
            r ? name(r) : name(l!),
            await localFs.readFile(name(l!)),
            mtime(l!, "local"),
            l!.ctimeCli ?? mtime(l!, "local")
          );
          break;
        case "mkdirLocal":
          l = await localFs.mkdir(`${rawPath(r!)}/`);
          break;
        case "mkdirRemote":
          r = await remoteFs.mkdir(`${rawPath(l!)}/`);
          break;
        case "deleteLocal":
          await localFs.rm(rawPath(l!));
          await clear();
          break;
        case "deleteRemote":
          await remoteFs.rm(name(r!));
          await clear();
          break;
        case "clear":
          await clear();
          break;
      }
      if (
        ["pull", "push", "mkdirLocal", "mkdirRemote", "record"].includes(
          item.decision
        )
      ) {
        if (!l || !r) throw new Error("拒绝记录缺失一侧的路径");
        const record: NextclawSyncRecord = {
          key,
          keyRaw: key,
          sizeRaw: 0,
          v: 1,
          isFolder: folder(key),
          local: observation(l, "local"),
          remote: observation(r, "remote"),
          ...(remoteList ? { remoteList } : {}),
        };
        await upsertPrevSyncRecordByVaultAndProfile(
          input.db,
          input.vaultRandomID,
          input.profileID,
          record
        );
      }
      completed.add(key);
      await input.callbacks.progress(
        input.triggerSource,
        ++done,
        total,
        key,
        item.decision
      );
    } catch (e) {
      const error = new Error(`${key}：${errorOf(e).message}`);
      errors.push(error);
      failures++;
      item.error = error.message;
    }
  }
  const depth = (key: string) => key.split("/").length;
  // Serial directories ensure parent creation is complete before a child starts.
  for (const op of operations
    .filter(([, p]) => ["mkdirLocal", "mkdirRemote"].includes(p.decision))
    .sort(([a], [b]) => depth(a) - depth(b)))
    await run(op);
  const transfers = operations.filter(([, p]) =>
    ["pull", "push"].includes(p.decision)
  );
  let cursor = 0;
  const concurrency = Number.isFinite(input.concurrency)
    ? Math.max(1, Math.floor(input.concurrency!))
    : 5;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, transfers.length) },
      async () => {
        while (cursor < transfers.length && failures < 10)
          await run(transfers[cursor++]);
      }
    )
  );
  for (const op of operations.filter(
    ([key, p]) =>
      !folder(key) && ["deleteLocal", "deleteRemote"].includes(p.decision)
  ))
    await run(op);
  for (const op of operations
    .filter(
      ([key, p]) =>
        folder(key) && ["deleteLocal", "deleteRemote"].includes(p.decision)
    )
    .sort(([a], [b]) => depth(b) - depth(a)))
    await run(op);
  for (const op of operations.filter(([, p]) =>
    ["record", "clear"].includes(p.decision)
  ))
    await run(op);
  for (const [key, p] of operations)
    if (!completed.has(key) && !p.error)
      p.reason += "；累计错误达到上限，本项未启动";
}
