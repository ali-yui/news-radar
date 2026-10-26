/* ============ 资讯雷达 · 智能排序内核 ============
 * 纯函数、零依赖、浏览器与 Node 双端可用（window.Ranking / module.exports）。
 *
 * 排序 = 多维融合打分 + 同源打散：
 *   1. 新鲜度：以 HALF_LIFE_H 为半衰期指数衰减
 *   2. 热度：hotScore 数值（脚本侧写入）→ 摘要正则解析（旧数据兼容）→ hot 布尔兜底
 *   3. 来源权重：原创媒体/技术社区 > 聚合热榜（热榜靠热度分竞争）
 *   4. 多源报道加成：同一事件报道源越多，越可能是大事
 *   5. 正文加成：有正文才能在 App 内阅读
 *   6. 已读降权：读过的往下滑，但不隐藏
 * 打分后做同源打散（滑动窗口内同源不超过 N 条），避免一个源连刷 20 条。
 */
(function (global) {
  'use strict';

  const CFG = {
    HALF_LIFE_H: 20,     // 新鲜度半衰期（小时）
    MAX_AGE_H: 24 * 10,  // 超过此年龄新鲜度按 0 计
    W: { fresh: 1.0, hot: 0.9, src: 0.35, multi: 0.3, body: 0.12, read: 0.45 },
    WINDOW: 6,           // 打散滑动窗口大小
    SAME_SRC_MAX: 2,     // 窗口内同一来源最多出现条数
    HOT_FALLBACK: 0.55,  // hot=true 但无数值时的热度分
  };

  // 摘要中的热度值（脚本侧老数据把热度写进了文本，如「微博热度 1234567」）
  const HOT_RE = /(?:微博热度|头条热度|抖音热度|百度热度|热度)\s*([\d,]{3,})/;

  // 来源权重：聚合热榜给中权重（靠热度分竞争），原创/技术源给高权重
  const SRC_RULES = [
    { re: /^(Hacker News|GitHub|GitHub Trending|The Verge|Ars Technica|MIT Technology Review)/, w: 1 },
    { re: /^(中新网|36氪|量子位|InfoQ|极客公园|雷锋网|开源中国|Solidot|SegmentFault|少数派)/, w: 0.95 },
    { re: /^(IT之家|B站热门|知乎日报)/, w: 0.85 },
    { re: /^(微博热搜|今日头条|抖音热点|百度热搜|百度电影榜|百度电视剧榜)/, w: 0.72 },
  ];
  const SRC_DEFAULT = 0.85;

  function sourceWeight(source, sourceType) {
    const s = String(source || '');
    for (const r of SRC_RULES) if (r.re.test(s)) return r.w;
    if (sourceType === 'github' || sourceType === 'hn') return 1;
    if (sourceType === 'reddit') return 0.8;
    return SRC_DEFAULT;
  }

  /** 从摘要文本解析热度数值（旧数据兼容路径） */
  function parseHotFromText(text) {
    const m = String(text || '').match(HOT_RE);
    if (!m) return 0;
    const n = Number(String(m[1]).replace(/,/g, ''));
    return isFinite(n) ? n : 0;
  }

  /** 热度值 → 0~1（对数归一化，兼容百万/千万级不同量纲） */
  function normalizeHot(v) {
    if (!v || v <= 0) return 0;
    const n = Math.log10(v);
    return Math.max(0, Math.min(1, (n - 3) / 5)); // 1e3 → 0，1e8 → 1
  }

  function hotScoreOf(it) {
    if (typeof it.hotScore === 'number' && it.hotScore > 0) return it.hotScore;
    const parsed = parseHotFromText(it.summary) || parseHotFromText(it.summaryZh);
    if (parsed) return parsed;
    return it.hot ? -1 : 0; // -1 表示「热榜但无数值」，走兜底分
  }

  /**
   * 单条打分
   * @param {object} it
   * @param {{now:number, storyCount?:Map|Object, read?:Object}} ctx
   * @returns {{score:number, fresh:number, hot:number}}
   */
  function scoreItem(it, ctx) {
    const now = ctx && ctx.now ? ctx.now : Date.now();
    const ageH = Math.max(0, (now - (it.publishedAtMs || 0)) / 3600000);
    const fresh = ageH >= CFG.MAX_AGE_H ? 0 : Math.pow(0.5, ageH / CFG.HALF_LIFE_H);

    const raw = hotScoreOf(it);
    const hot = raw === -1 ? CFG.HOT_FALLBACK : normalizeHot(raw);

    const src = sourceWeight(it.source, it.sourceType);

    let multi = 0;
    if (it.storyId && ctx && ctx.storyCount) {
      const n = ctx.storyCount instanceof Map
        ? (ctx.storyCount.get(it.storyId) || 0)
        : (ctx.storyCount[it.storyId] || 0);
      if (n >= 2) multi = Math.min(1, Math.log2(n) / 2);
    }

    const body = it.content ? 1 : 0;
    const isRead = ctx && ctx.read && ctx.read[it.id] ? 1 : 0;

    const W = CFG.W;
    const score = W.fresh * fresh + W.hot * hot + W.src * src
      + W.multi * multi + W.body * body - W.read * isRead;
    return { score, fresh, hot };
  }

  /** 按发布时间倒序（「最新」排序） */
  function sortByTime(items) {
    return items.slice().sort((a, b) => (b.publishedAtMs || 0) - (a.publishedAtMs || 0));
  }

  /**
   * 同源打散：按分降序后贪心重排，滑动窗口内同一 source 不超过 SAME_SRC_MAX 条。
   * 被限制的条目顺延到后续轮次，真的排不下时按原序追加，保证不丢条目。
   */
  function diversify(sorted, cfg) {
    const C = cfg || CFG;
    const winSize = Math.max(1, C.WINDOW);
    const maxSame = Math.max(1, C.SAME_SRC_MAX);
    const out = [];
    const counts = new Map();
    const win = [];
    let rest = sorted.slice();

    while (rest.length) {
      const left = [];
      let placed = 0;
      for (const it of rest) {
        const key = String(it.source || '');
        if ((counts.get(key) || 0) >= maxSame) { left.push(it); continue; }
        out.push(it);
        win.push(key);
        counts.set(key, (counts.get(key) || 0) + 1);
        placed++;
        if (win.length > winSize) {
          const old = win.shift();
          const c = (counts.get(old) || 1) - 1;
          if (c > 0) counts.set(old, c); else counts.delete(old);
        }
      }
      if (!placed) { out.push.apply(out, left); break; }
      rest = left;
    }
    return out;
  }

  /**
   * 智能排序主入口
   * @param {Array} items
   * @param {{now:number, storyCount?:Map, read?:Object}} ctx
   * @param {object} [cfg]
   * @returns {Array} 新数组，不修改入参
   */
  function rank(items, ctx, cfg) {
    if (!items || !items.length) return [];
    const C = cfg || CFG;
    const scored = items.map((it) => ({ it, s: scoreItem(it, ctx) }));
    scored.sort((a, b) => (b.s.score - a.s.score)
      || ((b.it.publishedAtMs || 0) - (a.it.publishedAtMs || 0)));
    return diversify(scored.map((x) => x.it), C);
  }

  const API = {
    CFG, scoreItem, rank, sortByTime, diversify,
    sourceWeight, parseHotFromText, normalizeHot, hotScoreOf,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.Ranking = API;
})(typeof window !== 'undefined' ? window : globalThis);
