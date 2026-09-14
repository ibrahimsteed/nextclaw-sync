// 浏览器版 webdav 包不带类型声明，沿用 Node 版的类型（两者导出相同）。
declare module "webdav/dist/web/index.js" {
  export * from "webdav";
}
