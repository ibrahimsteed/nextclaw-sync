import { davContentProperties } from "./nextclaw/content/identity";
import { dispatchNative, terminalReceipt, NATIVE_OWNER_HEADER, NativeWritePaused, type NativeWriteJournal } from "./nextclaw/nativeWriteJournal";
import { etagHeader, isOrdinaryMovePath, isStrongMoveEtag, SyncConflict } from "./nextclaw/engine/versionGuard";
import { Queue } from "@fyears/tsqueue";
import { getReasonPhrase } from "http-status-codes/build/cjs/utils-functions";
import { Platform, type RequestUrlParam, requestUrl } from "obsidian";
import {
  AuthType,
  type BufferLike,
  type FileStat,
  type RequestOptionsWithState,
  type WebDAVClient,
  createClient,
  getPatcher,
} from "webdav/dist/web/index.js";
import type { Entity, WebdavConfig } from "./baseTypes";
import { VALID_REQURL } from "./baseTypesObs";
import { FakeFs } from "./fsAll";
import {
  bufferToArrayBuffer,
  chunkArray,
  headerValueToText,
  splitFileSizeToChunkRanges,
} from "./misc";

// Nextcloud omits optional identities from allprop (including allprop+include).
// Ask explicitly while retaining the standard fields needed by the adapter.
const DAV_CONTENT_PROPFIND = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:getcontenttype/><d:displayname/><oc:fileid/><oc:checksums/></d:prop></d:propfind>';

/** 字符串是否只含 ISO-8859-1 字符（可直接放进 HTTP 头）。 */
function onlyLatin1(str: string) {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 0xff) {
      return false;
    }
  }
  return true;
}

function objKeyToLower(obj: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v])
  );
}

if (VALID_REQURL) {
  // 用 Obsidian 的 requestUrl 发请求，绕开 CORS。
  getPatcher().patch(
    "request",
    async (...args: unknown[]): Promise<Response> => {
      const options = args[0] as RequestOptionsWithState;
      const transformedHeaders = objKeyToLower({ ...options.headers });
      const ownerToken = transformedHeaders[NATIVE_OWNER_HEADER];
      delete transformedHeaders[NATIVE_OWNER_HEADER];
      delete transformedHeaders["x-nextclaw-local-transport"];
      delete transformedHeaders["host"];
      delete transformedHeaders["content-length"];
      const reqContentType =
        transformedHeaders["accept"] ?? transformedHeaders["content-type"];

      const p: RequestUrlParam = {
        url: options.url,
        method: options.method,
        body: options.data as string | ArrayBuffer,
        headers: transformedHeaders,
        contentType: reqContentType,
        throw: false,
      };

      const guardedMove = p.method?.toUpperCase() === "MOVE" && transformedHeaders.overwrite === "F" &&
        Object.prototype.hasOwnProperty.call(transformedHeaders, "if-match");
      if (guardedMove && (!isStrongMoveEtag(transformedHeaders["if-match"]) || !transformedHeaders.destination))
        throw new SyncConflict("受保护改名缺少源版本或目标");
      let r = await dispatchNative(ownerToken, p.method!, p.url,
        transformedHeaders["if-match"] ?? transformedHeaders["if-none-match"] ?? null,
        () => requestUrl(p), guardedMove ? transformedHeaders.destination : undefined);

      if (
        r.status === 401 &&
        Platform.isIosApp &&
        !options.url.endsWith("/") &&
        !options.url.endsWith(".md") &&
        options.method.toUpperCase() === "PROPFIND"
      ) {
        // 某些服务器对不带斜杠的文件夹返回 401 而不是 404，补上斜杠重试。
        p.url = `${options.url}/`;
        r = await requestUrl(p);
      }

      const rspHeaders = objKeyToLower({ ...r.headers });
      for (const key of Object.keys(rspHeaders)) {
        const text = headerValueToText(rspHeaders[key]);
        // Response 的头只允许 ISO-8859-1 字符，否则构造时报错。
        rspHeaders[key] = onlyLatin1(text) ? text : encodeURIComponent(text);
      }

      const statusText = getReasonPhrase(r.status);
      // 101、103、204、205、304 不能带响应体。
      // https://fetch.spec.whatwg.org/#statuses
      const nullBody = [101, 103, 204, 205, 304].includes(r.status);
      return new Response(nullBody ? null : r.arrayBuffer, {
        status: r.status,
        statusText: statusText,
        headers: rspHeaders,
      });
    }
  );
}

