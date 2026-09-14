import { base64url } from "rfc4648";
import { reverseString } from "./misc";

import type { NextclawSyncSettings } from "./baseTypes";

const DEFAULT_README: string =
  "The file contains sensitive info, so DO NOT take screenshot of, copy, or share it to anyone! It's also generated automatically, so do not edit it manually.";

interface MessyConfigType {
  readme: string;
  d: string;
}

/**
 * this should accept the result after loadData();
 */
export const messyConfigToNormal = (
  x: MessyConfigType | NextclawSyncSettings | null | undefined
): NextclawSyncSettings | null | undefined => {
  if (x === null || x === undefined) {
    return x;
  }
  if ("readme" in x && "d" in x) {
    const bytes = base64url.parse(reverseString(x.d), { loose: true });
    return JSON.parse(
      new TextDecoder().decode(bytes)
    ) as NextclawSyncSettings;
  }
  return x;
};

/**
 * this should accept the result of original config
 */
export const normalConfigToMessy = (
  x: NextclawSyncSettings | null | undefined
) => {
  if (x === null || x === undefined) {
    return x;
  }
  return {
    readme: DEFAULT_README,
    d: reverseString(
      base64url.stringify(new TextEncoder().encode(JSON.stringify(x)), {
        pad: false,
      })
    ),
  };
};
