import type { Vault, moment as obsidianMoment } from "obsidian";

declare global {
  interface Window {
    moment: typeof obsidianMoment;
  }
}

/**
 * Util func for mkdir -p based on the "path" of original file or folder
 * "a/b/c/" => ["a", "a/b", "a/b/c"]
 * "a/b/c/d/e.txt" => ["a", "a/b", "a/b/c", "a/b/c/d"]
 * @param x string
 * @returns string[] might be empty
 */
export const getFolderLevels = (x: string, addEndingSlash = false) => {
  const res: string[] = [];

  if (x === "" || x === "/") {
    return res;
  }

  const y1 = x.split("/");
  for (let index = 0; index + 1 < y1.length; index++) {
    let k = y1.slice(0, index + 1).join("/");
    if (k === "" || k === "/") {
      continue;
    }
    if (addEndingSlash) {
      k = `${k}/`;
    }
    res.push(k);
  }
  return res;
};

export const mkdirpInVault = async (thePath: string, vault: Vault) => {
  for (const folder of getFolderLevels(thePath)) {
    if (!(await vault.adapter.exists(folder))) {
      await vault.adapter.mkdir(folder);
    }
  }
};

/**
 * https://stackoverflow.com/questions/8609289
 * @param b Buffer
 * @returns ArrayBuffer
 */