export const DEFAULT_WEBDAV_CONFIG = {
  address: "",
  username: "",
  password: "",
  authType: "basic",
  manualRecursive: true,
  depth: "manual_1",
  remoteBaseDir: "",
} as WebdavConfig;

const getWebdavPath = (fileOrFolderPath: string, remoteBaseDir: string) => {
  let key = fileOrFolderPath;
  if (fileOrFolderPath === "/" || fileOrFolderPath === "") {
    // special
    key = `/${remoteBaseDir}/`;
  } else if (fileOrFolderPath.startsWith("/")) {
    console.warn(
      `why the path ${fileOrFolderPath} starts with '/'? but we just go on.`
    );
    key = `/${remoteBaseDir}${fileOrFolderPath}`;
  } else {
    key = `/${remoteBaseDir}/${fileOrFolderPath}`;
  }
  return key;
};

/**
 * sometimes the path startswith /../../......
 * we want to make sure the path is compatible
 */
const stripLeadingPath = (x: string) => {
  let y = x;
  while (y.startsWith("/..")) {
    y = y.slice("/..".length);
  }
  return y;
};

const getNormPath = (fileOrFolderPath: string, remoteBaseDir: string) => {
  const strippedFileOrFolderPath = stripLeadingPath(fileOrFolderPath);
  if (
    !(
      strippedFileOrFolderPath === `/${remoteBaseDir}` ||
      strippedFileOrFolderPath.startsWith(`/${remoteBaseDir}/`)
    )
  ) {
    throw Error(
      `"${fileOrFolderPath}" after stripping doesn't starts with "/${remoteBaseDir}/"`
    );
  }
  const result = strippedFileOrFolderPath.slice(`/${remoteBaseDir}/`.length);
  return result;
};

const fromWebdavItemToEntity = (x: FileStat, remoteBaseDir: string): Entity => {
  let key = getNormPath(x.filename, remoteBaseDir);

  if (x.type === "directory" && !key.endsWith("/")) {
    key = `${key}/`;
  }
  const mtimeSvr = Date.parse(x.lastmod).valueOf();
  return {
    key: key,
    keyRaw: key,
    etag: x.etag ?? undefined,
    ...davContentProperties((x as FileStat & { props?: unknown }).props),
    mtimeSvr: mtimeSvr,
    mtimeCli: mtimeSvr, // TODO: no universal way to set mtime in webdav
    size: x.size,
    sizeRaw: x.size,
  };
};

const tryEncodeURI = (x: string) => {
  if (x.includes("%")) {
    // likely encoded before!
    return x;
  }
  return encodeURI(x);
};

/** 非 Latin-1 的用户名或密码按 UTF-8 字节转成二进制字符串，才能放进 Basic 认证头。 */
const tryEncodeUsernamePassword = (x: string) => {
  if (onlyLatin1(x)) {
    return x;
  }
  return String.fromCharCode(...new TextEncoder().encode(x));
};

const parseCustomHeaders = (x: string): Record<string, string> => {
  const y = x.trim();
  if (y === "") {
    return {};
  }
  const z = y.split("\n");

  const res: Record<string, string> = {};

  for (const kv of z) {
    if (!kv.includes(":")) {
      continue;
    }

    const [keyRaw, ...valueArr] = kv.split(":");
    const key = keyRaw.trim();
    const value = valueArr.join(":").trim();
    res[key] = value;
  }

  return res;
};

export class FakeFsWebdav extends FakeFs {
  kind: "webdav";

  webdavConfig: WebdavConfig;
  remoteBaseDir: string;
  client!: WebDAVClient;
  vaultFolderExists: boolean;
  saveUpdatedConfigFunc: () => Promise<void>;

  supportApachePartial: boolean;
  supportSabrePartial: boolean;
  isNextcloud: boolean;
  nextcloudUploadServerAddress: string;

