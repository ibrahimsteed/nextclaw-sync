import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import ts from "typescript";
import { SyncQueue } from "../../src/nextclaw/syncQueue";
const source = ts.createSourceFile(
  "main.ts",
  readFileSync(path.resolve(__dirname, "../../src/main.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true
);
const methods = new Map<string, string>();
const visit = (n: ts.Node) => {
  if (ts.isMethodDeclaration(n)) methods.set(n.name.getText(source), n.getText(source));
  ts.forEachChild(n, visit);
};
visit(source);
const method = methods.get("requestRecoverySync");
assert.ok(method);
const compiled = ts.transpileModule(
  method.replace(/^requestRecoverySync/, "function recover"),
  { compilerOptions: { target: ts.ScriptTarget.ES2020 } }
).outputText;
const recover = new Function(`${compiled};return recover;`)();

describe("first Android B startup dispatch", () => {
  const initializer = methods.get("initialize")!;
  const begin = initializer.indexOf("let startupMerged = false");
  const end = initializer.indexOf("this.toggleSyncOnSaveIfSet();", begin);
  assert.ok(begin >= 0 && end > begin);
  const initialize = new Function("Platform", "takeFirstBRecovery", "window", initializer.slice(begin, end));
  const setupInit = new Function(`${methods.get("enableInitSyncIfSet")!.replace(/^enableInitSyncIfSet/, "function setupInit")}; return setupInit;`)();

  async function run(marker: string | undefined, startupDelay: number, fileEvent = false) {
    const events: unknown[][] = [], layoutCallbacks: (() => void)[] = [];
    const pending = new Map<number, { run: () => void; at: number }>();
    let now = 0, timerId = 0;
    const clock = {
      setTimeout(run: () => void, delay: number) {
        pending.set(++timerId, {run, at:now+delay});
        return timerId as ReturnType<Window["setTimeout"]>;
      },
      clearTimeout(id: ReturnType<Window["setTimeout"]>) { pending.delete(Number(id)); },
    };
    const owner = {
      settings: {syncDirection:"bidirectional", initRunAfterMilliseconds:startupDelay, syncOnSaveAfterMilliseconds:30000},
      app: {workspace:{onLayoutReady(fn: () => void){layoutCallbacks.push(fn);}}, vault:{on(){}}},
      deferredTasks: {disposed:false, schedule:clock.setTimeout},
      firstBRecoveryScope: () => "this-vault",
      requestRecoverySync: recover,
      enableAutoSyncIfSet(){},
      enableInitSyncIfSet: setupInit,
      registerEvent(){},
      syncRun(source: string){events.push([now,source]);},
      syncQueue: new SyncQueue(async (saveOnly, scope) => {
        events.push([now,"queued",saveOnly,scope]);
        return "ok";
      },clock),
    };
    initialize.call(owner,{isAndroidApp:true},(_window: unknown, scope: string)=>marker===scope?marker:undefined,{});
    for(const fn of layoutCallbacks)fn();
    if(fileEvent) clock.setTimeout(()=>owner.syncQueue.request(0,true),5000);
    while(pending.size) {
      const [id, timer] = [...pending].sort((a,b)=>a[1].at-b[1].at)[0];
      pending.delete(id);
      now=timer.at;
      timer.run();
      await Promise.resolve();
    }
    return events;
  }

  it("uses one startup timer with the configured delay and bound recovery", async () => {
    assert.deepEqual(await run("this-vault",30000), [[30000,"queued",false,"this-vault"]]);
  });
  it("keeps the original recovery timing with startup disabled", async () => {
    assert.deepEqual(await run("this-vault",-1), [[3000,"queued",false,"this-vault"]]);
  });
  it("preserves both normal startup triggers when handoff is absent or mismatched", async () => {
    for (const marker of [undefined,"another-vault"]) {
      assert.deepEqual(await run(marker,30000), [[3000,"queued",false,undefined],[30000,"auto_once_init"]]);
    }
  });
  it("retains real file work and drops the clean-only recovery qualification when it merges", async () => {
    assert.deepEqual(await run("this-vault",30000,true), [[5000,"queued",false,undefined]]);
  });
});
describe("production recovery trigger policy", () => {
  for (const source of ["save", "interval", "startup"]) {
    it(`rescan after reload/online/foreground with only ${source} enabled`, () => {
      const delays: number[] = [];
      const settings: any = {
        syncDirection: "bidirectional",
        syncOnSaveAfterMilliseconds: -1,
        autoRunEveryMilliseconds: -1,
        initRunAfterMilliseconds: -1,
      };
      settings[
        source === "save"
          ? "syncOnSaveAfterMilliseconds"
          : source === "interval"
            ? "autoRunEveryMilliseconds"
            : "initRunAfterMilliseconds"
      ] = 30000;
      recover.call({
        deferredTasks: { disposed: false },
        settings,
        syncQueue: { request: (delay: number) => delays.push(delay) },
      });
      assert.deepEqual(delays, [3000]);
    });
  }
  for (const settings of [
    {
      syncDirection: "bidirectional",
      syncOnSaveAfterMilliseconds: -1,
      autoRunEveryMilliseconds: -1,
      initRunAfterMilliseconds: -1,
    },
    {
      syncDirection: "incremental_pull_only",
      syncOnSaveAfterMilliseconds: 30000,
    },
  ]) {
    it(`does not introduce unsolicited automatic sync for ${JSON.stringify(settings)}`, () => {
      const delays: number[] = [];
      recover.call({
        deferredTasks: { disposed: false },
        settings,
        syncQueue: { request: (n: number) => delays.push(n) },
      });
      assert.deepEqual(delays, []);
    });
  }
});

it("does not schedule recovery after the plugin owner is disposed", () => {
  let requests = 0;
  recover.call({deferredTasks:{disposed:true},settings:{syncDirection:"bidirectional",syncOnSaveAfterMilliseconds:30000},syncQueue:{request(){requests++;}}});
  assert.equal(requests,0);
});

it("does not inspect unavailable settings or queue recovery during retirement wait",()=>{
  let requests=0;
  recover.call({deferredTasks:{disposed:false},initializationWaiting:true,settings:undefined,syncQueue:{request(){requests++;}}});
  assert.equal(requests,0);
});