export const bufferToArrayBuffer = (b: ArrayBufferView): ArrayBuffer => {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

/**
 * https://stackoverflow.com/questions/958908
 * @param x
 * @returns
 */
export const reverseString = (x: string) => {
  return [...x].reverse().join("");
};

export const checkHasSpecialCharForDir = (x: string) => {
  return /[?/\\]/.test(x);
};

export const unixTimeToStr = (x: number | undefined | null, hasMs = false) => {
  if (x === undefined || x === null || Number.isNaN(x)) {
    return undefined;
  }
  if (hasMs) {
    // 1716712162574 => '2024-05-26T16:29:22.574+08:00'
    return window.moment(x).toISOString(true);
  }
  // 1716712162574 => '2024-05-26T16:29:22+08:00'
  return window.moment(x).format();
};

/**
 * On Android the stat has bugs for folders. So we need a fixed version.
 * @param vault
 * @param path
 */
export const statFix = async (vault: Vault, path: string) => {
  const s = await vault.adapter.stat(path);
  if (s === undefined || s === null) {
    throw Error(`${path} doesn't exist cannot run stat`);
  }
  const fixed = s as {
    type: "file" | "folder";
    ctime: number | undefined;
    mtime: number | undefined;
    size: number;
  };
  if (Number.isNaN(fixed.ctime ?? Number.NaN)) {
    fixed.ctime = undefined;
  }
  if (Number.isNaN(fixed.mtime ?? Number.NaN)) {
    fixed.mtime = undefined;
  }
  if (Number.isNaN(fixed.size ?? Number.NaN) && fixed.type === "folder") {
    fixed.size = 0;
  }
  return fixed;
};

export const isSpecialFolderNameToSkip = (
  x: string,
  more: string[] | undefined
) => {
  const specialFolders = [
    ".git",
    ".github",
    ".gitlab",
    ".svn",
    "node_modules",
    ".DS_Store",
    "__MACOSX ",
    "Icon\r", // https://superuser.com/questions/298785/icon-file-on-os-x-desktop
    "desktop.ini",
    "Desktop.ini",
    "thumbs.db",
    "Thumbs.db",
  ].concat(more ?? []);
  for (const iterator of specialFolders) {
    if (
      x === iterator ||
      x === `${iterator}/` ||
      x.endsWith(`/${iterator}`) ||
      x.endsWith(`/${iterator}/`)
    ) {
      return true;
    }
  }

  // microsoft tmp files...
  const f = x.split("/").pop() ?? "";
  if (f.startsWith("~$")) {
    for (const suffix of ["doc", "docx", "ppt", "pptx", "xls", "xlsx"]) {
      if (f.endsWith(`.${suffix}`)) {
        return true;
      }
    }
  }

  return false;
};

/**
 * https://stackoverflow.com/questions/39538473/using-settimeout-on-promise-chain
 * @param ms
 * @returns
 */
export const delay = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const MOBILE_STATUS_BAR_CLASS = "nextclaw-mobile-status-bar";
const NAVBAR_HEIGHT_VAR = "--nextclaw-mobile-navbar-height";

/**
 * 移动端显示状态栏，并把它抬到底部导航栏之上。
 * https://forum.obsidian.md/t/css-to-show-status-bar-on-mobile-devices/77185
 */
export const changeMobileStatusBar = (
  op: "enable" | "disable",
  oldAppContainerObserver?: MutationObserver
) => {
  const appContainer = activeDocument.querySelector(".app-container");
  const statusbar = activeDocument.querySelector(
    ".is-mobile .app-container .status-bar"
  );

  if (
    !(appContainer instanceof HTMLElement) ||
    !(statusbar instanceof HTMLElement)
  ) {
    console.warn("give up watching appContainer for statusbar");
    return undefined;
  }

  const liftAbove = (navbar: Element) => {
    const height = window.getComputedStyle(navbar).getPropertyValue("height");
    statusbar.addClass(MOBILE_STATUS_BAR_CLASS);
    statusbar.style.setProperty(NAVBAR_HEIGHT_VAR, height);
  };

  if (op === "disable") {
    oldAppContainerObserver?.disconnect();
    statusbar.removeClass(MOBILE_STATUS_BAR_CLASS);
    statusbar.style.removeProperty(NAVBAR_HEIGHT_VAR);
    return undefined;
  }

  const observer = new MutationObserver((mutationList) => {
    for (const mutation of mutationList) {
      const added = mutation.addedNodes[0];
      if (
        mutation.type === "childList" &&
        added?.instanceOf(HTMLElement) &&
        (added.hasClass("mobile-navbar") || added.hasClass("mobile-toolbar"))
      ) {
        // 刚插入时高度还不对，稍等再取。
        window.setTimeout(() => liftAbove(added), 300);
      }
    }
  });
  observer.observe(appContainer, { childList: true });

  const navbar = activeDocument.querySelector(".mobile-navbar");
  if (navbar !== null) {
    liftAbove(navbar);
  }
  return observer;
};

/**
 * https://stackoverflow.com/questions/1248302/how-to-get-the-size-of-a-javascript-object
 * @param object
 * @returns bytes
 */
export const roughSizeOfObject = (object: unknown) => {
  const objectList: unknown[] = [];
  const stack = [object];
  let bytes = 0;

  while (stack.length) {
    const value = stack.pop();

    switch (typeof value) {
      case "boolean":
        bytes += 4;
        break;
      case "string":
        bytes += value.length * 2;
        break;
      case "number":
        bytes += 8;
        break;
      case "object":
        if (value !== null && !objectList.includes(value)) {
          objectList.push(value);
          stack.push(...Object.values(value as Record<string, unknown>));
        }
        break;
    }
  }
  return bytes;
};

/** 把数组按固定大小切块。 */
export const chunkArray = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

export const splitFileSizeToChunkRanges = (
  totalSize: number,
  chunkSize: number
) => {
  if (totalSize < 0) {
    throw Error(`totalSize should not be negative`);
  }
  if (chunkSize <= 0) {
    throw Error(`chunkSize should not be negative or zero`);
  }

  if (totalSize === 0) {
    return [];
  }
  if (totalSize <= chunkSize) {
    return [{ start: 0, end: totalSize - 1 }];
  }

  const res: { start: number; end: number }[] = [];

  const blocksCount = Math.ceil((totalSize * 1.0) / chunkSize);

  for (let i = 0; i < blocksCount; ++i) {
    res.push({
      start: i * chunkSize,
      end: Math.min((i + 1) * chunkSize - 1, totalSize - 1),
    });
  }
  return res;
};