  constructor(
    webdavConfig: WebdavConfig,
    vaultName: string,
    saveUpdatedConfigFunc: () => Promise<void>,
    private readonly writeJournal?: NativeWriteJournal
  ) {
    super();
    this.kind = "webdav";
    this.webdavConfig = structuredClone(webdavConfig);
    this.webdavConfig.address = tryEncodeURI(this.webdavConfig.address);
    this.remoteBaseDir = this.webdavConfig.remoteBaseDir || vaultName || "";
    this.vaultFolderExists = false;
    this.saveUpdatedConfigFunc = saveUpdatedConfigFunc;

    this.supportApachePartial = false;
    this.supportSabrePartial = false;
    this.isNextcloud = false;
    this.nextcloudUploadServerAddress = "";
  }

  async _init(allowMissingRoot = false) {
    // init client if not inited
    if (this.client !== undefined && this.vaultFolderExists) {
      return;
    }

    const cacheHeader = {
      "Cache-Control": "no-cache",
    };
    const customHeaders = parseCustomHeaders(
      this.webdavConfig.customHeaders ?? ""
    );
    const headers: Record<string, string> = { ...cacheHeader, ...customHeaders };
    for (const key of Object.keys(headers)) if (["x-nextclaw-local-transport", NATIVE_OWNER_HEADER].includes(key.toLowerCase())) delete headers[key];
    if (this.writeJournal) headers[NATIVE_OWNER_HEADER] = this.writeJournal.token;
    // Old experimental profiles must not silently change transport semantics.
    if (this.webdavConfig.transport && this.webdavConfig.transport !== "native")
      throw new Error("此稳定候选仅支持原生传输；请先核对旧实验配置及未知写入记录");

    if (
      this.webdavConfig.username !== "" &&
      this.webdavConfig.password !== ""
    ) {
      this.client = createClient(this.webdavConfig.address, {
        username: tryEncodeUsernamePassword(this.webdavConfig.username),
        password: tryEncodeUsernamePassword(this.webdavConfig.password),
        headers: headers,
        authType:
          this.webdavConfig.authType === "digest"
            ? AuthType.Digest
            : AuthType.Password,
      });
    } else {
      this.client = createClient(this.webdavConfig.address, {
        headers: headers,
      });
    }

    // check vault folder
    if (this.vaultFolderExists) {
      // pass
    } else {
      const res = await this.client.exists(`/${this.remoteBaseDir}/`);
      if (res) {
        // console.info("remote vault folder exits!");
        this.vaultFolderExists = true;
      } else {
        if (allowMissingRoot) return;
        throw Object.assign(new Error(`Remote root directory does not exist: /${this.remoteBaseDir}/`), { code: "CONTENT_ROOT_MISSING", status: 404 });
      }
    }

    // adjust depth parameter
    if (
      this.webdavConfig.depth === "auto" ||
      this.webdavConfig.depth === "auto_1" ||
      this.webdavConfig.depth === "auto_infinity" ||
      this.webdavConfig.depth === "auto_unknown"
    ) {
      this.webdavConfig.depth = "manual_1";
      this.webdavConfig.manualRecursive = true;
      if (this.saveUpdatedConfigFunc !== undefined) {
        await this.saveUpdatedConfigFunc();
      }
    }

    await this._checkPartialSupport();
  }

  /**
   * <server>/remote.php/dav/files/<userid>
   * => <server>/remote.php/dav/uploads/<userid>
   */
  _getnextcloudUploadServerAddress = () => {
    let k = this.webdavConfig.address;
    if (k.endsWith("/")) {
      // no tailing slash
      k = k.substring(0, k.length - 1);
    }
    const s = k.split("/");
    if (
      s.length > 3 &&
      s[s.length - 3] === "dav" &&
      s[s.length - 2] === "files" &&
      s[s.length - 1] !== ""
    ) {
      s[s.length - 2] = "uploads";
      return s.join("/");
    }
    throw Error(`cannot construct upload address for ${k}`);
  };

