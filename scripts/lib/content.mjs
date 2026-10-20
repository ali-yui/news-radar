/**
 * 原文正文抓取（零依赖）
 * ---------------------------------------------------------------
 * Actions 每晚对资讯条目抓取原文页面并抽取正文，写入 daily.json 的 item.content，
 * 使 App 内可直接阅读全文、不跳外部浏览器。
 *
 * 保护措施：
 *   - 总量上限 + 并发限制 + 单请求超时，保证 Actions 15 分钟内完成
 *   - 单条失败只记录错误，不影响其他条目
 *   - 体积上限（超过则放弃，避免超大页面）
 */

import { extractContent } from './extract.mjs';
import { httpGet } from './http.mjs';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BYTES = 1_500_000;

async function fetchPage(url, timeout = 9000) {
  const r = await httpGet(url, {
    timeout,
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    maxBytes: MAX_BYTES,
  });
  if (!r.ok) throw new Error(r.error?.message || 'HTTP ' + r.status);
  return r.body;
}

/**
 * 抓取并抽取单条正文
 * @returns {Promise<{text:string, paragraphs:string[]}|null>}
 */
export async function fetchArticleBody(url, opts = {}) {
  try {
    const html = await fetchPage(url, opts.timeout ?? 9000);
    const r = extractContent(html, { maxChars: opts.maxChars ?? 6000 });
    if (!r.text || r.text.length < 80) return null;
    return { text: r.text, paragraphs: r.paragraphs };
  } catch {
    return null;
  }
}

/**
 * 批量补全正文（原地写 item.content / item.contentSource）
 * @param {Array} items 资讯条目
 * @param {{limit?: number, concurrency?: number, maxChars?: number}} opts
 * @param {(source:string, message:string)=>void} onError 错误记录回调
 */
export async function enrichContent(items, opts = {}, onError = () => {}) {
  const limit = opts.limit ?? 80;
  const concurrency = opts.concurrency ?? 4;
  const targets = items.filter((it) => it.url && !it.content).slice(0, limit);
  let ok = 0;

  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (idx < targets.length) {
      const it = targets[idx++];
      const r = await fetchArticleBody(it.url, opts);
      if (r) {
        it.content = r.text;
        it.contentSource = 'server';
        ok++;
      } else {
        onError(it.source, '正文抓取失败（App 内将显示摘要）');
      }
    }
  }));

  return { total: targets.length, ok };
}
