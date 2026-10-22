/* ============ 资讯雷达 · 浏览器端翻译（App 内实时补翻） ============
 * 用途：daily.json 里没有预翻译（titleZh/summaryZh）的条目，
 *       在 App 内点「译」时实时翻译，全程不跳出 App。
 * 数据优先级：本地缓存 → 各公开翻译 API（按国内可达性排序）。
 * 说明：Google gtx 在国内网络不可达，仅作为境外用户兜底；
 *       MyMemory / Lingva 镜像对国内相对友好，但仍可能失败，
 *       失败时保留原文并提示，不阻塞阅读。
 */
window.Translator = (function () {
  'use strict';

  const CACHE_KEY = 'nr.trans.v1';
  const CACHE_MAX = 500;
  const TIMEOUT = 10000;

  const PROVIDERS = [
    {
      name: 'mymemory',
      build: (text, from, to) =>
        `https://api.memory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`,
      parse: (data) => (data && data.responseData && data.responseData.translatedText) || null,
    },
    {
      name: 'lingva',
      build: (text, from, to) =>
        `https://lingva.ml/api/v1/${from}/${to}/${encodeURIComponent(text)}`,
      parse: (data) => (data && typeof data.translation === 'string' ? data.translation : null),
    },
    {
      name: 'google-gtx',
      build: (text, from, to) =>
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`,
      parse: (data) => {
        const segs = data && data[0];
        if (!Array.isArray(segs)) return null;
        return segs.map((s) => (Array.isArray(s) ? s[0] : '')).filter(Boolean).join('') || null;
      },
    },
  ];

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
    catch { return {}; }
  }
  function writeCache(c) {
    try {
      // 超出上限时丢弃最早的一半
      const keys = Object.keys(c);
      if (keys.length > CACHE_MAX) {
        for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete c[k];
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(c));
    } catch { /* 存储满时忽略 */ }
  }
  function key(text) {
    // 简易 hash，避免把长文本存进 key
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + text.length;
  }

  async function fetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 翻译单段文本（英文 → 中文）
   * @returns {Promise<string|null>} 译文；全部失败返回 null
   */
  async function translate(text, from = 'en', to = 'zh-CN') {
    const t = (text || '').trim();
    if (!t) return null;
    const k = key(t);
    const cache = readCache();
    if (cache[k]) return cache[k];

    for (const p of PROVIDERS) {
      try {
        const data = await fetchJson(p.build(t, from, to));
        const r = p.parse(data);
        if (r) {
          cache[k] = r;
          writeCache(cache);
          return r;
        }
      } catch { /* 尝试下一个 */ }
    }
    return null;
  }

  /**
   * 批量翻译段落（保留顺序，并发 2，带进度回调）
   * @param {string[]} paragraphs
   * @param {(done:number, total:number)=>void} onProgress
   * @returns {Promise<Array<string|null>>}
   */
  async function translateParagraphs(paragraphs, onProgress) {
    const out = new Array(paragraphs.length).fill(null);
    let done = 0;
    let idx = 0;
    const workers = Array.from({ length: Math.min(2, paragraphs.length) }, async () => {
      while (idx < paragraphs.length) {
        const i = idx++;
        out[i] = await translate(paragraphs[i]);
        done++;
        if (onProgress) onProgress(done, paragraphs.length);
      }
    });
    await Promise.all(workers);
    return out;
  }

  /** 是否像英文（与脚本端 isEnglish 同规则） */
  function isEnglish(s) {
    if (!s) return false;
    const latin = (s.match(/[a-zA-Z]/g) || []).length;
    const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    return latin >= 8 && cjk === 0;
  }

  return { translate, translateParagraphs, isEnglish };
})();