  async _checkPartialSupport() {
    const compliance = await this.client.getDAVCompliance(
      `/${this.remoteBaseDir}/`
    );

    for (const c of compliance.compliance) {
      // nextcloud AND with an account
      if (
        c.toLocaleLowerCase().includes("nextcloud") &&
        this.webdavConfig.username !== "" &&
        this.webdavConfig.password !== ""
      ) {
        // the address is parsable
        const s = this.webdavConfig.address.split("/");
        if (
          s.length > 3 &&
          s[s.length - 3] === "dav" &&
          s[s.length - 2] === "files" &&
          s[s.length - 1] !== ""
        ) {
          this.isNextcloud = true;
          this.nextcloudUploadServerAddress =
            this._getnextcloudUploadServerAddress();
          console.debug(
            `isNextcloud=${this.isNextcloud}, uploadFolder=${this.nextcloudUploadServerAddress}`
          );
          return true;
        } else {
          return false;
        }
      }
    }

    // taken from https://github.com/perry-mitchell/webdav-client/blob/master/source/operations/partialUpdateFileContents.ts
    // which is under MIT license
    if (
      compliance.server.includes("Apache") &&
      compliance.compliance.includes("<http://apache.org/dav/propset/fs/1>")
    ) {
      this.supportApachePartial = true;
      console.debug(
        `supportApachePartial=true, compliance=${JSON.stringify(compliance)}`
      );
      return true;
    }

    if (compliance.compliance.includes("sabredav-partialupdate")) {
      this.supportSabrePartial = true;
      console.debug(
        `supportSabrePartial=true, compliance=${JSON.stringify(compliance)}`
      );
      return true;
    }

    return false;
  }

  async walk(): Promise<Entity[]> {
    await this._init();

    let contents = [] as FileStat[];
    if (
      this.webdavConfig.depth === "auto" ||
      this.webdavConfig.depth === "auto_unknown" ||
      this.webdavConfig.depth === "auto_1" ||
      this.webdavConfig.depth === "auto_infinity" /* don't trust auto now */ ||
      this.webdavConfig.depth === "manual_1" ||
      this.webdavConfig.address.includes("jianguoyun.com") ||
      this.webdavConfig.address.includes("teracloud.jp")
    ) {
      // the remote doesn't support infinity propfind,
      // we need to do a bfs here
      const q = new Queue([`/${this.remoteBaseDir}`]);
      const CHUNK_SIZE = 10;
      while (q.length > 0) {
        const itemsToFetch: string[] = [];
        while (q.length > 0) {
          itemsToFetch.push(q.pop()!);
        }
        const itemsToFetchChunks = chunkArray(itemsToFetch, CHUNK_SIZE);
        // console.debug(itemsToFetchChunks);
        const subContents = [] as FileStat[];
        for (const singleChunk of itemsToFetchChunks) {
          const r = singleChunk.map(async (x) => {
            const detail = await this.client.getDirectoryContents(x, {
              deep: false,
              details: true,
              data: DAV_CONTENT_PROPFIND,
              // TODO: to support .obsidian,
              // we need to load all files including dot,
              // anyway to reduce the resources?
              // glob: "/**" /* avoid dot files by using glob */,
            });
            const k = (Array.isArray(detail) ? detail as FileStat[] : detail.data).filter((sub) => stripLeadingPath(sub.filename) !== x);
            return k;
          });
          const r3 = await Promise.all(r);
          for (const r4 of r3) {
            if (
              this.webdavConfig.address.includes("jianguoyun.com") &&
              r4.length >= 749
            ) {
              // https://help.jianguoyun.com/?p=2064
              // no more than 750 per request
              throw Error(
                `出错：坚果云 api 有限制，文件列表加载不全。终止同步！`
              );
            }
          }
          const r2 = r3.flat();
          subContents.push(...r2);
        }
        for (let i = 0; i < subContents.length; ++i) {
          const f = subContents[i];
          contents.push(f);
          if (f.type === "directory") {
            q.push(stripLeadingPath(f.filename));
          }
        }
      }
    } else {
      // the remote supports infinity propfind
      const detail = await this.client.getDirectoryContents(
        `/${this.remoteBaseDir}`,
        {
          deep: true,
          details: true,
              data: DAV_CONTENT_PROPFIND,
          // TODO: to support .obsidian,
          // we need to load all files including dot,
          // anyway to reduce the resources?
          // glob: "/**" /* avoid dot files by using glob */,
        }
      );
      contents = Array.isArray(detail) ? detail : detail.data;
    }

    const result = contents
      .map((x) => fromWebdavItemToEntity(x, this.remoteBaseDir))
      .filter((x) => x.keyRaw !== "/");
    return result;
  }

