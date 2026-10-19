#!/usr/bin/env node
/**
 * 资讯雷达 · 数据抓取脚本（零依赖，Node >= 18）
 * ---------------------------------------------------------------
 * 由 GitHub Actions（北京时间每天 09:00）或手动运行：
 *   node scripts/fetch-data.mjs
 *
 * 产出：
 *   public/data/daily.json      前端读取的数据文件
 *   assets/data-bundle.js       同数据的内联引导包（file:// 直开也能用）
 *
 * 可选环境变量：
 *   GITHUB_TOKEN   GitHub PAT / Actions GITHUB_TOKEN，提高 REST 限流上限
 *   SKIP_*         例如 SKIP_REDDIT=1 跳过某源（调试用）
 *
 * 设计原则：单源失败不影响其他源；错误全部记录到 daily.json 的 errors。
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_JSON = join(ROOT, 'public', 'data', 'daily.json');
const OUT_BUNDLE = join(ROOT, 'assets', 'data-bundle.js');

const UA = 'news-radar/1.0 (+https://github.com/; public RSS/API aggregator)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const NOW = new Date();
const NOW_MS = NOW.getTime();
const DAY = 86400_000;
const KEEP_WINDOW_MS = 7 * DAY; // 主展示 24h，归档保留 7 天

const errors = [];
const sourceStatus = [];

function log(...a) { console.log('[fetch]', ...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) {
      const idx = i++;
      out[idx] = await fn(arr[idx], idx);
    }
  }));
  return out;
}

function recordError(source, stage, message) {
  const msg = String(message || 'unknown error').slice(0, 500);
  errors.push({ source, stage, message: msg, at: new Date().toISOString() });
  log(`✗ ${source}/${stage}: ${msg}`);
}

async function fetchWithRetry(url, opts = {}, label = '', retries = 1) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? 10000);
    try {
      const res = await fetch(url, {
        ...opts,
        signal: ctrl.signal,
        headers: { 'User-Agent': opts.ua ?? UA, ...(opts.headers || {}) },
      });
      clearTimeout(timer);
      const body = await res.text();
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
        if (res.status === 404 || res.status === 400) {
          return { ok: false, status: res.status, body, error: lastErr };
        }
      } else {
        return { ok: true, status: res.status, body };
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
    if (attempt < retries) await sleep(400 * (attempt + 1));
  }
  return { ok: false, status: 0, body: '', error: lastErr };
}

async function getJson(url, opts, label) {
  const r = await fetchWithRetry(url, opts, label);
  if (!r.ok) {
    recordError(label || url, 'request', r.error?.message || r.status);
    return null;
  }
  try { return JSON.parse(r.body); }
  catch (e) { recordError(label || url, 'json', e.message); return null; }
}

/* ============================ 文本工具 ============================ */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#x27': "'", '#x2F': '/', laquo: '«', raquo: '»',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', middot: '·', copy: '©', reg: '®',
};

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z0-9#x]+);/g, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(s) {
  if (!s) return '';
  let t = s;
  // 两轮：先解码实体再剥标签，兼容 &lt;p&gt; 这类转义 HTML
  for (let i = 0; i < 2; i++) {
    t = decodeEntities(t)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
  }
  return t.replace(/\s+/g, ' ').trim();
}

function excerptOf(html, max = 160) {
  const t = stripHtml(html);
  if (!t) return '';
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// 去掉 GitHub Issue 模板里的提交清单噪声
function cleanIssueBody(body) {
  if (!body) return '';
  return body.split(/### Before submitting/i)[0]
    .split(/## Summary of changes/i)[0]
    .trim();
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s.trim());
  return isNaN(d.getTime()) ? null : d;
}

function tag(title, url) {
  const h = createHash('sha1').update((url || '') + '|' + (title || '')).digest('hex').slice(0, 12);
  return 'n' + h;
}

/* ============================ RSS / Atom 解析 ============================ */

function pickTag(block, names) {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    if (m) return m[1];
  }
  return '';
}

function parseFeed(xml) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blockRe = isAtom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  // 频道级日期作为缺失日期的兜底
  const head = xml.split(/<item\b|<entry\b/i)[0];
  const fallbackDate = parseDate(decodeEntities(pickTag(head, ['pubDate', 'updated', 'published'])));
  const out = [];
  let m;
  while ((m = blockRe.exec(xml))) {
    const b = m[1];
    let title = decodeEntities(pickTag(b, ['title'])) || '';
    let link = '';
    if (isAtom) {
      const links = [...b.matchAll(/<link([^>]*)\/?>(?:[\s\S]*?<\/link>)?/gi)];
      let alt = null, first = null;
      for (const lm of links) {
        const attrs = lm[1] || '';
        const href = (attrs.match(/href="([^"]+)"/i) || [])[1] || '';
        if (!href) continue;
        first ??= href;
        if (/rel="alternate"/i.test(attrs)) alt = href;
      }
      link = alt || first || '';
    } else {
      link = decodeEntities(pickTag(b, ['link']));
      if (!link) {
        const sm = b.match(/<link[^>]*href="([^"]+)"/i);
        if (sm) link = sm[1];
      }
    }
    const dateRaw = pickTag(b, ['pubDate', 'published', 'updated', 'dc:date'])
      || pickTag(b, ['pubdate']);
    const sourceTag = b.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const authorTag = b.match(/<(?:dc:creator|author)[^>]*>(?:[\s\S]*?<name>)?([^<]+)(?:<\/name>)?/i);
    out.push({
      title: title.replace(/\s+/g, ' ').trim(),
      link: link.trim(),
      date: parseDate(decodeEntities(dateRaw)) || fallbackDate,
      content: pickTag(b, ['content:encoded', 'content', 'description', 'summary']),
      source: decodeEntities(sourceTag?.[1] || ''),
      author: decodeEntities(authorTag?.[1] || ''),
    });
  }
  return out;
}

