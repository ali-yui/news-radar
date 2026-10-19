/* ============ 资讯雷达 · GitHub Trending 日/周/月榜（浏览器端实时拉取） ============ */
/* 数据源：mshibanami/GitHubTrendingRSS（GitHub Pages，Access-Control-Allow-Origin: *，国内可达） */
window.Trending = (function () {
  'use strict';

  const CACHE_KEY = 'nr.trending.v1';
  const TTL = 6 * 3600 * 1000; // 缓存 6 小时
  const BASE = 'https://mshibanami.github.io/GitHubTrendingRSS';
  const URLS = {
    daily: BASE + '/daily/all.xml',
    weekly: BASE + '/weekly/all.xml',
    monthly: BASE + '/monthly/all.xml',
  };
  const LABELS = { daily: '日榜', weekly: '周榜', monthly: '月榜' };
  const LIMITS = { daily: 25, weekly: 20, monthly: 20 };

  let currentPeriod = 'monthly';
  let loading = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
    catch { return {}; }
  }
  function writeCache(c) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* 忽略 */ }
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
      return {
        title: get('title'),
        link: get('link'),
        about,
        date: get('pubDate'),
      };
    });
  }

  async function load(period, force) {
    const cached = readCache()[period];
    if (!force && cached && Date.now() - cached.at < TTL) {
      return { items: cached.items, fromCache: true };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const url = URLS[period] + (URLS[period].includes('?') ? '&' : '?') + 't=' + Date.now();
      const resp = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const items = parseItems(await resp.text()).slice(0, LIMITS[period]);
      const store = readCache();
      store[period] = { at: Date.now(), items };
      writeCache(store);
      return { items, fromCache: false };
    } finally {
      clearTimeout(timer);
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
      + '<br>可在网络畅通时重试；Trending RSS 托管在 GitHub Pages。</div>';
    if (cached && cached.items) {
      html = '<div class="trend-cache-tip">在线拉取失败，以下为本地缓存（'
        + new Date(cached.at).toLocaleString('zh-CN') + '）</div>' + renderItems(cached.items, period);
    }
    body().innerHTML = html;
  }

  function renderItems(items, period) {
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
      const { items, fromCache } = await load(currentPeriod, force);
      body().innerHTML = (fromCache
        ? '<div class="trend-cache-tip">本地缓存（' + new Date(readCache()[currentPeriod].at).toLocaleString('zh-CN') + '），下拉可点刷新</div>'
        : '')
        + renderItems(items, currentPeriod)
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

  return { init, show, hide };
})();
