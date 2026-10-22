/* 浏览器端去重模块（与 scripts/fetch-data.mjs 同一套规则，保持实时刷新合并结果一致） */
window.Dedup = (function () {
  const TRACKING = /^(utm_|spm|sa|rsv_dl|from$|from_|fbclid|gclid|share|share_source|shareid|_ts|ts|isappinstalled)/i;

  function normalizeUrl(u) {
    try {
      const x = new URL(u);
      x.hostname = x.hostname.replace(/^www\./, '');
      x.hash = '';
      const keep = [];
      for (const [k, v] of x.searchParams) {
        if (!TRACKING.test(k)) keep.push(k + '=' + v);
      }
      x.search = keep.join('&');
      return x.protocol + '//' + x.hostname + x.pathname.replace(/\/+$/, '') + (x.search ? '?' + x.search : '');
    } catch { return u || ''; }
  }

  function normalizeTitle(t) {
    return (t || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  }

  function grams(t) {
    const norm = (t || '').toLowerCase();
    const cjk = norm.match(/[\u4e00-\u9fff]/g) || [];
    const words = norm.match(/[a-z0-9]+/g) || [];
    const set = new Set();
    const cs = cjk.join('');
    for (let i = 0; i < cs.length - 1; i++) set.add(cs.slice(i, i + 2));
    for (let i = 0; i < words.length - 1; i++) set.add(words[i] + ' ' + words[i + 1]);
    for (const w of words) set.add('w:' + w);
    return set;
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }

  function dedup(items) {
    const kept = [];
    const byUrl = new Map();
    const byTitle = new Map();
    const gl = [];
    for (const it of items) {
      const nu = normalizeUrl(it.url || '');
      const nt = normalizeTitle(it.title);
      let dup = null;
      if (nu && byUrl.has(nu)) dup = byUrl.get(nu);
      if (!dup && nt.length >= 6 && byTitle.has(nt)) dup = byTitle.get(nt);
      if (!dup && nt.length >= 8) {
        const g = grams(it.title);
        for (let i = 0; i < gl.length; i++) {
          if (jaccard(g, gl[i].g) >= 0.82) { dup = gl[i].item; break; }
        }
      }
      if (dup !== null) {
        const d = kept[dup];
        if (it.summary && it.summary.length > (d.summary || '').length) d.summary = it.summary;
        d.tags = Array.from(new Set([...(d.tags || []), ...(it.tags || [])])).slice(0, 6);
        d.extraCategories = Array.from(new Set([...(d.extraCategories || []), ...(it.extraCategories || [])]));
        if (it.publishedAtMs && (!d.publishedAtMs || it.publishedAtMs > d.publishedAtMs)) {
          d.publishedAtMs = it.publishedAtMs;
          d.publishedAt = new Date(it.publishedAtMs).toISOString();
        }
        continue;
      }
      const idx = kept.length;
      kept.push(it);
      if (nu) byUrl.set(nu, idx);
      if (nt.length >= 6) byTitle.set(nt, idx);
      if (nt.length >= 8) gl.push({ g: grams(it.title), item: idx });
    }
    return kept;
  }

  return { dedup, normalizeUrl, normalizeTitle };
})();
