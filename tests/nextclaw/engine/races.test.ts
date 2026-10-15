import { strict as assert } from "assert";
import { buildPlan } from "../../../src/nextclaw/engine/plan";
import { executePlan } from "../../../src/nextclaw/engine/execute";
import { harness, record, text } from "./helpers";

async function planned() {
  const h = harness();
  return {
    h,
    plan: async () =>
      buildPlan(
        h.input,
        await h.local.walk(),
        await h.remote.walk(),
        Object.values(h.records)
      ),
  };
}
describe("scan-to-execution races preserve newer content", () => {
  it("does not overwrite a remote edit made after discovery", async () => {
    const { h, plan } = await planned();
    h.local.put("note.md", "local edit", 30000);
    h.remote.put("note.md");
    h.seed(record());
    const p = await plan();
    h.remote.put("note.md", "OpenClaw later", 40000);
    const errors: Error[] = [];
    await executePlan(h.input, p, errors);
    assert.equal(text(await h.remote.readFile("note.md")), "OpenClaw later");
    assert.ok(errors.length);
    assert.equal(h.saved(), 0);
  });
  it("does not overwrite a same-name remote file created after discovery", async () => {
    const { h, plan } = await planned();
    h.local.put("note.md", "mine");
    const p = await plan();
    h.remote.put("note.md", "theirs", 40000);
    const errors: Error[] = [];
    await executePlan(h.input, p, errors);
    assert.equal(text(await h.remote.readFile("note.md")), "theirs");
    assert.ok(errors.length);
  });
  it("does not overwrite a local edit made during download", async () => {
    const { h, plan } = await planned();
    h.local.put("note.md");
    h.remote.put("note.md", "remote edit", 30000);
    h.seed(record());
    const p = await plan();
    const read = h.remote.readFile.bind(h.remote);
    h.remote.readFile = async (key) => {
      const b = await read(key);
      h.local.put(key, "typed during download", 40000);
      return b;
    };
    const errors: Error[] = [];
    await executePlan(h.input, p, errors);
    assert.equal(
      text(await h.local.readFile("note.md")),
      "typed during download"
    );
    assert.ok(errors.length);
    assert.equal(h.saved(), 0);
  });
  for (const side of ["local", "remote"] as const) {
    it(`does not delete a ${side} edit made after discovery`, async () => {
      const { h, plan } = await planned();
      h[side].put("note.md");
      h.seed(record());
      const p = await plan();
      h[side].put("note.md", "later edit", 40000);
      const errors: Error[] = [];
      await executePlan(h.input, p, errors);
      assert.equal(text(await h[side].readFile("note.md")), "later edit");
      assert.ok(errors.length);
      assert.equal(h.saved(), 0);
    });
  }
});

describe("conflict preservation and journal accuracy", () => {
  it("preserves the remote loser before overwriting a discovered two-sided conflict", async () => {
    const h = harness();
    h.local.put("note.md", "local", 40000);
    h.remote.put("note.md", "remote", 30000);
    h.seed(record());
    const p = buildPlan(
      h.input,
      await h.local.walk(),
      await h.remote.walk(),
      Object.values(h.records)
    );
    const errors: Error[] = [];
    await executePlan(h.input, p, errors);
    assert.deepEqual(errors, []);
    assert.equal(text(await h.remote.readFile("note.md")), "local");
    assert.ok(
      [...h.local.files].some(
        ([k, v]) => k.includes(".sync-conflict-") && text(v.bytes) === "remote"
      )
    );
  });
  it("does not equate equal-size equal-time initial files with equal content", async () => {
    const h = harness();
    h.local.put("note.md", "aaa");
    h.remote.put("note.md", "bbb");
    const p = buildPlan(
      h.input,
      await h.local.walk(),
      await h.remote.walk(),
      []
    );
    const errors: Error[] = [];
    await executePlan(h.input, p, errors);
    assert.deepEqual(errors, []);
    assert.equal(text(await h.remote.readFile("note.md")), "aaa");
    assert.ok(
      [...h.local.files].some(
        ([k, v]) => k.includes(".sync-conflict-") && text(v.bytes) === "bbb"
      )
    );
  });
  it("does not hide a same-size remote ETag change behind unchanged timestamps", async () => {
    const h = harness();
    h.local.put("note.md");
    h.remote.put("note.md");
    h.remote.files.get("note.md")!.entity.etag = "v2";
    h.seed(
      record("note.md", { remote: { mtime: 10000, size: 1, etag: "v1" } })
    );
    const p = buildPlan(
      h.input,
      await h.local.walk(),
      await h.remote.walk(),
      Object.values(h.records)
    );
    assert.equal(p["note.md"].decision, "pull");
  });
});

describe("restart reconstructs work from files and journal", () => {
  it("a failed upload remains discoverable without any in-memory pending flag", async () => {
    const h = harness();
    h.local.put("note.md", "offline edit", 40000);
    h.remote.put("note.md");
    h.seed(record());
    const previous = structuredClone(h.records);
    h.remote.fail = (op) => op === "writeFile";
    const { runSync } = await import("../../../src/nextclaw/syncEngine");
    assert.equal((await runSync(h.input)).ok, false);
    assert.deepEqual(h.records, previous);
    // A new engine run has no scheduler/event state; only disk and journal remain.
    h.remote.fail = () => false;
    assert.equal((await runSync({ ...h.input })).ok, true);
    assert.equal(text(await h.remote.readFile("note.md")), "offline edit");
    assert.equal((await runSync({ ...h.input })).ok, true);
    assert.equal(h.last()["note.md"].decision, "none");
  });
});

describe("source edits during upload", () => {
  it("does not acknowledge an edit newer than the actual uploaded bytes", async () => {
    const h=harness();h.local.put("note.md","first",30000);h.remote.put("note.md");h.seed(record());
    const p=buildPlan(h.input,await h.local.walk(),await h.remote.walk(),Object.values(h.records));
    const write=h.remote.writeFileGuarded.bind(h.remote);
    h.remote.writeFileGuarded=async(...args)=>{const result=await write(...args);h.local.put("note.md","later",30000);return result;};
    const errors:Error[]=[];await executePlan(h.input,p,errors);
    assert.equal(text(await h.local.readFile("note.md")),"later");
    assert.equal(text(await h.remote.readFile("note.md")),"first");
    assert.ok(errors.length);assert.equal(h.saved(),0);
    assert.ok([...h.local.files].some(([k,v])=>k.includes(".sync-conflict-")&&text(v.bytes)==="first"));
  });
});

describe("deferred directories cannot starve unrelated safe work", () => {
  it("records a safe file even after more than ten paused directory deletions", async () => {
    const h=harness();
    for(let i=0;i<12;i++){const key=`old-${i}/`;h.local.put(key);h.seed(record(key));}
    h.local.put("safe.md","same");h.remote.put("safe.md","same");
    const p=buildPlan(h.input,await h.local.walk(),await h.remote.walk(),Object.values(h.records));
    const errors:Error[]=[];await executePlan(h.input,p,errors);
    assert.equal(errors.length,12);assert.ok(h.rec("safe.md"));
    assert.ok(errors.every(e=>e.message.includes("目录删除暂缓")));
  });
});
