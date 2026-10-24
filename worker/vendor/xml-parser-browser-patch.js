// 此文件用于 patch node_modules/@aws-sdk/xml-builder/dist-es/xml-parser.browser.js。
// 原版依赖 DOMParser（Workers 运行时不存在），导致 ListObjectsV2 等 XML 反序列化报
// "DOMParser is not defined / Deserialization error"。
// 改为 re-export SDK 自带的自包含纯 JS 解析器（./xml-parser-node.js，拷贝自
// @aws-sdk/xml-builder 的 dist-es/xml-parser.js，放在包外以避开 browser 字段重映射循环）。
// 由 scripts/patch-sdk.mjs 在 postinstall 时自动复制到 node_modules。
// 相对路径以 patch 目标位置（node_modules/@aws-sdk/xml-builder/dist-es/）为基准。
export { parseXML } from "../../../../worker/vendor/xml-parser-node.js";
