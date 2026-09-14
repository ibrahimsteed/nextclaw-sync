import { strict as assert } from "assert";

import * as misc from "../src/misc";

describe("Misc: get folder levels", () => {
  it("should ignore empty path", () => {
    const item = "";
    assert.equal(misc.getFolderLevels(item).length, 0);
  });

  it("should ignore single file", () => {
    const item = "xxx";
    assert.equal(misc.getFolderLevels(item).length, 0);
  });

  it("should detect path ending with /", () => {
    const item = "xxx/";
    const res = ["xxx"];
    assert.deepEqual(misc.getFolderLevels(item), res);
  });

  it("should correctly split folders and files", () => {
    const item = "xxx/yyy/zzz.md";
    const res = ["xxx", "xxx/yyy"];
    assert.deepEqual(misc.getFolderLevels(item), res);

    const item2 = "xxx/yyy/zzz";
    const res2 = ["xxx", "xxx/yyy"];
    assert.deepEqual(misc.getFolderLevels(item2), res2);

    const item3 = "xxx/yyy/zzz/";
    const res3 = ["xxx", "xxx/yyy", "xxx/yyy/zzz"];
    assert.deepEqual(misc.getFolderLevels(item3), res3);
  });

  it("should correctly add ending slash if required", () => {
    const item = "xxx/yyy/zzz.md";
    const res = ["xxx/", "xxx/yyy/"];
    assert.deepEqual(misc.getFolderLevels(item, true), res);

    const item2 = "xxx/yyy/zzz";
    const res2 = ["xxx/", "xxx/yyy/"];
    assert.deepEqual(misc.getFolderLevels(item2, true), res2);

    const item3 = "xxx/yyy/zzz/";
    const res3 = ["xxx/", "xxx/yyy/", "xxx/yyy/zzz/"];
    assert.deepEqual(misc.getFolderLevels(item3, true), res3);
  });

  it("should treat path starting with / correctly", () => {
    const item = "/xxx/yyy/zzz.md";
    const res = ["/xxx", "/xxx/yyy"];
    assert.deepEqual(misc.getFolderLevels(item), res);

    const item2 = "/xxx/yyy/zzz";
    const res2 = ["/xxx", "/xxx/yyy"];
    assert.deepEqual(misc.getFolderLevels(item2), res2);

    const item3 = "/xxx/yyy/zzz/";
    const res3 = ["/xxx", "/xxx/yyy", "/xxx/yyy/zzz"];
    assert.deepEqual(misc.getFolderLevels(item3), res3);

    const item4 = "/xxx";
    const res4 = [] as string[];
    assert.deepEqual(misc.getFolderLevels(item4), res4);

    const item5 = "/";
    const res5 = [] as string[];
    assert.deepEqual(misc.getFolderLevels(item5), res5);
  });
});

describe("Misc: special char for dir", () => {
  it("should return false for normal string", () => {
    assert.ok(!misc.checkHasSpecialCharForDir(""));
    assert.ok(!misc.checkHasSpecialCharForDir("xxx"));
    assert.ok(!misc.checkHasSpecialCharForDir("yyy_xxx"));
    assert.ok(!misc.checkHasSpecialCharForDir("yyy.xxx"));
    assert.ok(!misc.checkHasSpecialCharForDir("yyy？xxx"));
  });

  it("should return true for special cases", () => {
    assert.ok(misc.checkHasSpecialCharForDir("?"));
    assert.ok(misc.checkHasSpecialCharForDir("/"));
    assert.ok(misc.checkHasSpecialCharForDir("\\"));
    assert.ok(misc.checkHasSpecialCharForDir("xxx/yyy"));
    assert.ok(misc.checkHasSpecialCharForDir("xxx\\yyy"));
    assert.ok(misc.checkHasSpecialCharForDir("xxx?yyy"));
  });
});

describe("Misc: split chunk ranges", () => {
  it("should fail on negative numner", () => {
    assert.throws(() => misc.splitFileSizeToChunkRanges(-1, 2));
    assert.throws(() => misc.splitFileSizeToChunkRanges(1, -1));
    assert.throws(() => misc.splitFileSizeToChunkRanges(1, 0));
  });

  it("should return nothing for 0 input", () => {
    let input: [number, number] = [0, 1];
    let output: any = [];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [0, 100];
    output = [];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));
  });

  it("should return single item for 1 input", () => {
    let input: [number, number] = [1, 1];
    let output = [{ start: 0, end: 0 }];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [1, 100];
    output = [{ start: 0, end: 0 }];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));
  });

  it("should return single item for larger or equal input", () => {
    let input: [number, number] = [10, 10];
    let output = [{ start: 0, end: 9 }];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [10, 21];
    output = [{ start: 0, end: 9 }];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));
  });

  it("should return correct items for normal input", () => {
    let input: [number, number] = [10, 9];
    let output = [
      { start: 0, end: 8 },
      { start: 9, end: 9 },
    ];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [10, 5];
    output = [
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [3, 1];
    output = [
      { start: 0, end: 0 },
      { start: 1, end: 1 },
      { start: 2, end: 2 },
    ];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [15, 5];
    output = [
      { start: 0, end: 4 },
      { start: 5, end: 9 },
      { start: 10, end: 14 },
    ];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));

    input = [1024, 578];
    output = [
      { start: 0, end: 577 },
      { start: 578, end: 1023 },
    ];
    assert.deepStrictEqual(output, misc.splitFileSizeToChunkRanges(...input));
  });
});

describe("Misc: chunk array", () => {
  it("按固定大小切块，最后一块可以不满", () => {
    assert.deepEqual(misc.chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });
  it("正好整除时不多出空块", () => {
    assert.deepEqual(misc.chunkArray([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
  });
  it("空数组返回空", () => {
    assert.deepEqual(misc.chunkArray([], 3), []);
  });
});
