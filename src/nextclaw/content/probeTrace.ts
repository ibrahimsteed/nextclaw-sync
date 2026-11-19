let sequence = 0;
type Sink = (payload: string) => void;

export function probeEvent(path: string, phase: string, detail: Record<string, string | number> = {}) {
  const sink = (globalThis as { __nextclawSmallFileProbe?: Sink }).__nextclawSmallFileProbe;
  if (typeof sink !== "function") return;
  sink(JSON.stringify({ sequence: ++sequence, doc: performance.timeOrigin, ms: performance.now(), path, phase, ...detail }));
}

export async function probeSpan<T>(path: string, phase: string, work: () => Promise<T>) {
  const span = sequence + 1;
  probeEvent(path, phase + ":start", { span });
  try {
    const value = await work();
    probeEvent(path, phase + ":ok", { span });
    return value;
  } catch (error) {
    probeEvent(path, phase + ":failed", { span });
    throw error;
  }
}
