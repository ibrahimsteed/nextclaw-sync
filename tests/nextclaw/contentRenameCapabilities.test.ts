import { strict as assert } from "assert";
import { buildSync } from "esbuild";
import * as path from "path";

// Use the shipped browser client and plugin native journal with an in-memory requestUrl edge.
const bundle = buildSync({
  stdin: {
    contents: `export { FakeFsWebdav } from './src/fsWebdav';
      export { NativeWriteJournal, NativeWritePaused } from './src/nextclaw/nativeWriteJournal';
      export { createClient } from 'webdav/dist/web/index.js';`,
    resolveDir: path.resolve(__dirname, "../.."), loader: "ts",
  },
  bundle: true, platform: "node", format: "cjs", external: ["obsidian"], write: false,
}).outputFiles[0].text;

const dav = "https://fixture.invalid/remote.php/dav/files/synthetic";
const source = "/vault/a.md";
const destination = `${dav}/vault/b.md`;
type WireRequest = { url: string; method: string; headers: Record<string, string> };
type Files = Map<string, { text: string; etag: string }>;

function makeHost(deliver: (request: WireRequest) => number) {
  const wire: WireRequest[] = [];
  const registrations = new Map<string, string>();
  const inFlight: string[] = [];
  const storage = {
    getItem: (key: string) => registrations.get(key) ?? null,
    setItem: (key: string, value: string) => { registrations.set(key, value); },
    removeItem: (key: string) => { registrations.delete(key); },
  };
  const module = { exports: {} as any };
  const requireHost = (name: string) => name === "obsidian" ? {
    Platform: { isAndroidApp: true, isIosApp: false }, requireApiVersion: () => true,
    requestUrl: async (request: WireRequest) => {
      wire.push(request);
      inFlight.push(registrations.get("fixture-vault")!);
      return { status: deliver(request), headers: {}, arrayBuffer: new ArrayBuffer(0) };
    },
  } : require(name);
  const browser = {
    Headers, Request, Response,
    fetch: () => { throw new Error("MOVE capability tests must use requestUrl"); },
  };
  new Function("require", "module", "exports", "self", "window", bundle)(
    requireHost, module, module.exports, browser, browser,
  );
  const lib = module.exports;
  function open() {
    const owner = new lib.NativeWriteJournal(storage, "fixture-vault");
    const client = lib.createClient(dav, { headers: { "x-nextclaw-native-owner": owner.token } });
    const remote = new lib.FakeFsWebdav({ address: dav, remoteBaseDir: "vault" }, "vault", async () => {}, owner);
    remote.client = client;
    remote.vaultFolderExists = true;
    const move = () => remote.moveContent("a.md", "b.md", '"v1"');
    return { owner, remote, move };
  }
  return { wire, registrations, inFlight, lib, open };
}

function conditionalMove(request: WireRequest, files: Files): number {
  const current = files.get(request.url);
  if (!current || current.etag !== request.headers["if-match"] ||
      (request.headers.overwrite === "F" && files.has(request.headers.destination))) return 412;
  files.set(request.headers.destination, current);
  files.delete(request.url);
  return 201;
}

describe("P3 offline MOVE transport capability", () => {
  it("records the raw baseline rename defaults", async () => {
    const host = makeHost(() => 201);
    const { owner, remote } = host.open();
    try {
      await remote.rename("a.md", "b.md");
      assert.equal(host.wire.length, 1);
      const request = host.wire[0];
      assert.equal(request.method, "MOVE");
      assert.equal(request.url, dav + source);
      assert.equal(request.headers.destination, destination);
      assert.equal(request.headers.overwrite, "T");
      assert.equal(request.headers["if-match"], undefined);
    } finally { owner.retire(); }
  });

  for (const race of ["none", "source-changed", "target-created"]) {
    it(`carries both guards to the native edge: ${race}`, async () => {
      const files: Files = new Map([[dav + source, { text: "base", etag: '"v1"' }]]);
      const host = makeHost(request => {
        if (race === "source-changed") files.set(dav + source, { text: "new source", etag: '"v2"' });
        if (race === "target-created") files.set(destination, { text: "other writer", etag: '"b"' });
        return conditionalMove(request, files);
      });
      const { owner, move } = host.open();
      try {
        assert.equal((await move()).status, race === "none" ? 201 : 412);
        assert.equal(host.wire.length, 1);
        const request = host.wire[0];
        assert.equal(request.headers["if-match"], '"v1"');
        assert.equal(request.headers.destination, destination);
        assert.equal(request.headers.overwrite, "F");
        assert.equal(request.headers["x-nextclaw-native-owner"], undefined);
        assert.equal(owner.blocked(), false);
        assert.equal(host.registrations.size, 0);
        assert.equal(files.get(dav + source)?.text, race === "none" ? undefined : race === "source-changed" ? "new source" : "base");
        assert.equal(files.get(destination)?.text, race === "none" ? "base" : race === "target-created" ? "other writer" : undefined);
      } finally { owner.retire(); }
    });
  }

  for (const ambiguous of [204, 504]) {
    it(`keeps an ambiguous MOVE ${ambiguous} and its exact target isolated on reload`, async () => {
      const host = makeHost(() => ambiguous);
      const first = host.open();
      try {
        await assert.rejects(first.move, host.lib.NativeWritePaused);
        const registration = host.registrations.get("fixture-vault");
        assert.equal(registration, host.inFlight[0]);
        const { operations } = JSON.parse(registration!);
        assert.equal(operations.length, 1);
        assert.deepEqual({ method: operations[0].method, path: operations[0].path, expected: operations[0].expected },
          { method: "MOVE", path: new URL(dav + source).pathname, expected: '"v1"' });
        assert.equal(operations[0].destination, new URL(destination).pathname);
        assert.equal(operations[0].overwrite, "F");
        first.owner.retire();
        const restored = host.open();
        try {
          assert.equal(restored.owner.blocked(), true);
          await assert.rejects(restored.move, host.lib.NativeWritePaused);
          assert.equal(host.wire.length, 1);
          assert.equal(host.registrations.get("fixture-vault"), registration);
        } finally { restored.owner.retire(); }
      } finally { first.owner.retire(); }
    });
  }

  it("binds both pathnames after encoding the same configured root", async () => {
    const host = makeHost(() => 201);
    const { remote, owner } = host.open();
    try {
      await remote.moveContent("旧 #.md", "new %.md", '"v1"');
      const request = host.wire[0];
      assert.equal(host.wire.length, 1);
      assert.equal(request.url, dav + "/vault/" + encodeURIComponent("旧 #.md"));
      assert.equal(request.headers.destination, dav + "/vault/" + encodeURIComponent("new %.md"));
      const op = JSON.parse(host.inFlight[0]).operations[0];
      assert.equal(op.path, new URL(request.url).pathname);
      assert.equal(op.destination, new URL(request.headers.destination).pathname);
    } finally { owner.retire(); }
  });

  it("does not settle a successful response against a modified destination registration", async () => {
    const host = makeHost(() => {
      const raw = JSON.parse(host.registrations.get("fixture-vault")!);
      raw.operations[0].destination += ".different";
      host.registrations.set("fixture-vault", JSON.stringify(raw));
      return 201;
    });
    const { owner, move } = host.open();
    try {
      await assert.rejects(move, host.lib.NativeWritePaused);
      assert.equal(owner.blocked(), true);
      assert.equal(host.wire.length, 1);
    } finally { owner.retire(); }
  });
});
