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
 *   SKIP_TRANSLATE=1   跳过英文标题/摘要预翻译
 *   SKIP_CONTENT=1     跳过原文正文抓取
 *   TRANSLATE_MAX=200  单次运行翻译总量上限
 *   CONTENT_LIMIT=80   单次运行正文抓取条数上限
 *
 * 产出增强（v2）：
 *   - item.titleZh / item.summaryZh   英文标题/摘要的中文预翻译
 *   - item.content                    原文正文（readability-lite 抽取，App 内读全文）
 *   - item.storyId                    事件聚类标识（多源报道合并为专题）
 *
 * 设计原则：单源失败不影响其他源；错误全部记录到 daily.json 的 errors。
 * 依赖：仅 Node 内置 API + scripts/lib/ 下零依赖模块（translate/content/cluster/extract）。
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createTranslator, isEnglish } from './lib/translate.mjs';
import { enrichContent } from './lib/content.mjs';
import { assignStories } from './lib/cluster.mjs';
import { httpGet } from './lib/http.mjs';
import { parseWeiboHot, parseToutiaoHot, parseDouyinHot } from './lib/hotsearch.mjs';

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

// 兜底：抓取是批处理任务，任何漏网的异步拒绝都不应该让整个进程崩掉
// （历史上 Node 22 undici 的中断 bug 就这样静默杀死过进程）
process.on('unhandledRejection', (e) => {
  log('unhandledRejection（已忽略）:', e && e.message ? e.message : e);
});

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
    // 统一走 node:http/https（避开 Node 22 undici 中断崩溃 bug）
    const r = await httpGet(url, {
      timeout: opts.timeout ?? 10000,
      headers: { 'User-Agent': opts.ua ?? UA, ...(opts.headers || {}) },
    });
    if (r.ok) return r;
    lastErr = r.error || new Error(`HTTP ${r.status}`);
    if (r.status === 404 || r.status === 400) {
      return { ok: false, status: r.status, body: r.body, error: lastErr };
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

// Trending 榜单数据（日/周/月）随 daily.json 一并下发，App 无需直连 github.io
const trendingLists = { daily: [], weekly: [], monthly: [], fetchedAt: null };
// 镜像顺序：jsDelivr（国内可达）→ GitHub Pages 直连
const TRENDING_PERIODS = ['daily', 'weekly', 'monthly'];
const TRENDING_MIRRORS = [
  (p) => `https://cdn.jsdelivr.net/gh/mshibanami/GitHubTrendingRSS@gh-pages/${p}/all.xml`,
  (p) => `https://mshibanami.github.io/GitHubTrendingRSS/${p}/all.xml`,
];

// RSS description 是转义后的整页 README，取第一个 <p> 作为仓库简介
function firstParagraphOf(html) {
  const decoded = decodeEntities(html || '');
  const m = decoded.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return stripHtml(m ? m[1] : decoded).replace(/\s+/g, ' ').trim();
}

function parseTrendingList(xml, cap) {
  const out = [];
  for (const e of parseFeed(xml)) {
    const name = (e.title || '').trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) continue;
    const [owner, repo] = name.split('/');
    const desc = firstParagraphOf(e.content).slice(0, 160);
    out.push({ rank: out.length + 1, owner, repo, desc,
      url: e.link || `https://github.com/${name}` });
    if (out.length >= cap) break;
  }
  return out;
}

async function fetchTrendingFeed(period) {
  let lastErr = '';
  for (const mirror of TRENDING_MIRRORS) {
    const u = mirror(period);
    const r = await fetchWithRetry(u, { timeout: 15000 }, 'trending');
    if (r.ok && /<rss|<feed/.test(r.body)) {
      const list = parseTrendingList(r.body, period === 'daily' ? 25 : 50);
      if (list.length) {
        if (period !== 'daily') trackSource(`trending:${period}`, true, u.includes('jsdelivr') ? 'jsdelivr' : 'github-io', list.length);
        return { list, mode: u.includes('jsdelivr') ? 'jsdelivr' : 'github-io' };
      }
    } else {
      lastErr = r.error?.message || '非 RSS 返回';
    }
  }
  if (period !== 'daily') trackSource(`trending:${period}`, false, 'jsdelivr+github-io', 0, lastErr || '全部不可用');
  return { list: [], mode: null, error: lastErr };
}

