// postinstall：把 Workers 兼容 patch 应用到 @aws-sdk/xml-builder。
// 背景见 worker/vendor/xml-parser-browser-patch.js 头部注释。
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'node_modules', '@aws-sdk', 'xml-builder', 'dist-es', 'xml-parser.browser.js');
const patch = join(root, 'worker', 'vendor', 'xml-parser-browser-patch.js');

try {
  copyFileSync(patch, target);
  console.log('[patch-sdk] xml-parser.browser.js 已替换为 Workers 兼容版（纯 JS XML 解析器）');
} catch (error) {
  console.warn('[patch-sdk] 应用 patch 失败（可忽略，不影响其它功能）:', error.message);
}
