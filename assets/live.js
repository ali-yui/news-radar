/*
 * 浏览器端手动刷新（仅覆盖支持跨域的源：GitHub REST、Hacker News、Reddit）
 * RSS 源（Google News / Bing / 各中文 RSS）受浏览器同源策略限制，
 * 以 GitHub Actions 产出的 public/data/daily.json 为准。
 */
window.LiveFetcher = (function () {
  const DAY = 86400000;
  const KEEP = 7 * DAY;

  async function get(url, opts = {}, timeout = 9000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, ...opts });
      const body = await resp.text();
      return { ok: resp.ok, status: resp.status, body };
    } catch (e) {
      return { ok: false, status: 0, body: '', error: e };
    } finally {
      clearTimeout(timer);
    }
  }

  function hashId(title, url) {
    const s = (url || '') + '|' + (title || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return 'n' + (h >>> 0).toString(16).padStart(8, '0');
  }

  function push(arr, it) {
    const title = (it.title || '').trim();
    if (title.length < 4) return;
    let ms = it.date ? new Date(it.date).getTime() : Date.now();
    if (isNaN(ms)) ms = Date.now();
    if (ms < Date.now() - KEEP) return;
    arr.push({
      id: hashId(title, it.url),
      category: it.category,
      source: it.source,
      sourceType: it.sourceType,
      title,
      url: it.url || '',
      publishedAt: new Date(ms).toISOString(),
      publishedAtMs: ms,
      summary: it.summary || (title + '（来源：' + it.source + '）'),
      tags: it.tags || [],
      hot: false,
    });
  }

  async function github(token, items, errors) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    };
    const REPO = 'morluto/rea';
    try {
      const [rel, com, iss, repos] = await Promise.all([
        get(`https://api.github.com/repos/${REPO}/releases?per_page=10`, { headers }),
        get(`https://api.github.com/repos/${REPO}/commits?per_page=20`, { headers }),
        get(`https://api.github.com/repos/${REPO}/issues?state=all&per_page=20`, { headers }),
        get('https://api.github.com/users/morluto/repos?per_page=100&sort=pushed', { headers }),
      ]);
      if (!rel.ok) throw new Error('GitHub API 不可用（HTTP ' + rel.status + '，可能是未认证限流，可在设置填 Token）');
      for (const r of JSON.parse(rel.body)) {
        push(items, { category: 'ai', source: 'GitHub · ' + REPO, sourceType: 'github',
          title: '发布 ' + (r.name || r.tag_name), url: r.html_url, date: r.published_at || r.created_at,
          summary: (r.body || '').replace(/[#*>`\[\]]/g, ' ').slice(0, 160), tags: ['GitHub', 'Release', 'rea'] });
      }
      for (const c of JSON.parse(com.body || '[]')) {
        push(items, { category: 'ai', source: 'GitHub · ' + REPO, sourceType: 'github',
          title: c.commit?.message?.split('\n')[0], url: c.html_url,
          date: c.commit?.committer?.date || c.commit?.author?.date,
          summary: (c.commit?.message || '').slice(0, 160), tags: ['GitHub', 'Commit', 'rea'] });
      }
      for (const i of JSON.parse(iss.body || '[]')) {
        if (i.pull_request) continue;
        push(items, { category: 'ai', source: 'GitHub · ' + REPO, sourceType: 'github',
          title: i.title, url: i.html_url, date: i.updated_at || i.created_at,
          summary: (i.body || '').split('### Before submitting')[0].replace(/[#*>`\[\]]/g, ' ').slice(0, 160),
          tags: ['GitHub', 'Issue', 'rea'] });
      }
      if (repos.ok) {
        const related = JSON.parse(repos.body)
          .filter((x) => x.name === 'rea' || x.name.startsWith('rea-'))
          .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
          .slice(0, 6);
        await Promise.all(related.map(async (rp) => {
          const r = await get(`https://api.github.com/repos/${rp.full_name}/commits?per_page=3`, { headers });
          if (!r.ok) return;
          for (const c of JSON.parse(r.body || '[]')) {
            push(items, { category: 'ai', source: 'GitHub · ' + rp.full_name, sourceType: 'github',
              title: c.commit?.message?.split('\n')[0], url: c.html_url,
              date: c.commit?.committer?.date || c.commit?.author?.date,
              summary: (c.commit?.message || '').slice(0, 160), tags: ['GitHub', 'rea-agents', rp.name] });
          }
        }));
      }
    } catch (e) {
      errors.push({ source: 'github', stage: 'live', message: String(e.message || e) });
    }
  }

  async function hn(items, errors) {
    const queries = ['REA', 'reverse engineering', 'AI agent', 'MCP', 'Ghidra', 'JADX'];
    const since = Math.floor((Date.now() - KEEP) / 1000);
    try {
      await Promise.all(queries.map(async (q) => {
        const r = await get(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}`
          + `&tags=story&hitsPerPage=20&numericFilters=created_at_i>${since}`);
        if (!r.ok) throw new Error('HN HTTP ' + r.status);
        for (const h of JSON.parse(r.body).hits || []) {
          push(items, { category: 'ai', source: 'Hacker News', sourceType: 'hn',
            title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
            date: h.created_at, summary: (h.story_text || '').slice(0, 160),
            tags: ['Hacker News', q] });
        }
      }));
    } catch (e) {
      errors.push({ source: 'hn', stage: 'live', message: String(e.message || e) });
    }
  }

  const SUBS = {
    ai: ['ReverseEngineering', 'netsec', 'LocalLLaMA', 'MachineLearning', 'artificial', 'singularity'],
    ent: ['entertainment', 'movies', 'television', 'Fauxmoi'],
  };

  async function reddit(items, errors) {
    const jobs = Object.entries(SUBS).flatMap(([cat, subs]) => subs.map((s) => [cat, s]));
    let failed = 0;
    await Promise.all(jobs.map(async ([cat, sub]) => {
      const r = await get(`https://www.reddit.com/r/${sub}/new.json?limit=20`);
      if (!r.ok) { failed++; return; }
      let data;
      try { data = JSON.parse(r.body); } catch { failed++; return; }
      for (const c of data?.data?.children || []) {
        const d = c.data || {};
        if (d.stickied) continue;
        const self = d.is_self || !d.url || d.url.includes('/r/' + sub);
        push(items, { category: cat, source: 'Reddit · r/' + sub, sourceType: 'reddit',
          title: d.title, url: self ? 'https://www.reddit.com' + d.permalink : d.url,
          date: new Date((d.created_utc || 0) * 1000), summary: (d.selftext || '').slice(0, 160),
          tags: ['Reddit', 'r/' + sub] });
      }
    }));
    if (failed) errors.push({ source: 'reddit', stage: 'live',
      message: failed + ' 个板块请求失败（可能被跨域或限流）' });
  }

  /**
   * 浏览器端实时抓取（GitHub REST + HN Algolia + Reddit JSON）
   * 注意：函数名不能叫 fetch，否则会遮蔽全局 fetch 造成递归
   * @returns {{items:Array, errors:Array, sourceStatus:Array}}
   */
  async function runLive(settings) {
    const items = [];
    const errors = [];
    await Promise.all([
      github(settings?.ghToken || '', items, errors),
      hn(items, errors),
      reddit(items, errors),
    ]);
    return { items: window.Dedup.dedup(items), errors, sourceStatus: [] };
  }

  return { fetch: runLive };
})();