/* ============================ 去重 ============================ */

const TRACKING_PARAMS = /^(utm_|spm|sa|rsv_dl|from$|from_|fbclid|gclid|share|share_source|shareid|_ts|ts|isappinstalled)/i;

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hostname = x.hostname.replace(/^www\./, '');
    x.hash = '';
    const keep = [];
    for (const [k, v] of x.searchParams) {
      if (!TRACKING_PARAMS.test(k)) keep.push(`${k}=${v}`);
    }
    x.search = keep.join('&');
    let path = x.pathname.replace(/\/+$/, '');
    return x.protocol + '//' + x.hostname + path + (x.search ? '?' + x.search : '');
  } catch { return u; }
}

function normalizeTitle(t) {
  return (t || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function grams(t) {
  const norm = (t || '').toLowerCase();
  const cjk = norm.match(/[\u4e00-\u9fff]/g) || [];
  const words = norm.match(/[a-z0-9]+/g) || [];
  const set = new Set();
  const cjkStr = cjk.join('');
  for (let i = 0; i < cjkStr.length - 1; i++) set.add(cjkStr.slice(i, i + 2));
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
  const gramsList = [];
  for (const it of items) {
    const nu = normalizeUrl(it.url || '');
    const nt = normalizeTitle(it.title);
    let dup = null;
    if (nu && byUrl.has(nu)) dup = byUrl.get(nu);
    if (!dup && nt && nt.length >= 6 && byTitle.has(nt)) dup = byTitle.get(nt);
    if (!dup && nt.length >= 8) {
      const g = grams(it.title);
      for (let i = 0; i < gramsList.length; i++) {
        if (jaccard(g, gramsList[i].g) >= 0.82) { dup = gramsList[i].item; break; }
      }
    }
    if (dup) {
      const d = kept[dup];
      if (!d.summary && it.summary) d.summary = it.summary;
      if (it.summary && it.summary.length > (d.summary?.length || 0)) d.summary = it.summary;
      d.tags = [...new Set([...(d.tags || []), ...(it.tags || [])])].slice(0, 6);
      d.extraCategories = [...new Set([...(d.extraCategories || []), ...(it.extraCategories || [])])];
      if (!d.url && it.url) d.url = it.url;
      if (it.publishedAtMs && (!d.publishedAtMs || it.publishedAtMs > d.publishedAtMs)) {
        d.publishedAtMs = it.publishedAtMs;
        d.publishedAt = new Date(it.publishedAtMs).toISOString();
      }
      continue;
    }
    const idx = kept.length;
    kept.push(it);
    if (nu) byUrl.set(nu, idx);
    if (nt && nt.length >= 6) byTitle.set(nt, idx);
    if (nt.length >= 8) gramsList.push({ g: grams(it.title), item: idx });
  }
  return kept;
}

/* ============================ 条目构造 ============================ */

const items = [];
const seenSources = new Set();

function add({ category, source, sourceType, title, url, date, excerpt, tags = [], hot = false, extraCategories = [] }) {
  title = (title || '').replace(/\s+/g, ' ').trim();
  if (!title || title.length < 4) return;
  if (url && !/^https?:\/\//.test(url)) return;
  let ms = date ? new Date(date).getTime() : null;
  if (ms && isNaN(ms)) ms = null;
  if (ms && ms < NOW_MS - KEEP_WINDOW_MS && !hot) return;
  if (!ms) { ms = NOW_MS; hot = true; } // 无时间戳的热榜数据标记为 hot
  const t = excerptOf(excerpt, 160);
  const summary = t || `${title}（来源：${source}）`;
  items.push({
    id: tag(title, url),
    category,
    extraCategories: [...new Set(extraCategories)],
    source,
    sourceType,
    title,
    url: url || '',
    publishedAt: new Date(ms).toISOString(),
    publishedAtMs: ms,
    summary,
    tags: [...new Set(tags)].slice(0, 6),
    hot,
  });
}

function trackSource(name, ok, mode, count, error = null) {
  sourceStatus.push({ source: name, ok, mode, items: count, error, at: new Date().toISOString() });
  seenSources.add(name);
}

function skipped(name) {
  return process.env['SKIP_' + name] === '1';
}

/* ============================ 1. GitHub ============================ */

async function githubAtom(repo, kind, category, extraTags = []) {
  const url = `https://github.com/${repo}/${kind}.atom`;
  const r = await fetchWithRetry(url, { ua: BROWSER_UA, timeout: 12000 }, `github-atom-${kind}`);
  if (!r.ok) { recordError('github', `atom:${repo}/${kind}`, r.error?.message || r.status); return []; }
  return parseFeed(r.body).map((e) => ({
    category,
    source: `GitHub · ${repo}`,
    sourceType: 'github',
    title: kind === 'releases' ? `发布 ${e.title}` : e.title,
    url: e.link,
    date: e.date,
    excerpt: e.content,
    tags: ['GitHub', kind === 'releases' ? 'Release' : kind === 'commits' ? 'Commit' : 'Issue', ...extraTags],
  }));
}

async function fetchGithub() {
  if (skipped('GITHUB')) return;
  const REPO = 'morluto/rea';
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  let count = 0;
  // 探针：REST 是否可用
  const probe = await fetchWithRetry(
    `https://api.github.com/repos/${REPO}/releases?per_page=10`,
    { headers, timeout: 12000 }, 'github'
  );
  const restOk = probe.ok && probe.body.trim().startsWith('[');

  if (restOk) {
    try {
      // releases
      for (const r of JSON.parse(probe.body)) {
        add({ category: 'ai', source: `GitHub · ${REPO}`, sourceType: 'github',
          title: `发布 ${r.name || r.tag_name}`, url: r.html_url,
          date: new Date(r.published_at || r.created_at), excerpt: r.body, tags: ['GitHub', 'Release', 'rea'] });
        count++;
      }
      // commits
      const commits = await getJson(`https://api.github.com/repos/${REPO}/commits?per_page=20`, { headers, timeout: 12000 }, 'github');
      for (const c of commits || []) {
        add({ category: 'ai', source: `GitHub · ${REPO}`, sourceType: 'github',
          title: c.commit?.message?.split('\n')[0], url: c.html_url,
          date: new Date(c.commit?.committer?.date || c.commit?.author?.date), excerpt: c.commit?.message,
          tags: ['GitHub', 'Commit', 'rea'] });
        count++;
      }
      // issues（排除 PR）
      const issues = await getJson(`https://api.github.com/repos/${REPO}/issues?state=all&per_page=20`, { headers, timeout: 12000 }, 'github');
      for (const i of issues || []) {
        if (i.pull_request) continue;
        add({ category: 'ai', source: `GitHub · ${REPO}`, sourceType: 'github',
          title: i.title, url: i.html_url, date: new Date(i.updated_at || i.created_at), excerpt: cleanIssueBody(i.body),
          tags: ['GitHub', 'Issue', 'rea'] });
        count++;
      }
      // rea-agents 相关仓库：取 morluto 名下 rea* 仓库
      const repos = await getJson('https://api.github.com/users/morluto/repos?per_page=100&sort=pushed', { headers, timeout: 12000 }, 'github');
      const related = (repos || [])
        .filter((x) => x.name === 'rea' || x.name.startsWith('rea-'))
        .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
        .slice(0, 8);
      for (const rp of related) {
        const cs = await getJson(`https://api.github.com/repos/${rp.full_name}/commits?per_page=3`, { headers, timeout: 12000 }, 'github');
        for (const c of cs || []) {
          add({ category: 'ai', source: `GitHub · ${rp.full_name}`, sourceType: 'github',
            title: c.commit?.message?.split('\n')[0], url: c.html_url,
            date: new Date(c.commit?.committer?.date || c.commit?.author?.date), excerpt: c.commit?.message,
            tags: ['GitHub', 'rea-agents', rp.name] });
          count++;
        }
        await sleep(150);
      }
      trackSource('github', true, 'rest', count);
    } catch (e) {
      recordError('github', 'rest-parse', e.message);
    }
  }

  if (!restOk) {
    // Atom 降级模式（无 token / 限流时使用，官方公开 Atom，不受 REST 限流）
    recordError('github', 'rest', probe.error?.message || `REST 不可用（HTTP ${probe.status}），切换 Atom 降级`);
    const jobs = [
      githubAtom(REPO, 'releases', 'ai', ['rea']),
      githubAtom(REPO, 'commits', 'ai', ['rea']),
      githubAtom(REPO, 'issues', 'ai', ['rea']),
    ];
    // 相关仓库：解析用户仓库页 HTML
    let relatedNames = [];
    const page = await fetchWithRetry('https://github.com/morluto?tab=repositories', { ua: BROWSER_UA, timeout: 12000 }, 'github');
    if (page.ok) {
      const names = [...page.body.matchAll(/href="\/morluto\/([a-z0-9_.-]+)"/gi)].map((m) => m[1]);
      relatedNames = [...new Set(names)].filter((n) => n.startsWith('rea-')).slice(0, 6);
    }
    for (const n of relatedNames) jobs.push(githubAtom(`morluto/${n}`, 'commits', 'ai', ['rea-agents']));
    const results = await Promise.allSettled(jobs);
    for (const r of results) {
      for (const it of r.value || []) { add(it); count++; }
    }
    trackSource('github', count > 0, 'atom', count, count ? null : 'Atom 降级也未取得数据');
  }
}

/* ============================ 2. Hacker News (Algolia) ============================ */

async function fetchHn() {
  if (skipped('HN')) return;
  const queries = ['REA', 'reverse engineering', 'AI agent', 'MCP', 'Ghidra', 'JADX'];
  const since = Math.floor((NOW_MS - KEEP_WINDOW_MS) / 1000);
  let count = 0;
  for (const q of queries) {
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}`
      + `&tags=story&hitsPerPage=20&numericFilters=created_at_i>${since}`;
    const data = await getJson(url, { timeout: 12000 }, 'hn');
    for (const h of data?.hits || []) {
      add({ category: 'ai', source: 'Hacker News', sourceType: 'hn',
        title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        date: new Date(h.created_at), excerpt: h.story_text,
        tags: ['Hacker News', q, h.points > 100 ? '热门' : null].filter(Boolean) });
      count++;
    }
    await sleep(180);
  }
  trackSource('hn', count > 0, 'algolia', count);
}

/* ============================ 3. Reddit ============================ */

const REDDIT_SUBREDDITS = {
  ai: ['ReverseEngineering', 'netsec', 'LocalLLaMA', 'MachineLearning', 'artificial', 'singularity'],
  ent: ['entertainment', 'movies', 'television', 'Fauxmoi'],
};

async function fetchRedditOne(category, sub) {
  let n = 0;
  const j = await getJson(`https://www.reddit.com/r/${sub}/new.json?limit=20`, { timeout: 8000 }, 'reddit');
  let entries = [];
  if (j?.data?.children) {
    for (const c of j.data.children) {
      const d = c.data || {};
      if (d.stickied) continue;
      const isSelf = d.is_self || !d.url || d.url.includes(`/r/${sub}`);
      entries.push({
        category, source: `Reddit · r/${sub}`, sourceType: 'reddit',
        title: d.title, url: isSelf ? `https://www.reddit.com${d.permalink}` : d.url,
        date: new Date((d.created_utc || 0) * 1000), excerpt: d.selftext,
        tags: ['Reddit', `r/${sub}`],
      });
    }
  } else {
    // RSS 降级
    const r = await fetchWithRetry(`https://www.reddit.com/r/${sub}/new.rss?limit=20`, { timeout: 8000 }, 'reddit');
    if (r.ok && /<rss|<feed/.test(r.body)) {
      for (const e of parseFeed(r.body)) {
        entries.push({ category, source: `Reddit · r/${sub}`, sourceType: 'reddit',
          title: e.title, url: e.link, date: e.date, excerpt: e.content, tags: ['Reddit', `r/${sub}`] });
      }
    }
  }
  for (const it of entries) { add(it); n++; }
  return n;
}

async function fetchReddit() {
  if (skipped('REDDIT')) return;
  const jobs = Object.entries(REDDIT_SUBREDDITS)
    .flatMap(([category, subs]) => subs.map((sub) => ({ category, sub })));
  const results = await mapLimit(jobs, 5, (j) => fetchRedditOne(j.category, j.sub));
  const count = results.reduce((a, b) => a + b, 0);
  trackSource('reddit', count > 0, 'json+rss', count, count ? null : 'JSON 与 RSS 均失败（可能被限流/429）');
}

/* ============================ 4/5. Google News / Bing News ============================ */

const NEWS_QUERIES = {
  today: {
    zh: ['军事', '科技', '民生', '金融'],
  },
  ai: {
    zh: ['AI Agent', 'MCP 大模型', '人工智能', 'AI Agent 框架'],
    en: ['reverse engineering AI agent', 'Ghidra JADX', 'MCP model context protocol', 'AI coding agent'],
  },
  ent: {
    zh: ['娱乐', '明星', '电影', '电视剧', '综艺', '音乐'],
  },
};

function googleNewsUrl(q, lang) {
  const base = lang === 'en'
    ? { hl: 'en-US', gl: 'US', ceid: 'US:en' }
    : { hl: 'zh-CN', gl: 'CN', ceid: 'CN:zh-Hans' };
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}`
    + `&hl=${base.hl}&gl=${base.gl}&ceid=${base.ceid}`;
}

function bingNewsUrl(q, lang) {
  return `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS&mkt=${lang === 'en' ? 'en-US' : 'zh-CN'}`;
}

function normalizeNewsTitle(title, source) {
  if (source && title.endsWith(source)) title = title.slice(0, title.length - source.length);
  title = title.replace(/\s*[-–—]\s*$/, '').trim();
  return title;
}

async function newsFromFeed(url, category, tagName, kind) {
  const r = await fetchWithRetry(url, { ua: BROWSER_UA, timeout: 12000 }, kind);
  if (!r.ok) return { ok: false, error: r.error?.message || String(r.status), items: [] };
  if (!/<rss|<feed|<rdf/i.test(r.body)) return { ok: false, error: '返回内容不是 RSS（被地区重定向或拦截）', items: [] };
  const feed = parseFeed(r.body);
  const out = [];
  for (const e of feed.slice(0, 15)) {
    const src = e.source || (kind === 'bing' ? 'Bing News' : 'Google News');
    const it = {
      category, source: src, sourceType: kind,
      title: normalizeNewsTitle(e.title, src),
      url: e.link, date: e.date, excerpt: e.content,
      tags: [tagName, kind === 'bing' ? 'Bing' : 'GoogleNews'],
    };
    out.push(it);
  }
  return { ok: true, items: out };
}

async function fetchNewsOne(category, lang, q) {
  // 先 Google，失败/空则 Bing
  const g = await newsFromFeed(googleNewsUrl(q, lang), category, q, 'googleNews');
  if (g.ok && g.items.length) {
    for (const it of g.items) add(it);
    return { google: g.items.length, bing: 0 };
  }
  recordError('googleNews', q, g.error || '空结果');
  const b = await newsFromFeed(bingNewsUrl(q, lang), category, q, 'bing');
  if (b.ok && b.items.length) {
    for (const it of b.items) add(it);
    return { google: 0, bing: b.items.length };
  }
  recordError('bing', q, b.error || '空结果');
  return { google: 0, bing: 0 };
}

async function fetchNews() {
  if (skipped('NEWS')) return;
  const jobs = [];
  for (const [category, groups] of Object.entries(NEWS_QUERIES)) {
    for (const [lang, qs] of Object.entries(groups)) {
      for (const q of qs) jobs.push({ category, lang, q });
    }
  }
  const results = await mapLimit(jobs, 4, (j) => fetchNewsOne(j.category, j.lang, j.q));
  const perCat = {};
  for (let i = 0; i < jobs.length; i++) {
    const c = jobs[i].category;
    perCat[c] ??= { google: 0, bing: 0 };
    perCat[c].google += results[i].google;
    perCat[c].bing += results[i].bing;
  }
  for (const [c, r] of Object.entries(perCat)) {
    trackSource(`googleNews:${c}`, r.google > 0, 'rss', r.google,
      r.google ? null : `Google 失败，Bing 补位 ${r.bing} 条`);
    if (r.bing) trackSource(`bing:${c}`, true, 'rss-fallback', r.bing);
    else if (!r.google) trackSource(`bing:${c}`, false, 'rss-fallback', 0, 'Bing 同样不可用');
  }
}

/* ============================ 6. GitHub Trending RSS ============================ */

async function fetchTrending() {
  if (skipped('TRENDING')) return;
  const url = 'https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml';
  const r = await fetchWithRetry(url, { timeout: 12000 }, 'trending');
  let count = 0;
  if (r.ok && /<rss|<feed/.test(r.body)) {
    for (const e of parseFeed(r.body).slice(0, 25)) {
      add({ category: 'ai', source: 'GitHub Trending', sourceType: 'rss',
        title: e.title, url: e.link, date: e.date, excerpt: e.content,
        tags: ['GitHub', 'Trending', '开源'] });
      count++;
    }
    trackSource('trending', count > 0, 'community-rss', count);
  } else {
    // 降级：GitHub 搜索 API（REST 可用时）
    recordError('trending', 'rss', r.error?.message || '不可用');
    const since = new Date(NOW_MS - 2 * DAY).toISOString().slice(0, 10);
    const data = await getJson(
      `https://api.github.com/search/repositories?q=created:>${since}&sort=stars&order=desc&per_page=20`,
      { headers: { Accept: 'application/vnd.github+json' } }, 'trending');
    for (const rp of data?.items || []) {
      add({ category: 'ai', source: 'GitHub Trending', sourceType: 'github',
        title: `${rp.full_name}：${rp.description || ''}`, url: rp.html_url,
        date: new Date(rp.created_at), tags: ['GitHub', 'Trending', '开源'] });
      count++;
    }
    trackSource('trending', count > 0, 'github-search-fallback', count, count ? null : '全部降级失败');
  }
}

