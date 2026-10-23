/* ============ 资讯雷达 · 浏览器端翻译（App 内实时补翻） ============
 * 用途：daily.json 里没有预翻译（titleZh/summaryZh）的条目，
 *       在 App 内点「译」时实时翻译，全程不跳出 App。
 * 数据优先级：本地缓存 → 百度官方翻译(若配置) → 用户 AI 接口(若配置) → 免费公开源兜底。
 * 百度翻译经 JSONP 调用（绕过 CORS），国内免费、稳定；未配置则回退到 AI 接口或免费源。
 * 免费源（MyMemory / Lingva / Google gtx）多为境外地址，国内可能不可达，仅作最后兜底。
 */
window.Translator = (function () {
  'use strict';

  const CACHE_KEY = 'nr.trans.v1';
  const CACHE_MAX = 500;
  const TIMEOUT = 10000;
  let _settings = null; // 由 App 注入：用户已配置的 AI 接口 / 百度翻译

  /* ---------- 纯 JS MD5（百度签名用，前端无 node:crypto） ---------- */
  function md5(s) {
    function add32(a, b) { return (a + b) & 0xFFFFFFFF; }
    function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
    function cmn(q, a, b, x, s, t) {
      a = add32(add32(a, q), add32(x, t));
      return add32(rol(a, s), b);
    }
    const ff = (a, b, c, d, x, s, t) => cmn((b & c) | (~b & d), a, b, x, s, t);
    const gg = (a, b, c, d, x, s, t) => cmn((b & d) | (c & ~d), a, b, x, s, t);
    const hh = (a, b, c, d, x, s, t) => cmn(b ^ c ^ d, a, b, x, s, t);
    const ii = (a, b, c, d, x, s, t) => cmn(c ^ (b | ~d), a, b, x, s, t);
    function cycle(x, k) {
      let a = x[0], b = x[1], c = x[2], d = x[3];
      a = ff(a,b,c,d,k[0],7,-680876936); d = ff(d,a,b,c,k[1],12,-389564586); c = ff(c,d,a,b,k[2],17,606105819); b = ff(b,c,d,a,k[3],22,-1044525330);
      a = ff(a,b,c,d,k[4],7,-176418897); d = ff(d,a,b,c,k[5],12,1200080426); c = ff(c,d,a,b,k[6],17,-1473231341); b = ff(b,c,d,a,k[7],22,-45705983);
      a = ff(a,b,c,d,k[8],7,1770035416); d = ff(d,a,b,c,k[9],12,-1958414417); c = ff(c,d,a,b,k[10],17,-42063); b = ff(b,c,d,a,k[11],22,-1990404162);
      a = ff(a,b,c,d,k[12],7,1804603682); d = ff(d,a,b,c,k[13],12,-40341101); c = ff(c,d,a,b,k[14],17,-1502002290); b = ff(b,c,d,a,k[15],22,1236535329);
      a = gg(a,b,c,d,k[1],5,-165796510); d = gg(d,a,b,c,k[6],9,-1069501632); c = gg(c,d,a,b,k[11],14,643717713); b = gg(b,c,d,a,k[0],20,-373897302);
      a = gg(a,b,c,d,k[5],5,-701558691); d = gg(d,a,b,c,k[10],9,38016083); c = gg(c,d,a,b,k[15],14,-660478335); b = gg(b,c,d,a,k[4],20,-405537848);
      a = gg(a,b,c,d,k[9],5,568446438); d = gg(d,a,b,c,k[14],9,-1019803690); c = gg(c,d,a,b,k[3],14,-187363961); b = gg(b,c,d,a,k[8],20,1163531501);
      a = gg(a,b,c,d,k[13],5,-1444681467); d = gg(d,a,b,c,k[2],9,-51403784); c = gg(c,d,a,b,k[7],14,1735328473); b = gg(b,c,d,a,k[12],20,-1926607734);
      a = hh(a,b,c,d,k[5],4,-378558); d = hh(d,a,b,c,k[8],11,-2022574463); c = hh(c,d,a,b,k[11],16,1839030562); b = hh(b,c,d,a,k[14],23,-35309556);
      a = hh(a,b,c,d,k[1],4,-1530992060); d = hh(d,a,b,c,k[4],11,1272893353); c = hh(c,d,a,b,k[7],16,-155497632); b = hh(b,c,d,a,k[10],23,-1094730640);
      a = hh(a,b,c,d,k[13],4,681279174); d = hh(d,a,b,c,k[0],11,-358537222); c = hh(c,d,a,b,k[3],16,-722521979); b = hh(b,c,d,a,k[6],23,76029189);
      a = hh(a,b,c,d,k[9],4,-640364487); d = hh(d,a,b,c,k[12],11,-421815835); c = hh(c,d,a,b,k[15],16,530742520); b = hh(b,c,d,a,k[2],23,-995338651);
      a = ii(a,b,c,d,k[0],6,-198630844); d = ii(d,a,b,c,k[7],10,1126891415); c = ii(c,d,a,b,k[14],15,-1416354905); b = ii(b,c,d,a,k[5],21,-57434055);
      a = ii(a,b,c,d,k[12],6,1700485571); d = ii(d,a,b,c,k[3],10,-1894986606); c = ii(c,d,a,b,k[10],15,-1051523); b = ii(b,c,d,a,k[1],21,-2054922799);
      a = ii(a,b,c,d,k[8],6,1873313359); d = ii(d,a,b,c,k[15],10,-30611744); c = ii(c,d,a,b,k[6],15,-1560198380); b = ii(b,c,d,a,k[13],21,1309151649);
      a = ii(a,b,c,d,k[4],6,-145523070); d = ii(d,a,b,c,k[11],10,-1120210379); c = ii(c,d,a,b,k[2],15,718787259); b = ii(b,c,d,a,k[9],21,-343485551);
      x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
    }
    function blk(str) {
      const b = [];
      for (let i = 0; i < 64; i += 4) {
        b[i >> 2] = str.charCodeAt(i) + (str.charCodeAt(i + 1) << 8) + (str.charCodeAt(i + 2) << 16) + (str.charCodeAt(i + 3) << 24);
      }
      return b;
    }
    function core(str) {
      const n = str.length;
      const state = [1732584193, -271733879, -1732584194, 271733878];
      let i;
      for (i = 64; i <= n; i += 64) cycle(state, blk(str.substring(i - 64, i)));
      str = str.substring(i - 64);
      const tail = new Array(16).fill(0);
      for (let j = 0; j < str.length; j++) tail[j >> 2] |= str.charCodeAt(j) << ((j % 4) << 3);
      tail[str.length >> 2] |= 0x80 << ((str.length % 4) << 3);
      if (str.length > 55) { cycle(state, tail); tail.fill(0); }
      tail[14] = n * 8;
      cycle(state, tail);
      return state;
    }
    function rhex(n) {
      const h = '0123456789abcdef';
      let s = '';
      for (let j = 0; j < 4; j++) s += h[(n >> (j * 8 + 4)) & 0xF] + h[(n >> (j * 8)) & 0xF];
      return s;
    }
    return core(unescape(encodeURIComponent(s))).map(rhex).join('');
  }

  /* ---------- 百度翻译（JSONP 绕过 CORS，免费版 QPS=1 故内部串行） ---------- */
  let baiduChain = Promise.resolve();
  let baiduLastAt = 0;
  function baiduTranslate(text, appid, key, from, to) {
    const run = baiduChain.then(async () => {
      const wait = Math.max(0, 1200 - (Date.now() - baiduLastAt));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      baiduLastAt = Date.now();
      return baiduJsonp(text, appid, key, from, to);
    });
    baiduChain = run.then(() => {}, () => {}); // 防止单条失败阻断队列
    return run;
  }
  function baiduJsonp(text, appid, key, from, to) {
    return new Promise((resolve, reject) => {
      const q = text.length > 5000 ? text.slice(0, 5000) : text;
      const salt = Date.now() + '' + Math.floor(Math.random() * 1000);
      const sign = md5(appid + q + salt + key);
      const cb = 'bd_cb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      const toBaidu = (to || 'zh-CN').startsWith('zh') ? 'zh' : to;
      const url = 'https://fanyi-api.baidu.com/api/trans/vip/translate'
        + '?callback=' + cb
        + '&q=' + encodeURIComponent(q)
        + '&from=' + (from || 'auto')
        + '&to=' + toBaidu
        + '&appid=' + encodeURIComponent(appid)
        + '&salt=' + salt
        + '&sign=' + sign;
      const script = document.createElement('script');
      let done = false;
      const cleanup = () => {
        try { delete window[cb]; } catch {}
        if (script.parentNode) script.parentNode.removeChild(script);
      };
      window[cb] = (data) => {
        if (done) return; done = true; cleanup();
        if (data && Array.isArray(data.trans_result) && data.trans_result.length) {
          resolve(data.trans_result.map((x) => x.dst).join('\n'));
        } else if (data && data.error_code) {
          reject(new Error('百度翻译错误 ' + data.error_code + (data.error_msg ? '：' + data.error_msg : '')));
        } else {
          reject(new Error('百度翻译返回异常'));
        }
      };
      script.onerror = () => {
        if (done) return; done = true; cleanup();
        reject(new Error('百度翻译网络错误（JSONP 加载失败）'));
      };
      script.src = url;
      (document.head || document.body || document.documentElement).appendChild(script);
      setTimeout(() => {
        if (done) return; done = true; cleanup();
        reject(new Error('百度翻译超时'));
      }, TIMEOUT + 5000);
    });
  }

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

    // 1) 百度官方翻译（国内免费、JSONP 绕过 CORS），优先级最高
    if (_settings && _settings.baiduAppId && _settings.baiduKey) {
      try {
        const r = await baiduTranslate(t, _settings.baiduAppId, _settings.baiduKey, from, to);
        if (r) { cache[k] = r; writeCache(cache); return r; }
      } catch { /* 回退到 AI 接口 / 免费源 */ }
    }
    // 2) 用户已配置的 AI 接口（火山方舟 / 豆包，消耗 token）
    if (_settings && window.DoubaoAI && window.DoubaoAI.enabled(_settings)) {
      try {
        const r = await window.DoubaoAI.translate(t, _settings);
        if (r) { cache[k] = r; writeCache(cache); return r; }
      } catch { /* 回退到免费源 */ }
    }

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

  function setSettings(s) { _settings = s || null; }

  return { translate, translateParagraphs, isEnglish, setSettings };
})();
