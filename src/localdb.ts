import localforage from "localforage";
import { extendPrototype as ep1 } from "localforage-getitems";
import { extendPrototype as ep2 } from "localforage-removeitems";
ep1(localforage);
ep2(localforage);
export type LocalForage = typeof localforage;
import { nanoid } from "nanoid";

import type {
  Entity,
  SUPPORTED_SERVICES_TYPE,
  SyncPlanType,
} from "./baseTypes";
import { unixTimeToStr } from "./misc";

/** v1 stores independent measured observations, never requested upload timestamps. */
export interface NextclawSyncRecord extends Entity {
  key: string;
  v: 1;
  isFolder: boolean;
  local: { mtime: number; size: number };
  remote: { mtime: number; size: number };
  remoteList?: string[];
}

export const DEFAULT_DB_VERSION_NUMBER: number = 20240220;
/**
 * NextClaw：数据库名必须与上游区分开。
 *
 * Obsidian 里所有插件共用同一个 app 源，所以 IndexedDB 是**跨插件共享**的。
 * 沿用上游的 "remotelysavedb"，本插件与 remotely-save 同装一个库时会读写
 * **同一个数据库**；而记录键是 `${vaultRandomID}\t${profileID}\t${路径}`，
 * 同一个库里两者的 vaultRandomID 相同、profileID 都是 "webdav-default-1"，
 * **prevSync 记录完全重叠**。后果：
 * ① 本插件把 remotely-save 的同步历史当作自己的来做决策；
 * ② A→B 切换的 clearAllPrevSyncRecordByVault 会把 remotely-save 的记录一并清掉。
 *
 * 迁移时"先装本插件与旧插件并存，确认后再卸载旧插件"是正常路径，并存是常态。
 *
 * 全部 localforage 表都走这一个常量（本文件 createInstance 处），改这一处即全部隔开。
 */
export const DEFAULT_DB_NAME = "nextclawsyncdb";
export const DEFAULT_TBL_VERSION = "schemaversion";
export const DEFAULT_SYNC_PLANS_HISTORY = "syncplanshistory";
export const DEFAULT_TBL_VAULT_RANDOM_ID_MAPPING = "vaultrandomidmapping";
export const DEFAULT_TBL_LOGGER_OUTPUT = "loggeroutput";
export const DEFAULT_TBL_SIMPLE_KV_FOR_MISC = "simplekvformisc";
export const DEFAULT_TBL_PREV_SYNC_RECORDS = "prevsyncrecords";
export const DEFAULT_TBL_FILE_CONTENT_HISTORY = "filecontenthistory";

interface SyncPlanRecord {
  ts: number;
  remoteType: string;
  syncPlan: string;
  vaultRandomID: string;
}

export interface InternalDBs {
  versionTbl: LocalForage;
  syncPlansTbl: LocalForage;
  vaultRandomIDMappingTbl: LocalForage;
  loggerOutputTbl: LocalForage;
  simpleKVForMiscTbl: LocalForage;
  prevSyncRecordsTbl: LocalForage;
  fileContentHistoryTbl: LocalForage;
}

/**
 * 本插件的数据库从一开始就是当前版本，不存在需要迁移的旧数据
 *（与 Remotely Save 的数据库名不同，见 DEFAULT_DB_NAME）。
 */
const assertSupportedDBVersion = (oldVer: number) => {
  if (oldVer !== DEFAULT_DB_VERSION_NUMBER) {
    throw Error(
      `not supported internal db version ${oldVer}, expected ${DEFAULT_DB_VERSION_NUMBER}`
    );
  }
};