/* ============================ 7. 中文补充源（公开 RSS / JSON） ============================ */

async function rssSource(name, url, category, tags, cap, mapper) {
  const r = await fetchWithRetry(url, { ua: BROWSER_UA, timeout: 12000 }, name);
  if (!r.ok || !/<rss|<feed|<rdf/i.test(r.body)) {
    recordError(name, 'rss', r.error?.message || '非 RSS 返回');
    trackSource(name, false, 'rss', 0, r.error?.message || '非 RSS');
    return;
  }
  let count = 0;
  for (const e of parseFeed(r.body).slice(0, cap)) {
    const mapped = mapper ? mapper(e) : {
      category, source: e.source || name, sourceType: 'rss',
      title: e.title, url: e.link, date: e.date, excerpt: e.content, tags: [...tags],
    };
    add(mapped);
    count++;
  }
  trackSource(name, count > 0, 'rss', count);
}

// AI/科技关键词：用于把综合源中的 AI 条目归入 AI 圈
const AI_RE = /AI|人工智能|大模型|智能体|agent|mcp|llm|gpt|deepseek|gemini|claude|具身|机器人|算力|开源|github|机器之心|自动驾驶|推理模型|微调|多模态|神经网络|aigc|copilot|cursor|langchain|vibe coding/i;

