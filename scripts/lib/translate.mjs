/**
 * 英文 → 中文翻译（零依赖，多 Provider 回退）
 * ---------------------------------------------------------------
 * 由 GitHub Actions 在服务端调用（服务器出口 IP 通常可达）：
 *   1. Google translate_a/single（gtx 公开端点，无需密钥）
 *   2. MyMemory（免费公开 API，无需密钥）
 * 任一失败自动降级；全部失败保留原文，不影响主流程。
 *
 * 设计：调用方只关心 translate(text) -> 译文 or null。
 * 内含：运行内缓存（同文本不重复翻译）、串行限速、总量上限。
 */

import { createHash } from 'node:crypto';
import { httpGet } from './http.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROVIDERS = [
  {
    name: 'google',
    build: (text, from, to) =>
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`,
    parse: (body) => {
      const data = JSON.parse(body);
      // [[["译文","原文",...],...],...]
      const segs = data?.[0];
      if (!Array.isArray(segs)) return null;
      return segs.map((s) => (Array.isArray(s) ? s[0] : '')).filter(Boolean).join('') || null;
    },
  },
  {
    name: 'mymemory',
    build: (text, from, to) =>
      `https://api.memory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`,
    parse: (body) => {
      const data = JSON.parse(body);
      const t = data?.responseData?.translatedText;
      return t && typeof t === 'string' ? t : null;
    },
  },
];

/** 主体为 CJK 则判定已是中文，无需翻译 */
export function isChinese(s) {
  if (!s) return true;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (s.match(/[a-zA-Z]/g) || []).length;
  return cjk > 0 && cjk >= latin * 0.3;
}

/** 主体为英文才值得翻译（拉丁字母占主体且无 CJK） */
export function isEnglish(s) {
  if (!s) return false;
  const latin = (s.match(/[a-zA-Z]/g) || []).length;
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return latin >= 8 && cjk === 0;
}

async function fetchText(url, timeout = 12000) {
  const r = await httpGet(url, {
    timeout,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; news-radar-translator/2.0)' },
  });
  if (!r.ok) throw new Error(r.error?.message || 'HTTP ' + r.status);
  return r.body;
}

/**
 * 翻译器：带缓存、限速、总量上限、熔断与总时限
 * @param {{maxPerRun?: number, intervalMs?: number, timeout?: number, deadlineMs?: number, breaker?: number}} opts
 *   deadlineMs 整个翻译阶段的总时限（超时后剩余条目放弃，保留原文）
 *   breaker    单个 provider 连续失败这么多次后熔断（网络不通时快速失败）
 */
export function createTranslator(opts = {}) {
  const maxPerRun = opts.maxPerRun ?? 200;
  const intervalMs = opts.intervalMs ?? 150;
  const timeout = opts.timeout ?? 9000;
  const deadlineMs = opts.deadlineMs ?? 240000;
  const breakerLimit = opts.breaker ?? 3;
  const cache = new Map(); // hash -> 译文 | null
  const stats = { ok: 0, fail: 0, skipped: 0 };
  const startedAt = Date.now();
  const failStreak = new Map(PROVIDERS.map((p) => [p.name, 0]));
  const broken = new Set();
  let queue = []; // 串行执行，避免触发限流

  function key(text) {
    return createHash('sha1').update(text).digest('hex').slice(0, 16);
  }

  async function translateOne(text, from = 'en', to = 'zh-CN') {
    if (!text || text.length < 2) return null;
    if (isChinese(text)) { stats.skipped++; return null; }
    const k = key(text);
    if (cache.has(k)) return cache.get(k);
    if (stats.ok + stats.fail >= maxPerRun || Date.now() - startedAt > deadlineMs) {
      stats.skipped++;
      return null;
    }

    let result = null;
    for (const p of PROVIDERS) {
      if (broken.has(p.name)) continue;
      try {
        const body = await fetchText(p.build(text, from, to), timeout);
        result = p.parse(body);
        if (result) {
          failStreak.set(p.name, 0);
          break;
        }
        failStreak.set(p.name, (failStreak.get(p.name) || 0) + 1);
      } catch {
        failStreak.set(p.name, (failStreak.get(p.name) || 0) + 1);
      }
      if ((failStreak.get(p.name) || 0) >= breakerLimit) broken.add(p.name);
      await sleep(intervalMs);
    }
    if (result) { stats.ok++; } else { stats.fail++; }
    cache.set(k, result);
    return result;
  }

  function enqueue(text, from, to) {
    return new Promise((resolve) => queue.push(async () => resolve(await translateOne(text, from, to))));
  }

  async function drain() {
    while (queue.length) {
      const job = queue.shift();
      await job();
      await sleep(intervalMs);
    }
  }

  return {
    /** 直接翻译（串行） */
    translate: translateOne,
    /** 批量翻译（保留顺序） */
    async translateAll(list, from = 'en', to = 'zh-CN') {
      const jobs = list.map((t) => enqueue(t, from, to));
      const results = await Promise.all(jobs);
      await drain();
      return results;
    },
    stats,
  };
}

export { PROVIDERS };