  async stat(key: string): Promise<Entity> {
    await this._init();
    const fullPath = getWebdavPath(key, this.remoteBaseDir);
    return await this._statFromRoot(fullPath);
  }

  async _statFromRoot(key: string): Promise<Entity> {
    const detail = await this.client.stat(key, { details: true,
      data: DAV_CONTENT_PROPFIND });
    const res = "data" in detail ? detail.data : detail;
    return fromWebdavItemToEntity(res, this.remoteBaseDir);
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    if (!key.endsWith("/")) {
      throw Error(`you should not call mkdir on ${key}`);
    }
    await this._init();
    const uploadFile = getWebdavPath(key, this.remoteBaseDir);
    return await this._mkdirFromRoot(uploadFile, mtime, ctime);
  }

  async _mkdirFromRoot(
    key: string,
    mtime?: number,
    ctime?: number
  ): Promise<Entity> {
    // the sync algorithm should do recursive manually already.
    // if we set recursive: true here, Digest auth will return some error inside the PROPFIND
    await this.client.createDirectory(key, {
      recursive: false,
    });
    return await this._statFromRoot(key);
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    if (key.endsWith("/")) {
      throw Error(`you should not call writeFile on ${key}`);
    }
    await this._init();
    const uploadFile = getWebdavPath(key, this.remoteBaseDir);
    return await this._writeFileFromRoot(
      uploadFile,
      content,
      mtime,
      ctime,
      key
    );
  }

  async _writeFileFromRoot(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    origKey: string
  ): Promise<Entity> {
    // less than 10 MB
    if (content.byteLength <= 10 * 1024 * 1024) {
      return await this._writeFileFromRootFull(
        key,
        content,
        mtime,
        ctime,
        origKey
      );
    }

    // larger than 10 MB
    if (
      !this.isNextcloud &&
      !this.supportApachePartial &&
      !this.supportSabrePartial
    ) {
      // give up and upload by whole, and directly return
      return await this._writeFileFromRootFull(
        key,
        content,
        mtime,
        ctime,
        origKey
      );
    }

    // try to upload by chunks
    try {
      if (this.isNextcloud) {
        return await this._writeFileFromRootNextcloud(
          key,
          content,
          mtime,
          ctime,
          origKey
        );
      } else if (this.supportApachePartial) {
        return await this._writeFileFromRootApachePartial(
          key,
          content,
          mtime,
          ctime,
          origKey
        );
      } else if (this.supportSabrePartial) {
        return await this._writeFileFromRootSabrePartial(
          key,
          content,
          mtime,
          ctime,
          origKey
        );
      }
      throw Error(`Error: partial upload / update method is not implemented??`);
    } catch (e) {
      console.error(
        `we fail to write file partially for nextcloud or apache or sabre/dav, stop!`
      );
      console.error(e);
      throw e;
      // this.isNextcloud = false;
      // this.supportApachePartial = false;
      // return await this._writeFileFromRootFull(
      //   key,
      //   content,
      //   mtime,
      //   ctime,
      //   origKey
      // );
    }
  }

  async _writeFileFromRootFull(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    origKey: string
  ): Promise<Entity> {
    // console.debug(`start _writeFileFromRootFull`);
    await this.client.putFileContents(key, content, {
      overwrite: true,
    });
    const k = await this._statFromRoot(key);
    // console.debug(`end _writeFileFromRootFull`);
    return k;
  }