async function fetchChineseSupplements() {
  if (!skipped('ITHOME')) {
    await rssSource('IT之家', 'https://www.ithome.com/rss/', 'today', ['科技'], 30);
  }
  if (!skipped('SOLIDOT')) {
    await rssSource('Solidot', 'https://www.solidot.org/index.rss', 'ai', ['科技行业', '安全'], 20);
  }
  if (!skipped('SSPAI')) {
    await rssSource('少数派', 'https://sspai.com/feed', 'today', ['科技', '效率'], 15);
  }
  if (!skipped('CNA')) {
    await rssSource('中新网财经', 'https://www.chinanews.com.cn/rss/finance.xml', 'today', ['金融'], 20);
    await rssSource('中新网社会', 'https://www.chinanews.com.cn/rss/society.xml', 'today', ['民生'], 20);
    // 国际/军事频道
    await rssSource('中新网国际', 'https://www.chinanews.com.cn/rss/world.xml', 'today', ['军事', '国际'], 20);
  }
  if (!skipped('QBITAI')) {
    await rssSource('量子位', 'https://www.qbitai.com/feed', 'ai', ['AI', '人工智能'], 20);
  }
  if (!skipped('INFOQ')) {
    await rssSource('InfoQ中文', 'https://www.infoq.cn/feed', 'ai', ['开发', '技术'], 20);
  }
  if (!skipped('SEGMENTFAULT')) {
    // SegmentFault 全站 Atom：仅保留 AI/开发相关
    const r = await fetchWithRetry('https://segmentfault.com/feeds', { ua: BROWSER_UA, timeout: 12000 }, 'SegmentFault');
    let count = 0;
    if (r.ok && /<rss|<feed|<rdf/i.test(r.body)) {
      for (const e of parseFeed(r.body).slice(0, 40)) {
        if (!AI_RE.test(e.title) && !AI_RE.test(stripHtml(e.content))) continue;
        add({ category: 'ai', source: 'SegmentFault', sourceType: 'rss',
          title: e.title, url: e.link, date: e.date, excerpt: e.content, tags: ['开发社区', 'AI'] });
        count++;
      }
    } else {
      recordError('SegmentFault', 'rss', r.error?.message || '非 RSS 返回');
    }
    trackSource('SegmentFault', count > 0, 'atom', count, count ? null : '无 AI 相关条目');
  }
  if (!skipped('KR36')) {
    // 36氪主 feed：AI 相关入 AI 圈，其余入今天
    const r = await fetchWithRetry('https://www.36kr.com/feed', { ua: BROWSER_UA, timeout: 12000 }, '36氪');
    let count = 0;
    if (r.ok && /<rss|<feed|<rdf/i.test(r.body)) {
      for (const e of parseFeed(r.body).slice(0, 30)) {
        const isAi = AI_RE.test(e.title) || AI_RE.test(stripHtml(e.content));
        add({ category: isAi ? 'ai' : 'today', source: '36氪', sourceType: 'rss',
          title: e.title, url: e.link, date: e.date, excerpt: e.content,
          tags: isAi ? ['36氪', 'AI'] : ['36氪', '商业科技'] });
        count++;
      }
    } else {
      recordError('36氪', 'rss', r.error?.message || '非 RSS 返回');
    }
    trackSource('36氪', count > 0, 'rss', count);
    // 36氪快讯（滚动 7x24）
    const f = await fetchWithRetry('https://www.36kr.com/feed-newsflash', { ua: BROWSER_UA, timeout: 12000 }, '36氪快讯');
    let fcount = 0;
    if (f.ok && /<rss|<feed|<rdf/i.test(f.body)) {
      for (const e of parseFeed(f.body).slice(0, 20)) {
        add({ category: 'today', source: '36氪快讯', sourceType: 'rss',
          title: e.title, url: e.link, date: e.date, excerpt: e.content,
          tags: AI_RE.test(e.title) ? ['快讯', 'AI'] : ['快讯', '金融'] });
        fcount++;
      }
    } else {
      recordError('36氪快讯', 'rss', f.error?.message || '非 RSS 返回');
    }
    trackSource('36氪快讯', fcount > 0, 'rss', fcount);
  }
  if (!skipped('ZHIHU')) {
    const d = await getJson('https://news-at.zhihu.com/api/4/news/latest', { ua: BROWSER_UA, timeout: 12000 }, '知乎日报');
    let count = 0;
    for (const s of [...(d?.top_stories || []), ...(d?.stories || [])]) {
      add({ category: 'today', source: '知乎日报', sourceType: 'json',
        title: s.title, url: s.url, date: null, excerpt: s.hint, tags: ['热点', '知乎'], hot: true });
      count++;
    }
    trackSource('知乎日报', count > 0, 'json', count);
  }
  if (!skipped('BAIDU')) {
    // 百度实时热搜（公开 JSON，无需登录）
    const d = await getJson('https://top.baidu.com/api/board?platform=pc&tab=realtime',
      { ua: BROWSER_UA, headers: { Referer: 'https://www.baidu.com/' }, timeout: 12000 }, '百度热搜');
    let count = 0;
    const list = d?.data?.cards?.[0]?.content || [];
    const entRe = /明星|演员|歌手|导演|电影|电视剧|综艺|票房|演唱会|官宣|恋情|离婚|结婚|偶像|男团|女团|跑男|春晚|影帝|影后|热播|新剧|开机|杀青|女主|男主|主演|颁奖|红毯|塌房|粉丝|爱豆|出道|专辑|浪姐|披荆斩棘|剧集|网剧|番剧|动漫|游戏改编/;
    for (const it of list.slice(0, 30)) {
      const title = it.query || it.word;
      const isEnt = entRe.test(title) || entRe.test(it.desc || '');
      add({ category: 'today', source: '百度热搜', sourceType: 'json',
        title, url: it.rawUrl || it.url, date: null,
        excerpt: it.desc, tags: isEnt ? ['热点', '娱乐'] : ['热点', '民生'],
        hot: true, extraCategories: isEnt ? ['ent'] : [] });
      count++;
    }
    trackSource('百度热搜', count > 0, 'json', count);
    // 百度电影榜 → 娱乐圈
    const m = await getJson('https://top.baidu.com/api/board?platform=pc&tab=movie',
      { ua: BROWSER_UA, headers: { Referer: 'https://www.baidu.com/' }, timeout: 12000 }, '百度电影榜');
    let mcount = 0;
    for (const it of m?.data?.cards?.[0]?.content || []) {
      const movieTitle = (it.query || it.word || '').replace(/\s*(电影|电视剧|综艺|动漫|纪录片)$/g, '').trim();
      add({ category: 'ent', source: '百度电影榜', sourceType: 'json',
        title: movieTitle, url: it.rawUrl || it.appUrl, date: null,
        excerpt: it.desc, tags: ['电影'], hot: true });
      mcount++;
    }
    trackSource('百度电影榜', mcount > 0, 'json', mcount);
    // 百度电视剧榜 → 娱乐圈
    const t = await getJson('https://top.baidu.com/api/board?platform=pc&tab=teleplay',
      { ua: BROWSER_UA, headers: { Referer: 'https://www.baidu.com/' }, timeout: 12000 }, '百度电视剧榜');
    let tcount = 0;
    for (const it of t?.data?.cards?.[0]?.content || []) {
      const tvTitle = (it.query || it.word || '').replace(/\s*(电影|电视剧|综艺|动漫|纪录片)$/g, '').trim();
      add({ category: 'ent', source: '百度电视剧榜', sourceType: 'json',
        title: tvTitle, url: it.rawUrl || it.url, date: null,
        excerpt: it.desc, tags: ['电视剧'], hot: true });
      tcount++;
    }
    trackSource('百度电视剧榜', tcount > 0, 'json', tcount);
  }
  if (!skipped('BILIBILI')) {
    // B站热门视频（仅保留娱乐相关分区）
    const d = await getJson('https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1',
      { ua: BROWSER_UA, headers: { Referer: 'https://www.bilibili.com/' }, timeout: 12000 }, 'B站热门');
    const entRe = /影视|娱乐|明星|音乐|舞蹈|综艺|动画|舞台|鬼畜|特摄|影视剧/;
    let count = 0;
    for (const x of d?.data?.list || []) {
      const tname = x.tname || '';
      if (!entRe.test(tname)) continue;
      add({ category: 'ent', source: 'B站热门', sourceType: 'json',
        title: x.title, url: x.short_link_v2 || x.short_link,
        date: new Date((x.pubdate || 0) * 1000),
        excerpt: `${tname} · UP主 ${x.owner?.name || '未知'}：${x.desc || ''}`,
        tags: ['B站', tname], hot: true });
      count++;
    }
    trackSource('B站热门', count > 0, 'json', count, count ? null : '热门榜无娱乐分区条目');
  }
}

