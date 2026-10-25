/**
 * 事件聚类（零依赖）
 * ---------------------------------------------------------------
 * 把「同一事件的多源报道」归为一个 story，前端合并为一张卡片并显示「N 家报道」。
 * 与去重（dedup）的区别：dedup 判定「同一内容」直接丢弃；聚类保留全部来源。
 *
 * 规则（同时满足才归入同一 story）：
 *   1. 主分类相同
 *   2. 发布时间相差 ≤ 72 小时
 *   3. 标题相似度（包含度 = 交集/较小集合）≥ 0.5，且共享关键 bigram 数达标（中文 ≥4 / 英文 ≥2）
 *
 * storyId 取组内最小 item id，保证每次运行结果稳定。
 */

const WINDOW_MS = 72 * 3600 * 1000;
const CONTAIN_MIN = 0.5;
const CONTAIN_MIN_EN = 0.6; // 英文标题阈值更高，防止常用词造成误合并
const MAX_STORY = 12;

// 英文停用词：不参与相似度计算，避免 "the open source" 之类通用搭配造成误合并
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'at',
  'as', 'from', 'but', 'not', 'have', 'has', 'had', 'will', 'can', 'could',
  'new', 'now', 'via', 'over', 'into', 'about', 'after', 'says', 'said',
]);

function cjkBigrams(t) {
  const cs = (t || '').toLowerCase().match(/[\u4e00-\u9fff]/g) || [];
  const set = new Set();
  const s = cs.join('');
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function wordTokens(t) {
  return ((t || '').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

function wordBigrams(t) {
  const w = wordTokens(t);
  const set = new Set();
  for (let i = 0; i < w.length - 1; i++) set.add(w[i] + ' ' + w[i + 1]);
  for (const x of w) set.add('w:' + x);
  return set;
}

function grams(t) {
  return new Set([...cjkBigrams(t), ...wordBigrams(t)]);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 包含度：交集 / 较小集合大小。
 * 比 jaccard 更适合「一条短标题、一条长标题」的同一事件
 * （如中文短标题 vs 翻译后的长英文标题），避免被额外词元稀释。
 */
function containment(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

/**
 * 共享关键 bigram 是否达标：
 *   中文标题：共享 CJK bigram ≥ min(4, 较短标题的 bigram 数)（短标题如
 *            「OpenAI 发布 GPT-5 模型」总共只有 3 个 CJK bigram）
 *   英文标题：共享词 bigram（不含单词 unigram）≥ 3
 */
function sharedEnough(aTitle, bTitle, ga, gb) {
  const ca = cjkBigrams(aTitle);
  const cb = cjkBigrams(bTitle);
  if (ca.size && cb.size) {
    let cjkShared = 0;
    for (const x of ca) if (cb.has(x)) cjkShared++;
    return cjkShared >= Math.min(3, Math.min(ca.size, cb.size));
  }

  let wbShared = 0;
  for (const x of ga) {
    if (x.startsWith('w:')) continue;
    if (gb.has(x)) wbShared++;
  }
  return wbShared >= 2;
}

/**
 * 为 items 标注 storyId（原地修改，返回同一数组）
 * 优先用 titleZh（预翻译后的中文标题）参与相似度计算，
 * 使「英文原文」与「中文报道」的同一事件也能归入一个 story。
 * @param {Array<{id:string,category:string,publishedAtMs:number,title:string,titleZh?:string}>} items 已去重、按时间倒序
 * @returns {Map<string, string[]>} storyId -> item ids
 */
export function assignStories(items) {
  const titleOf = (it) => it.titleZh || it.title || '';
  const groups = []; // [{g:Set, items:[idx], lastMs, category}]
  const storyOf = new Map();

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let placed = null;
    for (const grp of groups) {
      if (grp.category !== it.category) continue;
      if (grp.items.length >= MAX_STORY) continue;
      // 组内代表条目（最早加入的）与当前条目比较
      const rep = items[grp.items[0]];
      if (Math.abs((rep.publishedAtMs || 0) - (it.publishedAtMs || 0)) > WINDOW_MS) continue;
      const gi = grams(titleOf(it));
      const ti = titleOf(it);
      const tr = titleOf(rep);
      const hasCjk = cjkBigrams(ti).size > 0 && cjkBigrams(tr).size > 0;
      const need = hasCjk ? CONTAIN_MIN : CONTAIN_MIN_EN;
      if (containment(gi, grp.g) >= need && sharedEnough(ti, tr, gi, grp.g)) {
        placed = grp;
        break;
      }
    }
    if (placed) {
      placed.items.push(i);
    } else {
      groups.push({ g: grams(titleOf(it)), items: [i], category: it.category });
      placed = groups[groups.length - 1];
    }
    const grp = placed;
    // storyId = 组内最小 item id
    const ids = grp.items.map((x) => items[x].id).sort();
    const sid = 's' + ids[0].replace(/^n/, '');
    for (const x of grp.items) {
      storyOf.set(items[x].id, sid);
      items[x].storyId = sid;
    }
  }

  const out = new Map();
  for (const it of items) {
    if (!it.storyId) continue;
    if (!out.has(it.storyId)) out.set(it.storyId, []);
    out.get(it.storyId).push(it.id);
  }
  return out;
}

export { grams, jaccard };
