/**
 * 腾讯云 SCF 入口适配（打包时复制到部署包根目录，命名为 index.js）
 * ---------------------------------------------------------------
 * 为什么需要这一层：
 *   腾讯云 SCF 的「执行方法」格式固定为「文件名.函数名」（如 index.handler），
 *   不能带路径分隔符，且入口文件必须在部署包根目录；
 *   而真正的实现是 ESM 模块 scripts/serverless/handler.mjs，SCF 无法直接以它作入口。
 *   于是这里做桥接：CommonJS 入口（SCF 可直接加载）+ 动态 import 加载 ESM 实现。
 *
 * 部署包结构（zip 根）：
 *   index.js                        ← 本文件
 *   scripts/fetch-data.mjs
 *   scripts/serverless/handler.mjs
 *   scripts/lib/*.mjs
 *
 * 执行方法：index.handler
 */

let modPromise = null;

/** 只加载一次：容器复用期间的多次调用不必重复解析模块 */
function loadModule() {
  if (!modPromise) modPromise = import('./scripts/serverless/handler.mjs');
  return modPromise;
}

async function handler(event, context) {
  const mod = await loadModule();
  return mod.handler(event, context);
}

// handler 对应 index.handler；main_handler 是控制台示例里常见的名字，一并导出便于兜底
module.exports = { handler, main_handler: handler };