  /**
   * https://docs.nextcloud.com/server/latest/developer_manual/client_apis/WebDAV/chunking.html
   * @param key
   * @param content
   * @param mtime
   * @param ctime
   * @returns
   */
  async _writeFileFromRootNextcloud(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    origKey: string
  ): Promise<Entity> {
    if (key.endsWith("/")) {
      throw Error(
        `key=${key} should not have tailing slash in _writeFileFromRootNextcloud`
      );
    }
    const destUrl = `${this.webdavConfig.address}/${encodeURI(key)}`;
    console.debug(`destUrl=${destUrl}`);

    const getTmpFolder = (x: string) => {
      if (x.endsWith("/")) {
        throw Error(`file to upload by chunk should not ends with /`);
      }
      const y = x.split("/");
      const z = encodeURI(`${y[y.length - 1]}`);
      return z;
    };

    const uploadServerAddress = this.nextcloudUploadServerAddress;
    console.debug(`uploadServerAddress=${uploadServerAddress}`);
    const tmpFolderName = getTmpFolder(key);
    console.debug(`tmpFolderName=${tmpFolderName}`);

    const clientForUpload = createClient(uploadServerAddress, {
      username: tryEncodeUsernamePassword(this.webdavConfig.username),
      password: tryEncodeUsernamePassword(this.webdavConfig.password),
      headers: {
        "Cache-Control": "no-cache",
        ...(this.writeJournal ? { [NATIVE_OWNER_HEADER]: this.writeJournal.token } : {}),
      },
      authType:
        this.webdavConfig.authType === "digest"
          ? AuthType.Digest
          : AuthType.Password,
    });

    // create folder
    await clientForUpload.createDirectory(tmpFolderName, {
      headers: {
        Destination: destUrl,
      },
    });
    console.debug(`finish creating folder`);

    // upload by chunks
    const sizePerChunk = 5 * 1024 * 1024; // 5 mb
    const chunkRanges = splitFileSizeToChunkRanges(
      content.byteLength,
      sizePerChunk
    );
    for (let i = 0; i < chunkRanges.length; ++i) {
      const { start, end } = chunkRanges[i];
      const tmpFileName = `${i + 1}`.padStart(5, "0");
      const tmpFileNameWithFolder = `${tmpFolderName}/${tmpFileName}`;
      console.debug(
        `start to upload chunk ${
          i + 1
        } to ${tmpFileNameWithFolder} with startInclusive=${start}, endInclusive=${end}`
      );
      await clientForUpload.putFileContents(
        tmpFileNameWithFolder,
        content.slice(start, end + 1),
        {
          headers: {
            Destination: destUrl,
            "OC-Total-Length": `${content.byteLength}`,
          },
        }
      );
    }
    console.debug(`finish upload all chunks`);

    // move to assemble
    const fakeFileToMoveUrl = `${tmpFolderName}/.file`;
    console.debug(`fakeFileToMoveUrl=${fakeFileToMoveUrl}`);
    await clientForUpload.customRequest(fakeFileToMoveUrl, {
      method: "MOVE",
      headers: {
        Destination: destUrl,
        "OC-Total-Length": `${content.byteLength}`,
      },
    });
    console.debug(`finish moving file`);
    // TODO: setting X-OC-Mtime

    // stat
    console.debug(`before stat origKey=${origKey}`);
    const k = await this.stat(origKey);
    console.debug(`after stat`);
    if (k.sizeRaw !== content.byteLength) {
      // we failed!
      this.isNextcloud = false; // give up next time!
      const err = `unable to upload file ${key} by chunks to nextcloud`;
      console.error(err);
      throw Error(err);
    }
    console.debug(`after stat, k=${JSON.stringify(k, null, 2)}`);

    return k;
  }

  async _writeFileFromRootApachePartial(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    origKey: string
  ): Promise<Entity> {
    // firstly upload a 0-byte data
    await this._writeFileFromRootFull(
      key,
      new ArrayBuffer(0),
      mtime,
      ctime,
      origKey
    );

    // then "update" by chunks
    const sizePerChunk = 5 * 1024 * 1024; // 5 mb
    const chunkRanges = splitFileSizeToChunkRanges(
      content.byteLength,
      sizePerChunk
    );

    // TODO: parallel
    for (let i = 0; i < chunkRanges.length; ++i) {
      const { start, end } = chunkRanges[i];
      await this.client.partialUpdateFileContents(
        key,
        start,
        end,
        content.slice(start, end + 1)
      );
    }

    // lastly return
    return await this.stat(origKey);
  }

