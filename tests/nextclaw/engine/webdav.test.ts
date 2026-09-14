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