// 用 GitHub REST 补充榜单条目的语言/星数（Actions 内置 token，限流 1000 次/小时）
// 注意：用 fetchWithRetry 而非 getJson，避免限流时每条都记一条错误日志
async function enrichTrendingMeta(list) {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  let ok = 0;
  await mapLimit(list, 5, async (t) => {
    if (!t.owner || !t.repo) return;
    const r = await fetchWithRetry(`https://api.github.com/repos/${t.owner}/${t.repo}`,
      { headers, timeout: 10000 }, 'trending-meta');
    if (!r.ok) return;
    try {
      const d = JSON.parse(r.body);
      t.lang = d.language || '';
      t.stars = typeof d.stargazers_count === 'number' ? d.stargazers_count : 0;
      ok++;
    } catch { /* 忽略单条解析失败 */ }
  });
  return ok;
}

async function fetchTrending() {
  if (skipped('TRENDING')) return;
  const [d, w, m] = await Promise.all(TRENDING_PERIODS.map(fetchTrendingFeed));
  trendingLists.daily = d.list;
  trendingLists.weekly = w.list;
  trendingLists.monthly = m.list;
  trendingLists.fetchedAt = new Date().toISOString();

  // 补充语言/星数元信息（失败不影响榜单本身）
  if (!skipped('TRENDING_META')) {
    const uniq = new Map();
    for (const period of TRENDING_PERIODS) {
      for (const t of trendingLists[period]) {
        if (t.url && !uniq.has(t.url)) uniq.set(t.url, t);
      }
    }
    await enrichTrendingMeta([...uniq.values()]);
    const withMeta = TRENDING_PERIODS.reduce((n, p) => n + trendingLists[p].filter((t) => t.lang || t.stars).length, 0);
    trackSource('trending:meta', withMeta > 0, 'github-rest', withMeta);
  }

  let count = 0;
  for (const t of d.list.slice(0, 25)) {
    add({ category: 'ai', source: 'GitHub Trending', sourceType: 'rss',
      title: `${t.owner}/${t.repo}${t.desc ? '：' + t.desc : ''}`, url: t.url,
      date: new Date(), excerpt: t.desc,
      tags: ['GitHub', 'Trending', '开源'] });
    count++;
  }
  if (count > 0) {
    trackSource('trending', true, d.mode || 'community-rss', count);
  } else {
    // 降级：GitHub 搜索 API（REST 可用时）
    recordError('trending', 'rss', d.error || '日榜镜像均不可用');
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

/* ============================ 6.5 国外科技源（服务端抓取 + 镜像分发） ============================ */

// 国外源全部由 Actions 服务端抓取进入 daily.json，经 Gitee/jsDelivr 镜像分发，
// 国内用户不直连外网；正文抓取 + 标题/摘要预翻译保证 App 内可读。
const FOREIGN_TECH_FEEDS = [
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', tags: ['国外科技'] },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', tags: ['国外科技'] },
  { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed/', tags: ['国外科技', 'AI'] },
  // OpenAI 官网国内直连不了，但由 Actions 服务端抓取 + 镜像分发，App 内可读
  { name: 'OpenAI', url: 'https://openai.com/news/rss.xml/', tags: ['国外AI', 'OpenAI'], force: 'ai' },
];

async function fetchForeignTech() {
  if (skipped('FOREIGN')) return;
  for (const f of FOREIGN_TECH_FEEDS) {
    const r = await fetchWithRetry(f.url, { ua: BROWSER_UA, timeout: 12000 }, f.name);
    let count = 0;
    if (r.ok && /<rss|<feed|<rdf/i.test(r.body)) {
      for (const e of parseFeed(r.body).slice(0, 20)) {
        const isAi = f.force === 'ai' || AI_RE.test(e.title) || AI_RE.test(stripHtml(e.content));
        add({ category: isAi ? 'ai' : 'today', source: f.name, sourceType: 'rss',
          title: e.title, url: e.link, date: e.date, excerpt: e.content,
          tags: isAi ? [...f.tags, 'AI'] : [...f.tags] });
        count++;
      }
    } else {
      recordError(f.name, 'rss', r.error?.message || '非 RSS 返回');
    }
    trackSource(f.name, count > 0, 'rss', count);
    await sleep(200);
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

// 娱乐关键词：热搜/热榜条目命中后自动跨挂到「娱乐圈」
const ENT_RE = /明星|演员|歌手|导演|电影|电视剧|综艺|票房|演唱会|官宣|恋情|离婚|结婚|偶像|男团|女团|跑男|春晚|影帝|影后|热播|新剧|开机|杀青|女主|男主|主演|颁奖|红毯|塌房|粉丝|爱豆|出道|专辑|浪姐|披荆斩棘|剧集|网剧|番剧|动漫|游戏改编|网红|主播|直播|带货|选秀|脱口秀|相声|小品|模特|选美|男星|女星|艺人|剧组|片场|预告片|定档|杀青|票房|歌坛|乐坛|新歌|单曲|MV|演唱会|巡演|综艺节目/i;

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
    for (const it of list.slice(0, 30)) {
      const title = it.query || it.word;
      const isEnt = ENT_RE.test(title) || ENT_RE.test(it.desc || '');
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
    const bilibiliEntRe = /影视|娱乐|明星|音乐|舞蹈|综艺|动画|舞台|鬼畜|特摄|影视剧/;
    let count = 0;
    for (const x of d?.data?.list || []) {
      const tname = x.tname || '';
      if (!bilibiliEntRe.test(tname)) continue;
      add({ category: 'ent', source: 'B站热门', sourceType: 'json',
        title: x.title, url: x.short_link_v2 || x.short_link,
        date: new Date((x.pubdate || 0) * 1000),
        excerpt: `${tname} · UP主 ${x.owner?.name || '未知'}：${x.desc || ''}`,
        tags: ['B站', tname], hot: true });
      count++;
    }
    trackSource('B站热门', count > 0, 'json', count, count ? null : '热门榜无娱乐分区条目');
  }
  // 新增国内可达源（RSS，国内直连无墙）
  if (!skipped('OSCHINA')) {
    // 开源中国·资讯：AI 相关入 AI 圈，其余入今天
    const r = await fetchWithRetry('https://www.oschina.net/news/rss', { ua: BROWSER_UA, timeout: 12000 }, '开源中国');
    let count = 0;
    if (r.ok && /<rss|<feed|<rdf/i.test(r.body)) {
      for (const e of parseFeed(r.body).slice(0, 25)) {
        const isAi = AI_RE.test(e.title) || AI_RE.test(stripHtml(e.content));
        add({ category: isAi ? 'ai' : 'today', source: '开源中国', sourceType: 'rss',
          title: e.title, url: e.link, date: e.date, excerpt: e.content,
          tags: isAi ? ['开发社区', '开源', 'AI'] : ['开发社区', '开源'] });
        count++;
      }
    } else {
      recordError('开源中国', 'rss', r.error?.message || '非 RSS 返回');
    }
    trackSource('开源中国', count > 0, 'rss', count);
  }
  if (!skipped('GEEKPARK')) {
    // 极客公园：AI 相关入 AI 圈，其余入今天
    const r = await fetchWithRetry('https://www.geekpark.net/rss', { ua: BROWSER_UA, timeout: 12000 }, '极客公园');
    let count = 0;
    if (r.ok && /<rss|<feed|<rdf/i.test(r.body)) {
      for (const e of parseFeed(r.body).slice(0, 20)) {
        const isAi = AI_RE.test(e.title) || AI_RE.test(stripHtml(e.content));
        add({ category: isAi ? 'ai' : 'today', source: '极客公园', sourceType: 'rss',
          title: e.title, url: e.link, date: e.date, excerpt: e.content,
          tags: isAi ? ['科技', 'AI'] : ['科技'] });
        count++;
      }
    } else {
      recordError('极客公园', 'rss', r.error?.message || '非 RSS 返回');
    }
    trackSource('极客公园', count > 0, 'rss', count);
  }
  if (!skipped('LEIPHONE')) {
    await rssSource('雷锋网', 'https://www.leiphone.com/feed', 'ai', ['AI', '科技'], 15);
  }
  if (!skipped('V2EX')) {
    // V2EX 深度/技术节点：AI 相关入 AI 圈
    const r = await fetchWithRetry('https://www.v2ex.com/index.xml', { ua: BROWSER_UA, timeout: 12000 }, 'V2EX');
    let count = 0;
    if (r.ok && /<rss|<feed|<rdf/i.test(r.body)) {
      for (const e of parseFeed(r.body).slice(0, 25)) {
        const isAi = AI_RE.test(e.title) || AI_RE.test(stripHtml(e.content));
        add({ category: isAi ? 'ai' : 'today', source: 'V2EX', sourceType: 'rss',
          title: e.title, url: e.link, date: e.date, excerpt: e.content,
          tags: isAi ? ['开发者社区', 'AI'] : ['开发者社区'] });
        count++;
      }
    } else {
      recordError('V2EX', 'rss', r.error?.message || '非 RSS 返回');
    }
    trackSource('V2EX', count > 0, 'rss', count);
  }
  if (!skipped('LINUXDO')) {
    await rssSource('Linux.do', 'https://linux.do/latest.rss', 'ai', ['社区', '技术'], 15);
  }

  /* ---- 国内三大热搜：微博 / 今日头条 / 抖音（公开 JSON，免登录免签名，已实测） ---- */
  if (!skipped('WEIBO')) {
    const d = await getJson('https://weibo.com/ajax/side/hotSearch',
      { ua: BROWSER_UA, headers: { Referer: 'https://weibo.com/' }, timeout: 12000 }, '微博热搜');
    let count = 0;
    for (const h of parseWeiboHot(d).slice(0, 30)) {
      add({ category: 'today', source: '微博热搜', sourceType: 'json',
        title: h.title, url: h.url, date: null,
        excerpt: h.hot ? `微博热度 ${h.hot}` : '',
        tags: ['热搜', '微博'], hot: true,
        extraCategories: ENT_RE.test(h.title) ? ['ent'] : [] });
      count++;
    }
    trackSource('微博热搜', count > 0, 'json', count);
  }
  if (!skipped('TOUTIAO')) {
    const d = await getJson('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc',
      { ua: BROWSER_UA, timeout: 12000 }, '今日头条');
    let count = 0;
    for (const h of parseToutiaoHot(d).slice(0, 30)) {
      add({ category: 'today', source: '今日头条', sourceType: 'json',
        title: h.title, url: h.url, date: null,
        excerpt: h.hot ? `头条热度 ${h.hot}` : '',
        tags: ['热搜', '头条'], hot: true,
        extraCategories: ENT_RE.test(h.title) ? ['ent'] : [] });
      count++;
    }
    trackSource('今日头条', count > 0, 'json', count);
  }
  if (!skipped('DOUYIN')) {
    const d = await getJson('https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1',
      { ua: BROWSER_UA, headers: { Referer: 'https://www.douyin.com/' }, timeout: 12000 }, '抖音热点');
    let count = 0;
    for (const h of parseDouyinHot(d).slice(0, 30)) {
      add({ category: 'today', source: '抖音热点', sourceType: 'json',
        title: h.title, url: h.url, date: null,
        excerpt: h.hot ? `抖音热度 ${h.hot}` : '',
        tags: ['热搜', '抖音'], hot: true,
        extraCategories: ENT_RE.test(h.title) ? ['ent'] : [] });
      count++;
    }
    trackSource('抖音热点', count > 0, 'json', count);
  }
}

/* ============================ 后处理：翻译 / 正文 / 聚类 ============================ */

// 1. 英文标题/摘要预翻译（服务端 nightly，写入 titleZh/summaryZh）
async function preTranslate(list) {
  if (skipped('TRANSLATE')) {
    trackSource('translate', false, 'skipped', 0, 'SKIP_TRANSLATE=1，跳过预翻译');
    return;
  }
  const maxPerRun = Number(process.env.TRANSLATE_MAX || 200);
  // deadlineMs：翻译阶段总时限，超时放弃剩余条目（保留原文），保证 Actions 15 分钟内完成
  const translator = createTranslator({ maxPerRun, deadlineMs: 180000 });
  const zhTitles = await translator.translateAll(list.map((it) => it.title));
  let nTitle = 0;
  for (let i = 0; i < list.length; i++) {
    if (zhTitles[i] && zhTitles[i] !== list[i].title) {
      list[i].titleZh = zhTitles[i];
      nTitle++;
    }
  }
  // 摘要仅翻译英文条目（标题已中文化的）
  const sumIdx = [];
  const sumTexts = [];
  list.forEach((it, i) => {
    if (it.titleZh && isEnglish(it.summary)) {
      sumIdx.push(i);
      sumTexts.push((it.summary || '').slice(0, 300));
    }
  });
  const zhSums = sumTexts.length ? await translator.translateAll(sumTexts) : [];
  let nSum = 0;
  sumIdx.forEach((idx, j) => {
    if (zhSums[j]) { list[idx].summaryZh = zhSums[j]; nSum++; }
  });
  trackSource('translate', true, 'google+mymemory', nTitle,
    `标题 ${nTitle}/${list.length}，摘要 ${nSum}/${sumIdx.length}（ok=${translator.stats.ok} fail=${translator.stats.fail} skip=${translator.stats.skipped}）`);
  log(`预翻译完成：标题 ${nTitle} 条，摘要 ${nSum} 条`);
}

// 2. 原文正文抓取（readability-lite 抽取，App 内读全文）
async function enrichAllContent(list) {
  if (skipped('CONTENT')) {
    trackSource('content', false, 'skipped', 0, 'SKIP_CONTENT=1，跳过正文抓取');
    return;
  }
  // 每板块取最新 N 条（当日热点优先），总量再兜底；控制 Actions 耗时
  const perCategory = Number(process.env.CONTENT_PER_CATEGORY || 30);
  const limit = Number(process.env.CONTENT_LIMIT || 100);
  const fails = [];
  const r = await enrichContent(list, {
    limit, perCategory, categories: ['today', 'ai', 'ent'], concurrency: 4,
  }, (src) => fails.push(src));
  if (fails.length) {
    recordError('content', 'extract', fails.length + ' 条正文抓取失败（App 内显示摘要）');
  }
  const byCat = Object.entries(r.byCategory || {})
    .map(([k, v]) => `${k} ${v.ok}/${v.tried}`).join('，');
  trackSource('content', r.ok > 0, 'readability', r.ok, r.ok ? null : '全部失败，App 内仅显示摘要');
  log(`正文抓取完成：${r.ok}/${r.total} 条（每板块 ${perCategory} 条；${byCat}）`);
}

// 3. 事件聚类（多源报道 → storyId）
function buildStories(list) {
  const storyMap = assignStories(list);
  let multi = 0;
  for (const ids of storyMap.values()) if (ids.length >= 2) multi++;
  trackSource('story', true, 'cluster', multi, `共 ${storyMap.size} 个事件组，其中 ${multi} 组含多源报道`);
  log(`事件聚类完成：${storyMap.size} 组，${multi} 组多源报道`);
  return { multi };
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
    fetchForeignTech(),
    fetchChineseSupplements(),
  ]);

  const deduped = dedup(items);
  // 排序：时间倒序；hot 条目以抓取时间参与
  deduped.sort((a, b) => b.publishedAtMs - a.publishedAtMs);
  // 每个分类按主分类保留上限（extraCategories 跨分类展示不计数截断）
  // 热搜源（微博/头条/抖音）无时间戳、进入「实时热点」分组，故今天配额相应放大
  const CAPS = { today: 160, ai: 120, ent: 80 };
  const used = { today: 0, ai: 0, ent: 0 };
  const final = [];
  for (const it of deduped) {
    if (used[it.category] >= CAPS[it.category]) continue;
    used[it.category]++;
    final.push(it);
  }

  // 后处理：预翻译 → 正文抓取 → 事件聚类
  await preTranslate(final);
  await enrichAllContent(final);
  const storyInfo = buildStories(final);

  const counts = { today: 0, ai: 0, ent: 0 };
  for (const it of final) {
    counts[it.category]++;
    for (const c of it.extraCategories || []) counts[c] = (counts[c] || 0) + 1;
  }

  const bySource = {};
  for (const it of final) bySource[it.source] = (bySource[it.source] || 0) + 1;

  const payload = {
    version: 2,
    generatedAt: new Date().toISOString(),
    generatedAtBeijing: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    window: '主展示近24小时，归档保留近7天；热榜数据无精确时间戳',
    stats: { total: final.length, byCategory: counts, bySource, stories: storyInfo.multi },
    sourceStatus,
    errors,
    items: final,
    trending: trendingLists,
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
