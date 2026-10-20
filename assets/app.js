/* ============ 资讯雷达 · 主逻辑 ============ */
(function () {
  'use strict';

  const K = {
    settings: 'nr.settings.v1',
    read: 'nr.read.v1',
    favs: 'nr.favs.v1',
    cache: 'nr.cache.v1',
    logs: 'nr.logs.v1',
    auto: 'nr.autoDate.v1',
    cardTrans: 'nr.cardTrans.v1',
    digest: 'nr.digest.v1',
  };

  const TAB_NAMES = { today: '今天', ai: 'AI 圈', ent: '娱乐圈', settings: '设置' };
  const DAY = 86400000;
  // 内置默认远程数据地址（每行一个，按顺序尝试）：Gitee 国内最快 → jsDelivr → raw.githubusercontent
  const DEFAULT_REMOTE_URLS = [
    'https://gitee.com/yuihl/news-radar/raw/main/public/data/daily.json',
    'https://cdn.jsdelivr.net/gh/ali-yui/news-radar@main/public/data/daily.json',
    'https://raw.githubusercontent.com/ali-yui/news-radar/main/public/data/daily.json',
  ].join('\n');

  const state = {
    tab: 'today',
    data: null,
    query: '',
    source: '',
    onlyUnread: false,
    onlyFav: false,
    refreshing: false,
  };

  const defaultSettings = {
    theme: 'system',
    ghToken: '',
    remoteUrl: DEFAULT_REMOTE_URLS,
    doubaoEnabled: false,
    doubaoEndpoint: '',
    doubaoKey: '',
    doubaoModel: '',
  };
  let settings = load(K.settings, defaultSettings);
  let read = load(K.read, {});
  let favs = load(K.favs, {});
  let logs = load(K.logs, []);
  let cardTrans = load(K.cardTrans, {}); // 列表卡片实时补翻缓存：id -> {title, summary}
  let digestCache = load(K.digest, {});   // 一眼预览缓存：tab -> {date, text}

  /* ---------- 工具 ---------- */
  function load(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : Object.assign(Array.isArray(fallback) ? [] : {}, fallback, v);
    } catch { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); }
    catch (e) { console.warn('存储失败', e); }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return [...document.querySelectorAll(sel)]; }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function addLog(msg) {
    logs.unshift({ t: new Date().toISOString(), msg: String(msg).slice(0, 300) });
    logs = logs.slice(0, 30);
    save(K.logs, logs);
  }

  function beijingNow() {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
    );
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hour: Number(parts.hour) === 24 ? 0 : Number(parts.hour),
      hm: `${parts.hour}:${parts.minute}`,
    };
  }

  function relTime(ms) {
    const d = Date.now() - ms;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < DAY) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 2 * DAY) return '昨天 ' + new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const dt = new Date(ms);
    return `${dt.getMonth() + 1}-${dt.getDate()} ${dt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  }

  /* ---------- 主题 ---------- */
  function applyTheme() {
    const want = settings.theme === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : settings.theme;
    document.documentElement.setAttribute('data-theme', want);
    $all('#themeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.theme === settings.theme));
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());

  /* ---------- 数据加载 ---------- */
  function validPayload(p) {
    return p && Array.isArray(p.items) && p.items.length;
  }

  function applyData(payload, source) {
    if (!validPayload(payload)) return false;
    state.data = payload;
    save(K.cache, payload);
    if (window.Trending && window.Trending.setEmbedded) window.Trending.setEmbedded(payload.trending || null);
    if (window.Detail && window.Detail.isOpen()) window.Detail.refresh();
    renderUpdated();
    renderList();
    renderSourceStatus();
    if (source) addLog('数据更新成功（' + source + '）：' + payload.items.length + ' 条');
    return true;
  }

  async function fetchOne(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const p = await resp.json();
      return validPayload(p) ? p : null;
    } finally {
      clearTimeout(timer);
    }
  }

  function cacheBust(u) {
    return u + (u.includes('?') ? '&' : '?') + 't=' + Date.now();
  }

  // 数据来源顺序：远程地址（可多个，每行一个，按顺序尝试） → 同目录 daily.json（网页部署） → 内置数据
  async function fetchDaily(opts = {}) {
    const remote = (settings.remoteUrl || '').split(/[\s,，]+/).filter(Boolean);
    const isFile = location.protocol === 'file:';
    const urls = [...remote];
    if (!isFile) urls.push('public/data/daily.json');
    if (!urls.length) return null; // 无远程地址：静默使用内置数据，不刷错误
    const failures = [];
    for (const u of urls) {
      try {
        const p = await fetchOne(cacheBust(u));
        if (p) return p;
        failures.push(u + '：数据格式不正确');
      } catch (e) {
        failures.push(u + '：' + (e.name === 'AbortError' ? '超时' : (e.message || e)));
      }
    }
    if (opts.silent !== true) {
      for (const f of failures) addLog('数据拉取失败（' + f + '）');
    }
    return null;
  }

  function statsOf(items) {
    const byCategory = { today: 0, ai: 0, ent: 0 };
    const bySource = {};
    for (const it of items) {
      byCategory[it.category] = (byCategory[it.category] || 0) + 1;
      for (const c of it.extraCategories || []) byCategory[c] = (byCategory[c] || 0) + 1;
      bySource[it.source] = (bySource[it.source] || 0) + 1;
    }
    return { total: items.length, byCategory, bySource };
  }

  async function doRefresh(manual) {
    if (state.refreshing) return;
    state.refreshing = true;
    $('#refreshBtn').classList.add('spinning');
    if (manual) toast('正在刷新…');
    try {
      const daily = await fetchDaily();
      const live = await window.LiveFetcher.fetch(settings).catch((e) => ({ items: [], errors: [{ source: 'live', stage: 'fatal', message: String(e) }] }));
      const base = daily || state.data;
      if (!base) {
        showBanner('暂时无法获取数据，也没有本地缓存，请检查网络后重试。', false);
        return;
      }
      const merged = window.Dedup.dedup([...base.items, ...live.items])
        .sort((a, b) => b.publishedAtMs - a.publishedAtMs);
      const errors = [...(daily?.errors || state.data?.errors || []), ...(live.errors || [])];
      const status = [...(daily?.sourceStatus || state.data?.sourceStatus || []), ...(live.sourceStatus || [])];
      const payload = {
        version: 1,
        generatedAt: new Date().toISOString(),
        generatedAtBeijing: beijingNow().date + ' ' + beijingNow().hm,
        stats: statsOf(merged),
        sourceStatus: status,
        errors,
        items: merged,
      };
      applyData(payload, daily ? 'daily.json+在线' : '在线');
      save(K.auto, beijingNow().date);
      if (errors.length) {
        const names = [...new Set(errors.map((e) => e.source.split(':')[0]))].slice(0, 6).join('、');
        showBanner(`部分源更新失败（${names}），已显示最新可用数据；失败原因可在「设置 → 一键复制报错」中查看。`, false);
      } else {
        showBanner('已更新到最新：' + payload.generatedAtBeijing + '，共 ' + merged.length + ' 条。', true);
      }
      if (manual) toast('刷新完成，共 ' + merged.length + ' 条');
    } catch (e) {
      addLog('刷新失败：' + (e.message || e));
      showBanner('更新失败，正在显示本地缓存：' + (e.message || e), false);
      if (manual) toast('刷新失败，已显示缓存');
    } finally {
      state.refreshing = false;
      $('#refreshBtn').classList.remove('spinning');
    }
  }

  function showBanner(text, ok) {
    const el = $('#banner');
    el.textContent = text;
    el.classList.remove('hidden', 'ok');
    if (ok) el.classList.add('ok');
  }

  /* ---------- 渲染 ---------- */
  function renderUpdated() {
    const d = state.data;
    if (!d) { $('#updatedAt').textContent = '无数据'; return; }
    const failed = new Set((d.errors || []).map((e) => e.source.split(':')[0])).size;
    $('#updatedAt').textContent = '更新于 ' + (d.generatedAtBeijing || d.generatedAt)
      + (failed ? ' · ' + failed + ' 个源异常' : '');
  }

  function itemMap() {
    const m = new Map();
    for (const it of state.data.items) m.set(it.id, it);
    return m;
  }

  function renderList() {
    const list = $('#list');
    if (state.tab === 'settings') return;
    const cat = state.tab;
    let items = state.data ? state.data.items.filter(
      (x) => x.category === cat || (x.extraCategories || []).includes(cat)) : [];

    if (state.query) {
      const q = state.query.toLowerCase();
      items = items.filter((x) =>
        x.title.toLowerCase().includes(q)
        || (x.titleZh || '').toLowerCase().includes(q)
        || (x.summary || '').toLowerCase().includes(q)
        || (x.summaryZh || '').toLowerCase().includes(q)
        || x.source.toLowerCase().includes(q)
        || (x.tags || []).some((t) => t.toLowerCase().includes(q)));
    }
    if (state.source) items = items.filter((x) => x.source === state.source);
    if (state.onlyUnread) items = items.filter((x) => !read[x.id]);
    if (state.onlyFav) items = items.filter((x) => favs[x.id]);

    const byMs = (a, b) => b.publishedAtMs - a.publishedAtMs;

    // 事件聚类：同一 storyId 且当前筛选结果内 ≥2 条 → 合并为一张专题卡
    const byStory = new Map();
    for (const it of items) {
      if (!it.storyId) continue;
      if (!byStory.has(it.storyId)) byStory.set(it.storyId, []);
      byStory.get(it.storyId).push(it);
    }
    const units = [];
    const usedStories = new Set();
    for (const it of items) {
      const members = it.storyId ? byStory.get(it.storyId) : null;
      if (members && members.length >= 2) {
        if (usedStories.has(it.storyId)) continue;
        usedStories.add(it.storyId);
        units.push({ type: 'cluster', storyId: it.storyId, members: members.slice().sort(byMs) });
      } else {
        units.push({ type: 'item', item: it });
      }
    }

    const groups = { hot: [], fresh: [], old: [] };
    for (const u of units) {
      const ms = u.type === 'cluster' ? u.members[0].publishedAtMs : u.item.publishedAtMs;
      const hot = u.type === 'cluster' ? u.members.some((m) => m.hot) : u.item.hot;
      if (hot) groups.hot.push(u);
      else if (Date.now() - ms <= DAY) groups.fresh.push(u);
      else groups.old.push(u);
    }
    const unitMs = (u) => (u.type === 'cluster' ? u.members[0].publishedAtMs : u.item.publishedAtMs);
    groups.hot.sort((a, b) => unitMs(b) - unitMs(a));
    groups.fresh.sort((a, b) => unitMs(b) - unitMs(a));
    groups.old.sort((a, b) => unitMs(b) - unitMs(a));

    updateSourceFilter(cat, state.data);

    if (!units.length) {
      list.innerHTML = `<div class="empty">
        <div class="big">${state.query || state.source || state.onlyFav ? '没有匹配的资讯' : '暂无数据'}</div>
        <div class="small">${state.query || state.source ? '试试更换关键词或来源' : '点击右上角刷新按钮，或等待每日 09:00 自动更新'}</div>
      </div>`;
      return;
    }

    const labels = { hot: '实时热点', fresh: '近 24 小时', old: '更早' };
    let html = digestCardHtml();
    for (const key of ['hot', 'fresh', 'old']) {
      if (!groups[key].length) continue;
      html += `<div class="group-label">${labels[key]} · ${groups[key].length}</div>`;
      html += groups[key].map((u) => (u.type === 'cluster' ? clusterCardHtml(u) : cardHtml(u.item))).join('');
    }
    list.innerHTML = html;
  }

  /* ---------- 一眼预览（板块级 AI 摘要） ---------- */
  function digestCardHtml() {
    const cached = digestCache[state.tab];
    const fresh = cached && cached.date === beijingNow().date;
    const bodyHtml = cached ? esc(cached.text) : '';
    return `<div class="digest-card">
      <div class="digest-head">
        <div class="digest-title">一眼预览 · 本期重点${fresh ? '' : ''}</div>
        <button class="digest-btn" data-act="digest" type="button">${cached ? '重新生成' : '生成摘要'}</button>
      </div>
      <div class="digest-hint">${window.DoubaoAI.enabled(settings)
        ? '基于本屏资讯由 AI 提炼，点击按钮生成'
        : '在「设置」中配置 AI 接口后可生成'}</div>
      <div class="digest-body ${cached ? '' : 'hidden'}" id="digestBody">${bodyHtml}</div>
    </div>`;
  }

  async function generateDigest() {
    if (!state.data) return;
    if (!window.DoubaoAI.enabled(settings)) {
      toast('请先在「设置」中开启并配置 AI 接口');
      return;
    }
    const btn = document.querySelector('#list [data-act="digest"]');
    const body = $('#digestBody');
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (body) { body.classList.remove('hidden'); body.textContent = '正在生成本期重点…'; }
    try {
      const cat = state.tab;
      const items = state.data.items
        .filter((x) => x.category === cat || (x.extraCategories || []).includes(cat))
        .sort((a, b) => b.publishedAtMs - a.publishedAtMs);
      const text = await window.DoubaoAI.digest(cat, items, settings);
      digestCache[cat] = { date: beijingNow().date, text };
      save(K.digest, digestCache);
      if (body) body.textContent = text;
      addLog('一眼预览生成成功（' + cat + '）');
      toast('已生成本期重点');
    } catch (e) {
      if (body) body.textContent = '生成失败：' + (e.message || e);
      addLog('一眼预览失败：' + (e.message || e));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = digestCache[state.tab] ? '重新生成' : '生成摘要';
      }
    }
  }

  // 事件聚类卡：代表条目 + 「N 家报道」展开
  function clusterCardHtml(u) {
    const rep = u.members[0];
    const title = rep.titleZh || cardTrans[rep.id]?.title || rep.title;
    const summary = rep.summaryZh || cardTrans[rep.id]?.summary || rep.summary || '';
    const members = u.members.map((m) => `
      <button class="story-row" data-act="open" data-id="${m.id}" type="button">
        <span class="story-row-src">${esc(m.source)}</span>
        <span class="story-row-title">${esc(m.titleZh || cardTrans[m.id]?.title || m.title)}</span>
        <span class="story-row-time">${esc(relTime(m.publishedAtMs))}</span>
      </button>`).join('');
    return `<article class="item cluster" data-story="${esc(u.storyId)}">
      <div class="item-main">
        <div class="item-meta">
          <span class="src">${esc(rep.source)}</span><span>·</span>
          <span>${esc(relTime(rep.publishedAtMs))}</span>
          <span class="story-badge">${u.members.length} 家报道</span>
        </div>
        <div class="item-title" data-act="open" data-id="${rep.id}" role="button" tabindex="0">${esc(title)}</div>
        ${summary ? `<p class="item-summary">${esc(summary)}</p>` : ''}
        <button class="cluster-toggle" data-act="cluster-toggle" type="button">
          展开全部 ${u.members.length} 家报道
        </button>
        <div class="cluster-members hidden">${members}</div>
      </div>
    </article>`;
  }

  function cardHtml(it) {
    const isRead = !!read[it.id];
    const isFav = !!favs[it.id];
    const tr = cardTrans[it.id] || {};
    const starFill = isFav
      ? '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 17.3 6.2 20.6l1.6-6.7L2.5 9.3l6.8-.6L12 2.5l2.7 6.2 6.8.6-5.3 4.6 1.6 6.7z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 17.3 6.2 20.6l1.6-6.7L2.5 9.3l6.8-.6L12 2.5l2.7 6.2 6.8.6-5.3 4.6 1.6 6.7z"/></svg>';
    const tags = (it.tags || []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const aiBtn = window.DoubaoAI.enabled(settings)
      ? `<button class="ai-btn" data-act="ai" data-id="${it.id}" type="button">AI 摘要</button>` : '';
    // 中文优先：预翻译 titleZh > 实时补翻缓存 > 原文
    const title = it.titleZh || tr.title || it.title;
    const summary = it.summaryZh || tr.summary || it.summary || '';
    // 非中文标题且无预翻译时提供「译」按钮（App 内实时翻译，不跳外部）
    const isCjk = /[\u4e00-\u9fff]/.test(it.title || '');
    const transBtn = (!isCjk && !it.titleZh && it.url && window.Translator)
      ? `<button class="ai-btn trans-btn" data-act="trans" data-id="${it.id}" type="button">${tr.title ? '已译' : '译'}</button>` : '';
    // 同事件多源报道标记
    const storyCount = it.storyId
      ? (state.data.items.filter((x) => x.storyId === it.storyId).length) : 0;
    const storyBadge = storyCount >= 2
      ? `<span class="story-badge" data-act="story" data-id="${it.id}" title="同一事件的多源报道">${storyCount} 家报道</span>` : '';
    return `<article class="item ${isRead ? 'read' : ''}" data-id="${it.id}">
      <div class="item-main">
        <div class="item-meta">
          <span class="src">${esc(it.source)}</span><span>·</span>
          <span>${esc(relTime(it.publishedAtMs))}</span>
          ${storyBadge}
          <span class="unread-dot"></span>
        </div>
        <a class="item-title" href="${esc(it.url || '#')}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>
        ${summary ? `<p class="item-summary">${esc(summary)}</p>` : ''}
        ${tags ? `<div class="item-tags">${tags}</div>` : ''}
        <div class="ai-result hidden" data-ai-box="${it.id}"></div>
      </div>
      <div class="item-side">
        <button class="fav-btn ${isFav ? 'on' : ''}" data-act="fav" data-id="${it.id}" aria-label="收藏">${starFill}</button>
        ${transBtn}
        ${aiBtn}
      </div>
    </article>`;
  }

  function updateSourceFilter(cat, data) {
    const sel = $('#sourceFilter');
    const cur = state.source;
    const counts = new Map();
    for (const it of (data?.items || [])) {
      if (it.category !== cat && !(it.extraCategories || []).includes(cat)) continue;
      counts.set(it.source, (counts.get(it.source) || 0) + 1);
    }
    const opts = ['<option value="">全部来源</option>']
      .concat([...counts.entries()].sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `<option value="${esc(s)}"${s === cur ? ' selected' : ''}>${esc(s)}（${n}）</option>`));
    sel.innerHTML = opts.join('');
  }

  /* ---------- 已读 / 收藏 / AI ---------- */
  $('#list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) {
      e.preventDefault();
      const id = btn.dataset.id;
      if (btn.dataset.act === 'open') {
        // 聚类卡标题/成员行：App 内打开详情
        if (window.Detail) window.Detail.open(id);
        return;
      }
      if (btn.dataset.act === 'digest') {
        generateDigest();
        return;
      }
      if (btn.dataset.act === 'cluster-toggle') {
        const card = btn.closest('.cluster');
        const box = card && card.querySelector('.cluster-members');
        if (box) {
          box.classList.toggle('hidden');
          const n = card.querySelectorAll('.story-row').length;
          btn.textContent = box.classList.contains('hidden') ? `展开全部 ${n} 家报道` : '收起报道';
        }
        return;
      }
      if (btn.dataset.act === 'fav') {
        if (favs[id]) {
          delete favs[id];
          toast('已取消收藏');
        } else {
          const it = state.data.items.find((x) => x.id === id);
          favs[id] = {
            title: it?.title, url: it?.url, source: it?.source,
            publishedAt: it?.publishedAt, savedAt: new Date().toISOString(),
          };
          toast('已收藏');
        }
        save(K.favs, favs);
        const card = btn.closest('.item');
        btn.classList.toggle('on', !!favs[id]);
        btn.innerHTML = favs[id]
          ? '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 17.3 6.2 20.6l1.6-6.7L2.5 9.3l6.8-.6L12 2.5l2.7 6.2 6.8.6-5.3 4.6 1.6 6.7z"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 17.3 6.2 20.6l1.6-6.7L2.5 9.3l6.8-.6L12 2.5l2.7 6.2 6.8.6-5.3 4.6 1.6 6.7z"/></svg>';
        if (state.onlyFav && !favs[id]) card.remove();
        return;
      }
      if (btn.dataset.act === 'ai') {
        const it = state.data.items.find((x) => x.id === id);
        const box = document.querySelector(`[data-ai-box="${id}"]`);
        if (!it || !box) return;
        if (!window.DoubaoAI.enabled(settings)) {
          toast('请先在「设置」中开启并配置豆包 API');
          return;
        }
        btn.disabled = true; btn.textContent = '生成中…';
        try {
          const text = await window.DoubaoAI.summarize(it, settings);
          box.innerHTML = `<div class="ai-head">豆包 AI 摘要</div>${esc(text)}`;
          box.classList.remove('hidden');
        } catch (err) {
          toast('AI 摘要失败：' + (err.message || err));
          addLog('豆包摘要失败：' + (err.message || err));
        } finally {
          btn.disabled = false; btn.textContent = 'AI 摘要';
        }
      }
      if (btn.dataset.act === 'trans') {
        // App 内实时翻译（免费 API 多源回退 + 本地缓存），不跳外部浏览器
        const it = state.data.items.find((x) => x.id === id);
        if (!it) return;
        if (cardTrans[id]?.title) { toast('已显示译文'); return; }
        btn.disabled = true; btn.textContent = '译中';
        try {
          const [t, s] = await Promise.all([
            window.Translator.translate(it.title),
            it.summary ? window.Translator.translate(it.summary.slice(0, 500)) : Promise.resolve(null),
          ]);
          if (t) {
            cardTrans[id] = { title: t, summary: s };
            save(K.cardTrans, cardTrans);
            const card = btn.closest('.item');
            const titleEl = card && card.querySelector('.item-title');
            const sumEl = card && card.querySelector('.item-summary');
            if (titleEl) titleEl.textContent = t;
            if (sumEl && s) sumEl.textContent = s;
            btn.textContent = '已译';
            toast('已翻译为中文');
          } else {
            btn.textContent = '译';
            toast('翻译服务暂不可用，请稍后重试');
          }
        } catch (e) {
          btn.textContent = '译';
          toast('翻译失败：' + (e.message || e));
        } finally {
          btn.disabled = false;
        }
      }
      if (btn.dataset.act === 'story') {
        // 打开该事件的详情（详情页内含其他报道列表）
        if (window.Detail) window.Detail.open(id);
        return;
      }
      return;
    }
    // 点击标题/卡片：在 App 内打开详情（不跳外部浏览器）
    const titleLink = e.target.closest('.item-title');
    if (titleLink) {
      e.preventDefault();
      const article = titleLink.closest('.item');
      const id = article?.dataset.id;
      if (id && window.Detail) window.Detail.open(id);
    }
  });

  /* ---------- Tab 与筛选 ---------- */
  function switchTab(tab) {
    state.tab = tab;
    $all('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    const isSettings = tab === 'settings';
    $('#list').classList.toggle('hidden', isSettings);
    $('#filtersBar').classList.toggle('hidden', isSettings);
    $('#trendingBar').hidden = isSettings || tab !== 'ai';
    $('#page-settings').classList.toggle('hidden', !isSettings);
    $('#tabTitle').textContent = TAB_NAMES[tab];
    if (!isSettings) {
      state.source = ''; state.onlyUnread = false; state.onlyFav = false;
      state.query = $('#searchInput').value = '';
      $('#clearSearch').classList.add('hidden');
      $all('.chip').forEach((c) => c.classList.remove('active'));
      renderList();
    } else {
      renderSourceStatus();
    }
    window.scrollTo({ top: 0 });
  }
  $all('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('#searchInput').addEventListener('input', (e) => {
    state.query = e.target.value.trim();
    $('#clearSearch').classList.toggle('hidden', !state.query);
    renderList();
  });
  $('#clearSearch').addEventListener('click', () => {
    $('#searchInput').value = ''; state.query = '';
    $('#clearSearch').classList.add('hidden');
    renderList();
  });
  $('#sourceFilter').addEventListener('change', (e) => { state.source = e.target.value; renderList(); });
  $all('.chip').forEach((chip) => chip.addEventListener('click', () => {
    const key = chip.dataset.filter === 'unread' ? 'onlyUnread' : 'onlyFav';
    state[key] = !state[key];
    chip.classList.toggle('active', state[key]);
    renderList();
  }));
  $('#refreshBtn').addEventListener('click', () => doRefresh(true));

  /* ---------- 设置 ---------- */
  function fillSettings() {
    $('#ghToken').value = settings.ghToken || '';
    $('#remoteUrl').value = settings.remoteUrl || '';
    $('#doubaoEnabled').checked = !!settings.doubaoEnabled;
    $('#doubaoEndpoint').value = settings.doubaoEndpoint || '';
    $('#doubaoKey').value = settings.doubaoKey || '';
    $('#doubaoModel').value = settings.doubaoModel || '';
    $('#doubaoFields').classList.toggle('hidden', !settings.doubaoEnabled);
    applyTheme();
  }

  $all('#themeSeg button').forEach((b) => b.addEventListener('click', () => {
    settings.theme = b.dataset.theme;
    save(K.settings, settings);
    applyTheme();
  }));

  $('#doubaoEnabled').addEventListener('change', (e) => {
    $('#doubaoFields').classList.toggle('hidden', !e.target.checked);
  });

  $('#saveSettings').addEventListener('click', () => {
    settings.ghToken = $('#ghToken').value.trim();
    settings.remoteUrl = $('#remoteUrl').value.trim();
    settings.doubaoEnabled = $('#doubaoEnabled').checked;
    settings.doubaoEndpoint = $('#doubaoEndpoint').value.trim();
    settings.doubaoKey = $('#doubaoKey').value.trim();
    settings.doubaoModel = $('#doubaoModel').value.trim();
    save(K.settings, settings);
    addLog('设置已保存');
    toast('设置已保存');
    renderList();
  });

  $('#refreshNow').addEventListener('click', () => doRefresh(true));

  $('#clearCache').addEventListener('click', () => {
    if (!confirm('清除本地缓存与诊断日志？已读、收藏记录会保留。')) return;
    localStorage.removeItem(K.cache);
    localStorage.removeItem(K.logs);
    logs = [];
    const boot = window.__NEWS_RADAR_BOOTSTRAP__;
    if (validPayload(boot)) state.data = boot;
    renderUpdated(); renderList(); renderSourceStatus();
    toast('缓存已清除');
  });

  $('#exportFavs').addEventListener('click', () => {
    const ids = Object.keys(favs);
    if (!ids.length) { toast('还没有收藏'); return; }
    const map = itemMap();
    const rows = ids.map((id) => {
      const f = favs[id];
      const live = map.get(id);
      return {
        标题: f.title || live?.title,
        来源: f.source || live?.source,
        链接: f.url || live?.url,
        发布时间: f.publishedAt || live?.publishedAt,
        收藏时间: f.savedAt,
      };
    });
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '资讯雷达-收藏-' + beijingNow().date + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 ' + rows.length + ' 条收藏');
  });

  function renderSourceStatus() {
    const box = $('#sourceStatus');
    if (!box) return;
    const st = state.data?.sourceStatus || [];
    if (!st.length) { box.innerHTML = '<p class="hint">暂无抓取状态（离线数据未包含）</p>'; return; }
    box.innerHTML = st.map((s) => {
      const cls = s.ok ? 'ok' : 'fail';
      const label = s.ok ? '正常' : '失败';
      const meta = s.mode ? `${s.mode} · ${s.items} 条` : `${s.items} 条`;
      const err = s.error ? `（${esc(s.error)}）` : '';
      return `<div class="status-row">
        <span class="status-dot ${cls}"></span>
        <span class="status-name">${esc(s.source)} · ${label}${err}</span>
        <span class="status-meta">${esc(meta)}</span>
      </div>`;
    }).join('');
  }

  $('#copyError').addEventListener('click', async () => {
    const bj = beijingNow();
    const lines = [];
    lines.push('【资讯雷达 · 问题报告】');
    lines.push('报告时间：' + bj.date + ' ' + bj.hm + '（北京时间）');
    lines.push('UA：' + navigator.userAgent);
    lines.push('主题：' + settings.theme);
    lines.push('数据版本：' + (state.data?.generatedAtBeijing || state.data?.generatedAt || '无'));
    lines.push('条目数：' + (state.data?.stats?.total ?? 0)
      + '（今天 ' + (state.data?.stats?.byCategory?.today ?? 0)
      + ' / AI圈 ' + (state.data?.stats?.byCategory?.ai ?? 0)
      + ' / 娱乐 ' + (state.data?.stats?.byCategory?.ent ?? 0) + '）');
    lines.push('已读：' + Object.keys(read).length + '，收藏：' + Object.keys(favs).length);
    lines.push('GitHub Token：' + (settings.ghToken ? '已配置' : '未配置'));
    lines.push('远程数据地址：' + (settings.remoteUrl || '未配置（使用内置数据）'));
    lines.push('豆包 API：' + (window.DoubaoAI.enabled(settings) ? '已启用' : '未启用'));
    lines.push('');
    lines.push('— 数据源状态 —');
    for (const s of state.data?.sourceStatus || []) {
      lines.push(`[${s.ok ? 'OK' : 'FAIL'}] ${s.source} ${s.mode || ''} ${s.items} 条${s.error ? ' · ' + s.error : ''}`);
    }
    lines.push('');
    lines.push('— 本次抓取错误 —');
    for (const e of state.data?.errors || []) {
      lines.push(`[${e.source}/${e.stage}] ${e.message}（${e.at}）`);
    }
    lines.push('');
    lines.push('— 本地诊断日志（最近 10 条）—');
    for (const l of logs.slice(0, 10)) lines.push(`${l.t} ${l.msg}`);
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('报错信息已复制到剪贴板');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('报错信息已复制');
    }
  });

  /* ---------- 启动 ---------- */
  // 暴露给详情页/其他模块的最小接口
  window.NRApp = {
    getItem: (id) => (state.data ? state.data.items.find((x) => x.id === id) || null : null),
    isFav: (id) => !!favs[id],
    toggleFav: (id) => {
      const it = state.data ? state.data.items.find((x) => x.id === id) : null;
      if (favs[id]) {
        delete favs[id];
        save(K.favs, favs);
        return false;
      }
      favs[id] = {
        title: it?.title, url: it?.url, source: it?.source,
        publishedAt: it?.publishedAt, savedAt: new Date().toISOString(),
      };
      save(K.favs, favs);
      return true;
    },
    isRead: (id) => !!read[id],
    markRead: (id) => {
      if (read[id]) return;
      read[id] = Date.now();
      save(K.read, read);
      const card = document.querySelector(`.item[data-id="${id}"]`);
      if (card) card.classList.add('read');
    },
    // 同一事件（storyId）的其他报道
    getStoryItems: (storyId) => {
      if (!storyId || !state.data) return [];
      return state.data.items.filter((x) => x.storyId === storyId && x.storyId);
    },
    getSettings: () => settings,
    toast,
    addLog,
  };

  async function boot() {
    fillSettings();
    if (window.Trending) window.Trending.init();
    if (window.Detail) window.Detail.init(window.NRApp);
    // 1. 内联引导数据
    const boot = window.__NEWS_RADAR_BOOTSTRAP__;
    const cache = load(K.cache, null);
    if (validPayload(boot)) applyData(boot, null);
    if (validPayload(cache) && (!state.data || new Date(cache.generatedAt) > new Date(state.data.generatedAt))) {
      applyData(cache, null);
    }
    if (!state.data) {
      $('#list').innerHTML = '<div class="empty"><div class="big">首次加载中</div>'
        + '<div class="small">正在获取最新数据…</div></div>';
    } else {
      renderList();
    }

    // 2. 拉取最新数据（远程地址 / 同目录 daily.json；启动时失败不刷日志）
    const daily = await fetchDaily({ silent: true });
    if (daily && (!state.data || new Date(daily.generatedAt) >= new Date(state.data.generatedAt))) {
      applyData(daily, null);
      renderUpdated();
    }

    // 3. 北京时间 09:00 后首次打开自动更新
    const bj = beijingNow();
    const lastAuto = localStorage.getItem(K.auto);
    if (bj.hour >= 9 && lastAuto !== bj.date) {
      doRefresh(false);
    }
    setInterval(() => {
      const b = beijingNow();
      const last = localStorage.getItem(K.auto);
      if (b.hour >= 9 && last !== b.date) doRefresh(false);
    }, 60000);

    // 4. 初始异常提示
    if (state.data?.errors?.length) {
      showBanner('部分数据源上次抓取失败，正在显示缓存数据；可在「设置 → 一键复制报错」中查看详情。', false);
    }
    addLog('App 启动，数据版本 ' + (state.data?.generatedAt || '无'));
  }

  boot();
})();
