/* ============ 资讯雷达 · App 内详情页与阅读器 ============
 * 点列表卡片在 App 内打开详情：摘要 / 全文阅读、字号调节、
 * 译 ↔ 原文切换（预翻译优先，缺失时浏览器端实时补翻）、
 * 同事件多源报道、AI 摘要（用户自填 Key 按需生成）。
 * 全程不跳出 App；「打开原文」为可选的次要操作。
 */
window.Detail = (function () {
  'use strict';

  const K = {
    font: 'nr.readerFont.v1',
    trans: 'nr.detailTrans.v1',
  };
  const FONT_STEPS = [
    { label: '小', px: 15 },
    { label: '标准', px: 16.5 },
    { label: '大', px: 18 },
    { label: '特大', px: 20 },
  ];
  const MAX_TRANS_PARAS = 80; // 实时补翻的段落上限，避免请求过多

  let app = null;        // NRApp 引用（app.js 注入）
  let currentId = null;
  let currentOverride = null; // Trending 仓库等非 daily.json 条目
  let view = 'full';     // full = 全文，summary = 只看摘要
  let fontStep = 1;
  let transCache = {};   // id -> {title, summary, paras, at}
  let transBusy = false;

  function currentItem() {
    return currentOverride || (currentId ? app.getItem(currentId) : null);
  }

  /* ---------- 工具 ---------- */
  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function load(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); }
    catch { /* 存储满时忽略 */ }
  }
  function fmtTime(ms) {
    return new Date(ms).toLocaleString('zh-CN',
      { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- 打开 / 关闭 ---------- */
  function open(id) {
    const it = app.getItem(id);
    if (!it) return;
    currentId = id;
    currentOverride = null;
    view = 'full';
    app.markRead(id);
    render();
    $('#page-detail').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('#detailScroll').scrollTop = 0;
  }

  // Trending 仓库等非 daily.json 条目：构造伪 item 复用详情页
  function openRepo(repo) {
    if (!repo || !repo.link) return;
    currentId = null;
    currentOverride = {
      id: 'repo:' + repo.link,
      title: repo.title || repo.link,
      titleZh: null,
      summary: repo.about || 'GitHub Trending 开源仓库',
      source: 'GitHub Trending',
      sourceType: 'github',
      url: repo.link,
      publishedAtMs: Date.now(),
      publishedAt: new Date().toISOString(),
      tags: ['GitHub', 'Trending', '开源', repo.lang].filter(Boolean),
      hot: true,
      content: '',
      storyId: null,
    };
    view = 'full';
    render();
    $('#page-detail').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('#detailScroll').scrollTop = 0;
  }

  function close() {
    $('#page-detail').classList.add('hidden');
    document.body.style.overflow = '';
    currentId = null;
    currentOverride = null;
  }

  function isOpen() { return !$('#page-detail').classList.contains('hidden'); }

  /* ---------- 翻译（实时补翻） ---------- */
  function transOf(id) { return transCache[id] || null; }

  async function translateCurrent() {
    const it = currentItem();
    if (!it || transBusy) return;
    transBusy = true;
    const btn = $('#detailTransBtn');
    if (btn) { btn.disabled = true; btn.textContent = '翻译中…'; }

    const entry = { title: null, summary: null, paras: null, at: Date.now() };
    try {
      // 标题与摘要（较短，先行）
      const [t, s] = await Promise.all([
        window.Translator.translate(it.title),
        it.summary ? window.Translator.translate(it.summary.slice(0, 500)) : Promise.resolve(null),
      ]);
      entry.title = t;
      entry.summary = s;
      transCache[it.id] = entry;
      render(); // 先刷新标题/摘要区

      // 正文段落（较长，带进度）
      const paras = (it.content || '').split(/\n+/).filter(Boolean).slice(0, MAX_TRANS_PARAS);
      if (paras.length) {
        entry.paras = new Array(paras.length).fill(null);
        const zhParas = await window.Translator.translateParagraphs(paras, (done, total) => {
          const p = $('#detailTransProgress');
          if (p) p.textContent = `正文翻译中 ${done}/${total}`;
          // 渐进渲染：翻完一段显示一段
          entry.paras = zhParas.map((x, i) => (x != null ? x : paras[i]));
          renderContent();
        });
        entry.paras = zhParas.map((x, i) => (x != null ? x : paras[i]));
      }
      save(K.trans, transCache);
      render();
    } catch (e) {
      const box = $('#detailTransProgress');
      if (box) {
        box.textContent = '实时翻译不可用（国内网络访问不到翻译接口），'
          + '英文内容会在每晚预翻译后自动显示中文：' + (e.message || e);
      }
    } finally {
      transBusy = false;
      const b2 = $('#detailTransBtn');
      if (b2) { b2.disabled = false; }
    }
  }

  /* ---------- 渲染 ---------- */
  function starSvg(filled) {
    return filled
      ? '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 17.3 6.2 20.6l1.6-6.7L2.5 9.3l6.8-.6L12 2.5l2.7 6.2 6.8.6-5.3 4.6 1.6 6.7z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 17.3 6.2 20.6l1.6-6.7L2.5 9.3l6.8-.6L12 2.5l2.7 6.2 6.8.6-5.3 4.6 1.6 6.7z"/></svg>';
  }

  function render() {
    const it = currentItem();
    if (!it) { close(); return; }
    const tr = transOf(it.id) || {};
    const title = tr.title || it.titleZh || it.title;
    const titleIsZh = !!it.titleZh;
    const summary = tr.summary || it.summaryZh || it.summary || '';
    const isFav = app.isFav(it.id);

    $('#detailTopTitle').textContent = it.source || '详情';
    $('#detailFav').innerHTML = starSvg(isFav);
    $('#detailFav').classList.toggle('on', isFav);

    const tags = (it.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const paras = (it.content || '').split(/\n+/).filter(Boolean);

    $('#detailScroll').innerHTML = `
      <article class="detail-art">
        <div class="detail-meta">
          <span class="src">${esc(it.source)}</span><span>·</span>
          <span>${esc(fmtTime(it.publishedAtMs))}</span>
          ${it.hot ? '<span class="detail-hot">热</span>' : ''}
        </div>
        <h1 class="detail-title">${esc(title)}
          ${it.titleZh && !titleIsZh ? '' : ''}
          ${it.titleZh ? `<button class="detail-origin-link" data-act="origin-title" type="button">原文</button>` : ''}
        </h1>
        <div class="detail-actions">
          <button class="d-btn ${isFav ? 'on' : ''}" data-act="fav" type="button">${isFav ? '已收藏' : '收藏'}</button>
          <button class="d-btn" data-act="ai" type="button">AI 摘要</button>
          <button class="d-btn" id="detailTransBtn" data-act="trans" type="button">${tr.title ? '显示原文' : '译'}</button>
          ${it.url ? '<button class="d-btn ghost" data-act="open-url" type="button">打开原文</button>' : ''}
        </div>
        <div class="detail-seg seg" id="detailViewSeg">
          <button type="button" data-view="summary" class="${view === 'summary' ? 'active' : ''}">只看摘要</button>
          <button type="button" data-view="full" class="${view === 'full' ? 'active' : ''}">全文</button>
        </div>
        ${summary ? `<div class="detail-summary">${esc(summary)}</div>` : ''}
        <div class="ai-result hidden" id="detailAiBox"></div>
        <div class="detail-trans-progress" id="detailTransProgress"></div>
        <div id="detailContentZone"></div>
        ${tags ? `<div class="detail-tags">${tags}</div>` : ''}
        <div id="detailStoryZone"></div>
      </article>`;
    renderContent();
    renderStory();
  }

  function renderContent() {
    const it = currentItem();
    const zone = $('#detailContentZone');
    if (!it || !zone) return;
    if (view === 'summary') {
      zone.innerHTML = '<div class="detail-hint">当前为「只看摘要」模式，点上方「全文」阅读正文。</div>';
      return;
    }
    const tr = transOf(it.id) || {};
    const paras = (it.content || '').split(/\n+/).filter(Boolean);
    if (!paras.length) {
      // 无正文时的降级：突出摘要 + 提供 App 内打开原文（不跳外部浏览器）
      zone.innerHTML = `<div class="detail-nofull">
        <div class="detail-nofull-title">暂无全文</div>
        <div class="detail-nofull-desc">该站点暂不支持全文抽取（每晚自动重试）。可先看上方摘要，或在 App 内打开原文阅读。</div>
        ${it.url ? '<button class="d-btn primary" data-act="open-url" type="button">在 App 内打开原文</button>' : ''}
      </div>`;
      return;
    }
    const shown = tr.paras || paras;
    zone.innerHTML = `<div class="detail-content">${shown.map((p) => `<p>${esc(p)}</p>`).join('')}</div>`;
  }

  function renderStory() {
    const it = currentItem();
    const zone = $('#detailStoryZone');
    if (!it || !zone) return;
    const related = (app.getStoryItems(it.storyId) || []).filter((x) => x.id !== it.id);
    if (related.length < 1) { zone.innerHTML = ''; return; }
    zone.innerHTML = `
      <div class="story-zone">
        <div class="story-zone-title">同一事件 · ${related.length} 家其他报道</div>
        ${related.map((x) => `
          <button class="story-row" data-act="story-item" data-id="${x.id}" type="button">
            <span class="story-row-src">${esc(x.source)}</span>
            <span class="story-row-title">${esc(x.titleZh || x.title)}</span>
          </button>`).join('')}
      </div>`;
  }

  /* ---------- 字号 ---------- */
  function applyFont() {
    const f = FONT_STEPS[fontStep];
    $('#detailScroll').style.setProperty('--reader-font', f.px + 'px');
    $('#readerSizeLabel').textContent = f.label;
  }

  /* ---------- AI 摘要 ---------- */
  async function aiSummarize() {
    const it = currentItem();
    const box = $('#detailAiBox');
    if (!it || !box) return;
    if (!window.DoubaoAI.enabled(app.getSettings())) {
      app.toast('请先在「设置」中开启并配置 AI 接口');
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = '<div class="ai-head">AI 摘要</div>生成中…';
    try {
      const text = await window.DoubaoAI.summarize(it, app.getSettings());
      box.innerHTML = `<div class="ai-head">AI 摘要</div>${esc(text)}`;
    } catch (e) {
      box.innerHTML = `<div class="ai-head">AI 摘要</div>失败：${esc(e.message || e)}`;
      app.addLog('AI 摘要失败：' + (e.message || e));
    }
  }

  /* ---------- 事件 ---------- */
  function bindEvents() {
    $('#detailBack').addEventListener('click', close);
    $('#detailFav').addEventListener('click', () => {
      const it = currentItem();
      if (!it) return;
      const on = app.toggleFav(it.id);
      $('#detailFav').innerHTML = starSvg(on);
      $('#detailFav').classList.toggle('on', on);
      const btn = $('#detailScroll [data-act="fav"]');
      if (btn) {
        btn.classList.toggle('on', on);
        btn.textContent = on ? '已收藏' : '收藏';
      }
      app.toast(on ? '已收藏' : '已取消收藏');
    });

    $('#detailScroll').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const it = currentItem();
      if (act === 'fav') { $('#detailFav').click(); return; }
      if (act === 'ai') { aiSummarize(); return; }
      if (act === 'trans') {
        const cur = currentItem();
        if (cur && transOf(cur.id)) {
          delete transCache[cur.id];
          save(K.trans, transCache);
          render();
        } else {
          translateCurrent();
        }
        return;
      }
      if (act === 'open-url') {
        if (it && it.url) window.open(it.url, '_blank', 'noopener,noreferrer');
        return;
      }
      if (act === 'origin-title') {
        app.toast('原文：' + (it ? it.title.slice(0, 60) : ''));
        return;
      }
      if (act === 'story-item') {
        open(btn.dataset.id);
        return;
      }
    });

    $('#detailScroll').addEventListener('click', (e) => {
      const seg = e.target.closest('#detailViewSeg button');
      if (!seg) return;
      view = seg.dataset.view;
      $('#detailViewSeg').querySelectorAll('button').forEach((b) =>
        b.classList.toggle('active', b.dataset.view === view));
      renderContent();
    });

    $('#readerBar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-font]');
      if (!btn) return;
      fontStep = Math.max(0, Math.min(FONT_STEPS.length - 1,
        fontStep + (btn.dataset.font === 'inc' ? 1 : -1)));
      save(K.font, fontStep);
      applyFont();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) close();
    });
  }

  /* ---------- 启动 ---------- */
  function init(nrApp) {
    app = nrApp;
    fontStep = Math.max(0, Math.min(FONT_STEPS.length - 1, load(K.font, 1)));
    transCache = load(K.trans, {}) || {};
    applyFont();
    bindEvents();
  }

  return { init, open, openRepo, close, isOpen, refresh: () => { if (isOpen()) render(); } };
})();
