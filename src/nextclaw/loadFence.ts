/** Retired loads may finish an admitted request, but cannot start another one. */
export function fence<T extends object>(target: T, stopped: () => boolean): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (stopped()) throw new Error("NextClaw plugin load has been unloaded");
        return Reflect.apply(value, object, args) as unknown;
      };
    },
  });
}

// The host outlives bundle evaluation. A new load waits for retired I/O before
// opening its database or starting sync; no permanent reference to old plugins.
type Host = { nextclawRetiredLoads?: Map<string, Promise<void>> };
export function retireLoad(container: object, key: string, pending?: Promise<void>) {
  if (!pending) return;
  const host = container as Host;
  const loads = host.nextclawRetiredLoads ??= new Map<string, Promise<void>>();
  const previous = loads.get(key);
  const done = Promise.allSettled([previous, pending]).then(() => {});
  loads.set(key, done);
  void done.then(() => {
    if (loads.get(key) === done) loads.delete(key);
    if (!loads.size && host.nextclawRetiredLoads === loads) delete host.nextclawRetiredLoads;
  });
}
export async function waitForRetiredLoad(container: object, key: string) {
  const host = container as Host;
  while (host.nextclawRetiredLoads?.has(key)) await host.nextclawRetiredLoads.get(key);
}

/** Query without attaching another load to an unresolvable native promise. */
export function hasRetiredLoad(container: object, key: string): boolean {
  return (container as Host).nextclawRetiredLoads?.has(key) === true;
}