  async _writeFileFromRootSabrePartial(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    origKey: string
  ): Promise<Entity> {
    // firstly upload a 0-byte data
    await this._writeFileFromRootFull(
      key,
      new ArrayBuffer(0),
      mtime,
      ctime,
      origKey
    );

    // then "update" by chunks
    const sizePerChunk = 5 * 1024 * 1024; // 5 mb
    const chunkRanges = splitFileSizeToChunkRanges(
      content.byteLength,
      sizePerChunk
    );

    // diff from apachePartial: we use "append" header here for dufs...
    // we cannot parallel here
    for (let i = 0; i < chunkRanges.length; ++i) {
      const { start, end } = chunkRanges[i];
      await this.client.customRequest(key, {
        method: "PATCH",
        headers: {
          "X-Update-Range": "append",
          "Content-Type": "application/x-sabredav-partialupdate",
        },
        data: content.slice(start, end + 1),
      });
    }

    // lastly return
    return await this.stat(origKey);
  }

  contentBinding() {
    const url = new URL(this.webdavConfig.address);
    if (url.username || url.password || url.search || url.hash) throw new Error("内容服务器地址不得包含认证信息或查询参数");
    return { origin: url.origin, account: this.webdavConfig.username,
      remoteRoot: `${url.pathname.replace(/\/+$/, "")}/${this.remoteBaseDir}`,
      nativeManaged: VALID_REQURL, journalToken: this.writeJournal?.token };
  }
  contentEndpoint(key: string) {
    this.contentBinding();
    return this.webdavConfig.address.replace(/\/+$/, "") + "/" +
      getWebdavPath(key, this.remoteBaseDir).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  }
  async readContent(key: string, expected: Entity) {
    await this._init();
    const response = await this.client.customRequest(getWebdavPath(key, this.remoteBaseDir), {
      method: "GET", headers: { "If-Match": etagHeader(expected) },
    });
    const etag = response.headers.get("etag");
    if (response.status !== 200 || etag !== etagHeader(expected)) throw new SyncConflict("条件读取的响应版本不匹配");
    return { bytes: await response.arrayBuffer(), etag };
  }
  async putContent(key: string, bytes: ArrayBuffer, expected: string | null) {
    await this._init();
    try {
      const response = await this.client.customRequest(getWebdavPath(key, this.remoteBaseDir), {
        method: "PUT", data: bytes,
        headers: { "Content-Type": "application/octet-stream", ...(expected ? { "If-Match": expected } : { "If-None-Match": "*" }) },
      });
      return { status: response.status, etag: response.headers.get("etag") ?? undefined };
    } catch (e) {
      const status = (e as { status?: number }).status;
      // The real request layer has already settled this explicit rejection. Never synthesize success.
      if (status !== undefined && terminalReceipt("PUT", status)) return { status };
      throw e;
    }
  }

  async writeFileGuarded(
    key: string,
    content: ArrayBuffer,
    _mtime: number,
    _ctime: number,
    expected: Entity | null
  ): Promise<Entity> {
    await this._init();
    const fullPath = getWebdavPath(key, this.remoteBaseDir);
    // One conditional PUT also for large files: never fall back to unguarded chunks.
    const response = await this.client.customRequest(fullPath, {
      method: "PUT",
      data: content,
      headers: {
        "Content-Type": "application/octet-stream",
        ...(expected
          ? { "If-Match": etagHeader(expected) }
          : { "If-None-Match": "*" }),
      },
    });
    // Accepted/ambiguous responses must never qualify as an acknowledged PUT,
    // even if a later read happens to observe the same ETag.
    if (![200, 201, 204].includes(response.status))
      throw new SyncConflict("上传未收到明确完成回执，保留本地版本");
    const writtenTag = response.headers.get("etag");
    const stored = await this._statFromRoot(fullPath);
    if (!writtenTag || etagHeader(stored) !== writtenTag)
      throw new SyncConflict("上传后远端版本无法确认，保留本地版本并重新发现");
    return stored;
  }