export const prepareDBs = async (
  vaultBasePath: string,
  vaultRandomIDFromOldConfigFile: string,
  profileID: string
) => {
  const db: InternalDBs = {
    versionTbl: localforage.createInstance({
      name: DEFAULT_DB_NAME,
      storeName: DEFAULT_TBL_VERSION,
    }),
    syncPlansTbl: localforage.createInstance({
      name: DEFAULT_DB_NAME,
      storeName: DEFAULT_SYNC_PLANS_HISTORY,
    }),
    vaultRandomIDMappingTbl: localforage.createInstance({
      name: DEFAULT_DB_NAME,
      storeName: DEFAULT_TBL_VAULT_RANDOM_ID_MAPPING,
    }),
    loggerOutputTbl: localforage.createInstance({
      name: DEFAULT_DB_NAME,
      storeName: DEFAULT_TBL_LOGGER_OUTPUT,
    }),
    simpleKVForMiscTbl: localforage.createInstance({
      name: DEFAULT_DB_NAME,
      storeName: DEFAULT_TBL_SIMPLE_KV_FOR_MISC,
    }),
    prevSyncRecordsTbl: localforage.createInstance({
      name: DEFAULT_DB_NAME,
      storeName: DEFAULT_TBL_PREV_SYNC_RECORDS,
    }),

    fileContentHistoryTbl: localforage.createInstance({
      name: DEFAULT_DB_NAME,
      storeName: DEFAULT_TBL_FILE_CONTENT_HISTORY,
    }),
  };

  // try to get vaultRandomID firstly
  let vaultRandomID = "";
  const vaultRandomIDInDB: string | null =
    await db.vaultRandomIDMappingTbl.getItem(`path2id\t${vaultBasePath}`);
  if (vaultRandomIDInDB === null) {
    if (vaultRandomIDFromOldConfigFile !== "") {
      // reuse the old config id
      vaultRandomID = vaultRandomIDFromOldConfigFile;
    } else {
      // no old config id, we create a random one
      vaultRandomID = nanoid();
    }
    // save the id back
    await db.vaultRandomIDMappingTbl.setItem(
      `path2id\t${vaultBasePath}`,
      vaultRandomID
    );
    await db.vaultRandomIDMappingTbl.setItem(
      `id2path\t${vaultRandomID}`,
      vaultBasePath
    );
  } else {
    vaultRandomID = vaultRandomIDInDB;
  }

  if (vaultRandomID === "") {
    throw Error("no vaultRandomID found or generated");
  }

  // as of 20240220, we set the version per vault, instead of global "version"
  const originalVersion: number | null =
    (await db.versionTbl.getItem(`${vaultRandomID}\tversion`)) ??
    (await db.versionTbl.getItem("version"));
  if (originalVersion === null) {
    console.debug(
      `no internal db version, setting it to ${DEFAULT_DB_VERSION_NUMBER}`
    );
    // as of 20240220, we set the version per vault, instead of global "version"
    await db.versionTbl.setItem(
      `${vaultRandomID}\tversion`,
      DEFAULT_DB_VERSION_NUMBER
    );
  } else {
    assertSupportedDBVersion(originalVersion);
  }

  return {
    db: db,
    vaultRandomID: vaultRandomID,
  };
};

export const insertSyncPlanRecordByVault = async (
  db: InternalDBs,
  syncPlan: SyncPlanType,
  vaultRandomID: string,
  remoteType: SUPPORTED_SERVICES_TYPE
) => {
  const now = Date.now();
  const record = {
    ts: now,
    tsFmt: unixTimeToStr(now),
    vaultRandomID: vaultRandomID,
    remoteType: remoteType,
    syncPlan: JSON.stringify(syncPlan /* directly stringify */, null, 2),
  } as SyncPlanRecord;
  await db.syncPlansTbl.setItem(`${vaultRandomID}\t${now}`, record);
};

export const readAllSyncPlanRecordTextsByVault = async (
  db: InternalDBs,
  vaultRandomID: string
) => {
  const records = [] as SyncPlanRecord[];
  await db.syncPlansTbl.iterate((value, key, iterationNumber) => {
    if (key.startsWith(`${vaultRandomID}\t`)) {
      records.push(value as SyncPlanRecord);
    }
  });
  records.sort((a, b) => -(a.ts - b.ts)); // descending

  if (records === undefined) {
    return [] as string[];
  } else {
    return records.map((x) => x.syncPlan);
  }
};

/**
 * We remove records that are older than 1 days or 20 records.
 * It's a heavy operation, so we shall not place it in the start up.
 * @param db
 */