/* ============================ 主流程 ============================ */

async function main() {
  log('开始抓取，时间：', NOW.toISOString());
  await Promise.allSettled([
    fetchGithub(),
    fetchHn(),
    fetchReddit(),
    fetchNews(),
    fetchTrending(),
    fetchChineseSupplements(),
  ]);

  const deduped = dedup(items);
  // 排序：时间倒序；hot 条目以抓取时间参与
  deduped.sort((a, b) => b.publishedAtMs - a.publishedAtMs);
  // 每个分类按主分类保留上限（extraCategories 跨分类展示不计数截断）
  const CAPS = { today: 100, ai: 120, ent: 80 };
  const used = { today: 0, ai: 0, ent: 0 };
  const final = [];
  for (const it of deduped) {
    if (used[it.category] >= CAPS[it.category]) continue;
    used[it.category]++;
    final.push(it);
  }
  const counts = { today: 0, ai: 0, ent: 0 };
  for (const it of final) {
    counts[it.category]++;
    for (const c of it.extraCategories || []) counts[c] = (counts[c] || 0) + 1;
  }

  const bySource = {};
  for (const it of final) bySource[it.source] = (bySource[it.source] || 0) + 1;

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedAtBeijing: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    window: '主展示近24小时，归档保留近7天；热榜数据无精确时间戳',
    stats: { total: final.length, byCategory: counts, bySource },
    sourceStatus,
    errors,
    items: final,
  };

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await mkdir(dirname(OUT_BUNDLE), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify(payload, null, 2), 'utf8');
  await writeFile(
    OUT_BUNDLE,
    '// 由 scripts/fetch-data.mjs 自动生成，请勿手改\n'
    + 'window.__NEWS_RADAR_BOOTSTRAP__ = ' + JSON.stringify(payload) + ';\n',
    'utf8'
  );

  log(`完成：共 ${final.length} 条（今天 ${counts.today} / AI圈 ${counts.ai} / 娱乐圈 ${counts.ent}）`);
  log(`源状态：${sourceStatus.map((s) => `${s.source}:${s.ok ? 'OK' : 'FAIL'}(${s.items})`).join('  ')}`);
  if (errors.length) log(`错误 ${errors.length} 条（已记录，前端将显示缓存与原因）`);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
