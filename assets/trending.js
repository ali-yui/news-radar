/* ============ 资讯雷达 · GitHub Trending 日/周/月榜 ============
 * 数据优先级（解决国内手机无法访问 github.io 的问题）：
 * 1. 本地缓存（6 小时）
 * 2. daily.json 内置榜单（Actions 每天 09:00 经 jsDelivr 下发，随数据更新）
 * 3. 实时拉取：jsDelivr 镜像（国内可达）→ GitHub Pages 直连
 */
window.Trending = (function () {
  'use strict';

  const CACHE_KEY = 'nr.trending.v1';
  const TTL = 6 * 3600 * 1000; // 缓存 6 小时
  const EMBED_TTL = 24 * 3600 * 1000; // 内置榜单视为有效的窗口
  const MIRRORS = [
    (p) => `https://cdn.jsdelivr.net/gh/mshibanami/GitHubTrendingRSS@gh-pages/${p}/all.xml`,
    (p) => `https://mshibanami.github.io/GitHubTrendingRSS/${p}/all.xml`,
  ];
  const LABELS = { daily: '日榜', weekly: '周榜', monthly: '月榜' };
  const LIMITS = { daily: 25, weekly: 25, monthly: 25 };

  let currentPeriod = 'monthly';
  let loading = false;
  let embedded = null; // 来自 daily.json 的榜单

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // app.js 拉到新数据时调用
  function setEmbedded(t) {
    if (t && (t.daily || t.weekly || t.monthly)) embedded = t;
  }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
    catch { return {}; }
  }
  function writeCache(c) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* 忽略 */ }
  }

  // 内置榜单条目 {rank,owner,repo,desc,url} 转成渲染用 {title,link,about}
  function embeddedItems(period) {
    const list = (embedded && embedded[period]) || [];
    return list.slice(0, LIMITS[period]).map((t) => ({
      title: `${t.owner}/${t.repo}`,
      link: t.url,
      about: t.desc || '',
    }));
  }

  function embeddedFresh() {
    if (!embedded || !embedded.fetchedAt) return false;
    const t = new Date(embedded.fetchedAt).getTime();
    return !isNaN(t) && Date.now() - t < EMBED_TTL;
  }

  function parseItems(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('RSS 解析失败');
    return [...doc.querySelectorAll('item')].map((it) => {
      const get = (n) => (it.querySelector(n) ? it.querySelector(n).textContent.trim() : '');
      const rawDesc = get('description');
      // 第一条 <p> 是仓库简介（description 内 HTML 是转义后的）
      const firstP = rawDesc.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      let about = '';
      if (firstP) {
        const d = new DOMParser().parseFromString(firstP[1], 'text/html');
        about = (d.body.textContent || '').replace(/\s+/g, ' ').trim();
      }
      return { title: get('title'), link: get('link'), about, date: get('pubDate') };
    });
  }

  // 依次尝试 jsDelivr → GitHub Pages
  async function fetchNetwork(period) {
    let lastErr = '网络请求失败';
    for (const mirror of MIRRORS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const url = mirror(period) + (mirror(period).includes('?') ? '&' : '?') + 't=' + Date.now();
        const resp = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        if (!resp.ok) { lastErr = 'HTTP ' + resp.status; continue; }
        const items = parseItems(await resp.text()).slice(0, LIMITS[period]);
        if (!items.length) { lastErr = '榜单为空'; continue; }
        return items;
      } catch (e) {
        lastErr = e.name === 'AbortError' ? '请求超时' : (e.message || e);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(lastErr);
  }

  // 返回 {items, origin}：cache / embed / live
  async function load(period, force) {
    const cached = readCache()[period];
    if (!force && cached && Date.now() - cached.at < TTL) {
      return { items: cached.items, origin: 'cache' };
    }
    if (!force && embeddedFresh()) {
      const items = embeddedItems(period);
      if (items.length) {
        // 后台静默尝试更新，不阻塞内置榜单展示
        fetchNetwork(period).then((live) => {
          const store = readCache();
          store[period] = { at: Date.now(), items: live };
          writeCache(store);
          if (currentPeriod === period) show(period, false);
        }).catch(() => { /* 静默，保留内置榜单 */ });
        return { items, origin: 'embed' };
      }
    }
    try {
      const items = await fetchNetwork(period);
      const store = readCache();
      store[period] = { at: Date.now(), items };
      writeCache(store);
      return { items, origin: 'live' };
    } catch (e) {
      if (cached && cached.items) return { items: cached.items, origin: 'stale', error: e.message };
      if (embeddedFresh()) {
        const items = embeddedItems(period);
        if (items.length) return { items, origin: 'embed', error: e.message };
      }
      throw e;
    }
  }

  function body() { return document.getElementById('trendingBody'); }
  function sheet() { return document.getElementById('trendingSheet'); }

  function renderLoading(period) {
    body().innerHTML = '<div class="trend-empty">正在加载 ' + LABELS[period] + '…</div>';
  }
  function renderError(period, msg) {
    const cached = readCache()[period];
    let html = '<div class="trend-empty">加载失败：' + esc(msg)
      + '<br>可在网络畅通时重试，或下拉刷新资讯获取今日数据。</div>';
    if (cached && cached.items) {
      html = '<div class="trend-cache-tip">在线拉取失败，以下为本地缓存（'
        + new Date(cached.at).toLocaleString('zh-CN') + '）</div>' + renderItems(cached.items);
    }
    body().innerHTML = html;
  }

  function renderItems(items) {
    if (!items.length) return '<div class="trend-empty">暂无数据</div>';
    return items.map((it, i) => {
      const rank = i + 1;
      const [owner, repo] = it.title.split('/');
      return `<a class="trend-item" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">
        <div class="trend-rank">${rank}</div>
        <div class="trend-info">
          <div class="trend-name"><span class="trend-owner">${esc(owner)}/</span>${esc(repo || it.title)}</div>
          ${it.about ? `<div class="trend-about">${esc(it.about)}</div>` : ''}
        </div>
      </a>`;
    }).join('');
  }

  function tipFor(origin, period) {
    if (origin === 'live') return '<div class="trend-cache-tip">实时榜单（' + new Date().toLocaleString('zh-CN') + ' 获取）</div>';
    if (origin === 'cache') {
      const c = readCache()[period];
      return '<div class="trend-cache-tip">本地缓存（' + new Date(c.at).toLocaleString('zh-CN') + '），6 小时内有效</div>';
    }
    if (origin === 'embed') {
      const at = embedded && embedded.fetchedAt ? new Date(embedded.fetchedAt).toLocaleString('zh-CN') : '';
      return '<div class="trend-cache-tip">随今日资讯数据更新（' + at + '），无需翻墙</div>';
    }
    if (origin === 'stale') {
      const c = readCache()[period];
      return '<div class="trend-cache-tip">在线更新失败，以下为本地缓存（' + new Date(c.at).toLocaleString('zh-CN') + '）</div>';
    }
    return '';
  }

  async function show(period, force) {
    currentPeriod = period || currentPeriod;
    document.querySelectorAll('#trendingSeg button').forEach((b) =>
      b.classList.toggle('active', b.dataset.period === currentPeriod));
    document.querySelectorAll('#trendingBar .trend-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.period === currentPeriod));
    sheet().classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (loading) return;
    loading = true;
    renderLoading(currentPeriod);
    try {
      const r = await load(currentPeriod, force);
      body().innerHTML = tipFor(r.origin, currentPeriod)
        + renderItems(r.items)
        + '<button class="btn-ghost trend-refresh" id="trendRefresh" type="button">刷新当前榜单</button>';
      const rb = document.getElementById('trendRefresh');
      if (rb) rb.addEventListener('click', () => show(currentPeriod, true));
    } catch (e) {
      renderError(currentPeriod, e.name === 'AbortError' ? '请求超时' : (e.message || e));
    } finally {
      loading = false;
    }
  }

  function hide() {
    sheet().classList.add('hidden');
    document.body.style.overflow = '';
  }

  function init() {
    document.querySelectorAll('#trendingBar .trend-btn, #trendingSeg button').forEach((b) => {
      b.addEventListener('click', () => show(b.dataset.period));
    });
    document.getElementById('trendingClose').addEventListener('click', hide);
    sheet().addEventListener('click', (e) => { if (e.target === sheet()) hide(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet().classList.contains('hidden')) hide(); });
  }

  return { init, show, hide, setEmbedded };
})();