export const clearExpiredSyncPlanRecords = async (db: InternalDBs) => {
  const MILLISECONDS_OLD = 1000 * 60 * 60 * 24 * 1; // 1 days
  const COUNT_TO_MANY = 20;

  const currTs = Date.now();
  const expiredTs = currTs - MILLISECONDS_OLD;

  let records = (await db.syncPlansTbl.keys()).map((key) => {
    const ts = Number.parseInt(key.split("\t")[1]);
    const expired = ts <= expiredTs;
    return {
      ts: ts,
      key: key,
      expired: expired,
    };
  });

  const keysToRemove = new Set(
    records.filter((x) => x.expired).map((x) => x.key)
  );

  if (records.length - keysToRemove.size > COUNT_TO_MANY) {
    // we need to find out records beyond 100 records
    records = records.filter((x) => !x.expired); // shrink the array
    records.sort((a, b) => -(a.ts - b.ts)); // descending
    records.slice(COUNT_TO_MANY).forEach((element) => {
      keysToRemove.add(element.key);
    });
  }

  // const ps = [] as Promise<void>[];
  // keysToRemove.forEach((element) => {
  //   ps.push(db.syncPlansTbl.removeItem(element));
  // });
  // await Promise.all(ps);
  await db.syncPlansTbl.removeItems(Array.from(keysToRemove));
};

export const getAllPrevSyncRecordsByVaultAndProfile = async (
  db: InternalDBs,
  vaultRandomID: string,
  profileID: string
) => {
  const res: Entity[] = [];
  const kv: Record<string, Entity | null> =
    await db.prevSyncRecordsTbl.getItems();
  for (const key of Object.getOwnPropertyNames(kv)) {
    if (key.startsWith(`${vaultRandomID}\t${profileID}\t`)) {
      const val = kv[key];
      if (val !== null) {
        res.push(val);
      }
    }
  }
  return res;
};

export const upsertPrevSyncRecordByVaultAndProfile = async (
  db: InternalDBs,
  vaultRandomID: string,
  profileID: string,
  prevSync: Entity
) => {
  await db.prevSyncRecordsTbl.setItem(
    `${vaultRandomID}\t${profileID}\t${prevSync.key}`,
    prevSync
  );
};

export const clearPrevSyncRecordByVaultAndProfile = async (
  db: InternalDBs,
  vaultRandomID: string,
  profileID: string,
  key: string
) => {
  await db.prevSyncRecordsTbl.removeItem(
    `${vaultRandomID}\t${profileID}\t${key}`
  );
};

export const clearAllPrevSyncRecordByVault = async (
  db: InternalDBs,
  vaultRandomID: string
) => {
  const keys = (await db.prevSyncRecordsTbl.keys()).filter((x) =>
    x.startsWith(`${vaultRandomID}\t`)
  );
  await db.prevSyncRecordsTbl.removeItems(keys);
};

export const clearAllLoggerOutputRecords = async (db: InternalDBs) => {
  await db.loggerOutputTbl.clear();
  console.debug(`successfully clearAllLoggerOutputRecords`);
};

export const upsertLastSuccessSyncTimeByVault = async (
  db: InternalDBs,
  vaultRandomID: string,
  millis: number
) => {
  await db.simpleKVForMiscTbl.setItem(
    `${vaultRandomID}-lastSuccessSyncMillis`,
    millis
  );
};

export const getLastSuccessSyncTimeByVault = async (
  db: InternalDBs,
  vaultRandomID: string
) => {
  return await db.simpleKVForMiscTbl.getItem<number>(
    `${vaultRandomID}-lastSuccessSyncMillis`
  );
};

export const upsertLastFailedSyncTimeByVault = async (
  db: InternalDBs,
  vaultRandomID: string,
  millis: number
) => {
  await db.simpleKVForMiscTbl.setItem(
    `${vaultRandomID}-lastFailedSyncMillis`,
    millis
  );
};

export const getLastFailedSyncTimeByVault = async (
  db: InternalDBs,
  vaultRandomID: string
) => {
  return await db.simpleKVForMiscTbl.getItem<number>(
    `${vaultRandomID}-lastFailedSyncMillis`
  );
};

export const upsertPluginVersionByVault = async (
  db: InternalDBs,
  vaultRandomID: string,
  newVersion: string
) => {
  let oldVersion: string | null = await db.simpleKVForMiscTbl.getItem(
    `${vaultRandomID}-pluginversion`
  );
  if (oldVersion === null) {
    oldVersion = "0.0.0";
  }
  await db.simpleKVForMiscTbl.setItem(
    `${vaultRandomID}-pluginversion`,
    newVersion
  );

  return {
    oldVersion: oldVersion,
    newVersion: newVersion,
  };
};