  async rmGuarded(key: string, expected: Entity): Promise<void> {
    if (key.endsWith("/") || key === "/")
      throw new SyncConflict("目录删除需重新核对全部子项，暂不自动执行");
    await this._init();
    await this.client.customRequest(getWebdavPath(key, this.remoteBaseDir), {
      method: "DELETE",
      headers: { "If-Match": etagHeader(expected) },
    });
  }

  async checkContentRootParent() {
    await this._init(true);
    const root = `/${this.remoteBaseDir.replace(/^\/+|\/+$/g, "")}`;
    const parent = root.slice(0, root.lastIndexOf("/")) || "/";
    // Never create missing ancestors or silently switch to another configured root.
    const detail = await this.client.stat(parent, { details: true });
    const p = "data" in detail ? detail.data : detail;
    if (p.type !== "directory") throw new Error("root-parent-is-not-directory");
  }
  async restoreContentRoot() {
    await this._init(true);
    const root = `/${this.remoteBaseDir.replace(/^\/+|\/+$/g, "")}`;
    const r = await this.client.customRequest(root, { method: "MKCOL" });
    if (r.status === 201) this.vaultFolderExists = true;
    return { status: r.status };
  }

  async deleteContent(key: string, expected: Entity) {
    if (key === "/" || key.endsWith("/")) throw new SyncConflict("目录删除暂缓");
    await this._init();
    try {
      const r = await this.client.customRequest(getWebdavPath(key, this.remoteBaseDir), {
        method: "DELETE", headers: { "If-Match": etagHeader(expected) },
      });
      return { status: r.status };
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== undefined && terminalReceipt("DELETE", status)) return { status };
      throw e;
    }
  }

  async moveContent(source: string, target: string, expected: string): Promise<{ status: number }> {
    if (!isOrdinaryMovePath(source) || !isOrdinaryMovePath(target) || source.toLowerCase() === target.toLowerCase() ||
      !isStrongMoveEtag(expected))
      throw new SyncConflict("缺少普通文件改名、源版本或原生写入所有者的证据");
    if (!VALID_REQURL || !this.writeJournal || this.writeJournal.blocked()) throw new NativeWritePaused();
    const url = this.contentEndpoint(source);
    const destination = this.contentEndpoint(target);
    await this._init();
    try {
      const r = await this.client.customRequest(getWebdavPath(source, this.remoteBaseDir), {
        url, method: "MOVE", headers: { Destination: destination, "If-Match": expected, Overwrite: "F" },
      });
      return { status: r.status };
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== undefined && terminalReceipt("MOVE", status) && status !== 204) return { status };
      throw e;
    }
  }

  async readFile(key: string, expected?: Entity): Promise<ArrayBuffer> {
    if (key.endsWith("/")) {
      throw Error(`you should not call readFile on ${key}`);
    }
    await this._init();
    const downloadFile = getWebdavPath(key, this.remoteBaseDir);
    return await this._readFileFromRoot(downloadFile, expected);
  }

  async _readFileFromRoot(
    key: string,
    expected?: Entity
  ): Promise<ArrayBuffer> {
    const buff = (await this.client.getFileContents(
      key,
      expected ? { headers: { "If-Match": etagHeader(expected) } } : undefined
    )) as BufferLike;
    if (buff instanceof ArrayBuffer) {
      return buff;
    } else if (ArrayBuffer.isView(buff)) {
      return bufferToArrayBuffer(buff);
    }
    throw Error(`unexpected file content result with type ${typeof buff}`);
  }

  async rename(key1: string, key2: string): Promise<void> {
    if (key1 === "/" || key2 === "/") {
      return;
    }
    const remoteFileName1 = getWebdavPath(key1, this.remoteBaseDir);
    const remoteFileName2 = getWebdavPath(key2, this.remoteBaseDir);
    await this._init();
    await this.client.moveFile(remoteFileName1, remoteFileName2);
  }

  async rm(key: string): Promise<void> {
    if (key === "/") {
      return;
    }
    await this._init();
    try {
      const remoteFileName = getWebdavPath(key, this.remoteBaseDir);
      await this.client.deleteFile(remoteFileName);
      // console.info(`delete ${remoteFileName} succeeded`);
    } catch (err) {
      if ((err as { status?: number })?.status !== 404) throw err;
    }
  }
}
