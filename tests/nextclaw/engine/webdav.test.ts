import { createServer } from "node:http";
import { createClient } from "webdav";
import { strict as assert } from "assert";
import { buildSync } from "esbuild";
import * as path from "path";

// Execute the real adapter, replacing only the WebDAV transport and Obsidian host.
function adapter(client: any) {
  const code = buildSync({
    entryPoints: [path.resolve(__dirname, "../../../src/fsWebdav.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["obsidian", "webdav/dist/web/index.js"],
    logLevel: "silent",
  }).outputFiles[0].text;
  const mod = { exports: {} as any };
  const load = (name: string) =>
    name === "obsidian"
      ? { Platform: { isAndroidApp: false }, requireApiVersion: () => false }
      : name === "webdav/dist/web/index.js"
        ? {
            createClient: () => client,
            AuthType: { Password: "password", Digest: "digest" },
            getPatcher: () => ({ patch() {} }),
          }
        : require(name);
  new Function("require", "module", "exports", code)(load, mod, mod.exports);
  return new mod.exports.FakeFsWebdav(
    {
      address: "https://test.invalid",
      username: "test",
      password: "not-a-credential",
      remoteBaseDir: "vault",
      manualRecursive: true,
      depth: "manual_1",
    },
    "test",
    async () => {}
  );
}
describe("§8.1 §8.3 actual WebDAV adapter", () => {
  for (const status of [403, 401, 500, 404, undefined])
    it(`rm status ${status}`, async () => {
      const failure = Object.assign(new Error("transport error"), { status });
      const client = {
        deleteFile: async () => {
          throw failure;
        },
      };
      const fs = adapter(client);
      fs.client = client;
      fs.vaultFolderExists = true;
      if (status === 404) await fs.rm("a.md");
      else await assert.rejects(fs.rm("a.md"), (e) => e === failure);
    });
  it("successful delete invokes the scoped path", async () => {
    const calls: string[] = [];
    const client = {
      deleteFile: async (key: string) => {
        calls.push(key);
      },
    };
    const fs = adapter(client);
    fs.client = client;
    fs.vaultFolderExists = true;
    await fs.rm("a.md");
    assert.deepEqual(calls, ["/vault/a.md"]);
  });
  it("_init missing root throws with path and never creates; retry checks again", async () => {
    let checks = 0,
      creates = 0;
    const fs = adapter({
      exists: async () => {
        checks++;
        return false;
      },
      createDirectory: async () => {
        creates++;
      },
    });
    await assert.rejects(fs.stat("/"), /\/vault\//);
    await assert.rejects(fs.stat("/"), /\/vault\//);
    assert.equal(creates, 0);
    assert.equal(checks, 2);
    assert.equal(fs.vaultFolderExists, false);
  });
  for (const status of [401, 403, undefined])
    it(`_init check failure ${status} propagates original`, async () => {
      const failure = Object.assign(new Error("check failed"), { status });
      let creates = 0;
      const fs = adapter({
        exists: async () => {
          throw failure;
        },
        createDirectory: async () => {
          creates++;
        },
      });
      await assert.rejects(fs.stat("/"), (e) => e === failure);
      assert.equal(creates, 0);
    });
  it("existing root keeps compliance probe, stat, and cached initialization", async () => {
    let checks = 0,
      probes = 0;
    const fs = adapter({
      exists: async () => {
        checks++;
        return true;
      },
      getDAVCompliance: async () => {
        probes++;
        return { compliance: [], server: "test" };
      },
      stat: async () => ({
        filename: "/vault",
        type: "directory",
        size: 0,
        lastmod: "Sun, 13 Sep 2026 00:00:00 GMT",
      }),
    });
    await fs.stat("/");
    await fs.stat("/");
    assert.equal(checks, 1);
    assert.equal(probes, 1);
    assert.equal(fs.vaultFolderExists, true);
  });
});

describe("conditional WebDAV operations", () => {
  const version = { key: "a.md", keyRaw: "a.md", sizeRaw: 1, etag: "v1" };
  function setup(tag = '"v2"') {
    const requests: any[] = [];
    const client = {
      customRequest: async (key: string, options: any) => {
        requests.push({ key, ...options });
        return { headers: new Headers({ etag: tag }) };
      },
      stat: async () => ({
        filename: "/vault/a.md",
        type: "file",
        size: 1,
        etag: "v2",
        lastmod: "2026-10-15T00:00:00Z",
      }),
      getFileContents: async (_key: string, opts: any) => {
        requests.push(opts);
        return new Uint8Array([1]).buffer;
      },
    };
    const fs = adapter(client);
    fs.client = client;
    fs.vaultFolderExists = true;
    return { fs, client, requests };
  }
  it("puts the discovery ETag on the actual PUT, including large files", async () => {
    const h = setup();
    const bytes = new ArrayBuffer(11 * 1024 * 1024);
    await h.fs.writeFileGuarded("a.md", bytes, 0, 0, version);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].method, "PUT");
    assert.equal(h.requests[0].headers["If-Match"], '"v1"');
    assert.equal(h.requests[0].data, bytes);
  });
  it("uses create-only for new files", async () => {
    const h = setup();
    await h.fs.writeFileGuarded("a.md", new ArrayBuffer(1), 0, 0, null);
    assert.equal(h.requests[0].headers["If-None-Match"], "*");
  });
  it("preserves the observed ETag during listing/stat", async () => {
    const h = setup();
    assert.equal((await h.fs.stat("a.md")).etag, "v2");
  });
  it("binds downloads and deletes to the discovered version", async () => {
    const h = setup();
    await h.fs.readFile("a.md", version);
    await h.fs.rmGuarded("a.md", version);
    assert.equal(h.requests[0].headers["If-Match"], '"v1"');
    assert.equal(h.requests[1].method, "DELETE");
    assert.equal(h.requests[1].headers["If-Match"], '"v1"');
  });
  for (const tag of [undefined, "W/v1"]) {
    it(`refuses missing/weak validators ${tag} without network mutation`, async () => {
      const h = setup();
      await assert.rejects(
        h.fs.writeFileGuarded("a.md", new ArrayBuffer(1), 0, 0, {
          ...version,
          etag: tag,
        }),
        /ETag/
      );
      assert.equal(h.requests.length, 0);
    });
  }
  it("does not retry a rejected condition unconditionally", async () => {
    const h = setup();
    const failure = Object.assign(new Error("changed"), { status: 412 });
    h.client.customRequest = async (key, opts) => {
      h.requests.push({ key, ...opts });
      throw failure;
    };
    await assert.rejects(
      h.fs.writeFileGuarded("a.md", new ArrayBuffer(1), 0, 0, version),
      (e) => e === failure
    );
    assert.equal(h.requests.length, 1);
  });
  it("does not acknowledge another writer's version after PUT", async () => {
    const h = setup('"different-from-stat"');
    await assert.rejects(
      h.fs.writeFileGuarded("a.md", new ArrayBuffer(1), 0, 0, version),
      /版本无法确认/
    );
  });
});

describe("real HTTP WebDAV preconditions", () => {
  it("a stale plan cannot PUT or DELETE a newer server version", async () => {
    let data = "server-new",
      tag = '"v2"';
    const calls: Array<{ method: string; match: unknown; none: unknown }> = [];
    const server = createServer((req, res) => {
      calls.push({
        method: req.method!,
        match: req.headers["if-match"],
        none: req.headers["if-none-match"],
      });
      if (
        (req.headers["if-match"] && req.headers["if-match"] !== tag) ||
        (req.headers["if-none-match"] === "*" && data !== "")
      ) {
        res.writeHead(412);
        res.end();
        return;
      }
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (b) => chunks.push(b));
        req.on("end", () => {
          data = Buffer.concat(chunks).toString();
          tag = '"v3"';
          res.writeHead(204, { ETag: tag });
          res.end();
        });
      } else if (req.method === "GET") {
        res.writeHead(200, { ETag: tag });
        res.end(data);
      } else {
        data = "";
        res.writeHead(204);
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    try {
      const address = server.address() as { port: number };
      const client = createClient(`http://127.0.0.1:${address.port}`);
      client.stat = async () => ({
        filename: "/vault/a.md",
        basename: "a.md",
        type: "file",
        size: data.length,
        etag: tag.replace(/"/g, ""),
        lastmod: "2026-10-15T00:00:00Z",
      });
      const fs = adapter(client);
      fs.client = client;
      fs.vaultFolderExists = true;
      const old = { key: "a.md", keyRaw: "a.md", sizeRaw: 3, etag: "v1" };
      for (const action of [
        () =>
          fs.writeFileGuarded(
            "a.md",
            new TextEncoder().encode("mine").buffer,
            0,
            0,
            old
          ),
        () => fs.rmGuarded("a.md", old),
        () => fs.readFile("a.md", old),
        () => fs.writeFileGuarded("a.md", new ArrayBuffer(1), 0, 0, null),
      ]) {
        await assert.rejects(action, (e: any) => e.status === 412);
        assert.equal(data, "server-new");
      }
      assert.equal(calls.length, 4);
      await fs.writeFileGuarded(
        "a.md",
        new TextEncoder().encode("mine").buffer,
        0,
        0,
        { ...old, etag: "v2" }
      );
      assert.equal(data, "mine");
      assert.equal(calls.at(-1)!.match, '"v2"');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      );
    }
  });
});
