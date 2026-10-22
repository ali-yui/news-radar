#!/usr/bin/env node
/**
 * 零依赖自测（不发起网络请求）
 *   node scripts/selftest.mjs
 * 覆盖：translate Provider 解析、extract 正文抽取、cluster 事件聚类、
 *       hotsearch 三大热搜解析、dedup / normalizeUrl（与浏览器端同规则）。
 */
import { PROVIDERS, isChinese, isEnglish } from './lib/translate.mjs';
import { extractContent, extractTitle, extractMetaDescription } from './lib/extract.mjs';
import { assignStories } from './lib/cluster.mjs';
import { parseWeiboHot, parseToutiaoHot, parseDouyinHot } from './lib/hotsearch.mjs';
import { pickContentTargets } from './lib/content.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log(' FAIL ' + name); }
}

/* ---------- 1. 翻译 Provider 解析 ---------- */
console.log('[translate] provider 解析');
const googleBody = JSON.stringify([[
  ['苹果发布 M5 芯片', 'Apple announces the M5 chip', null, null, 0],
  ['，性能更强', null, null, null, 1],
], null, 'en', null, null, null, null, []]);
const mymemoryBody = JSON.stringify({ responseData: { translatedText: '苹果发布 M5 芯片' }, responseStatus: 200 });
check('google 解析分段拼接', PROVIDERS[0].parse(googleBody) === '苹果发布 M5 芯片，性能更强');
check('mymemory 解析', PROVIDERS[1].parse(mymemoryBody) === '苹果发布 M5 芯片');
check('mymemory 失败体返回 null', PROVIDERS[1].parse(JSON.stringify({ responseStatus: 403 })) === null);
check('isEnglish 英文', isEnglish('OpenAI releases GPT-5 model today') === true);
check('isEnglish 中文为 false', isEnglish('OpenAI 发布 GPT-5 模型') === false);
check('isChinese 中文', isChinese('苹果发布 M5 芯片') === true);
check('isChinese 英文为 false', isChinese('Apple announces M5 chip') === false);

/* ---------- 2. 正文抽取 ---------- */
console.log('[extract] 正文抽取');
const html = `<!DOCTYPE html><html><head><title>测试文章标题</title>
<meta name="description" content="这是页面描述"></head><body>
<nav>首页 | 新闻 | 关于我们</nav>
<article><h1>测试文章标题</h1>
<p>第一段：苹果公司今日正式发布 M5 芯片，采用第二代 3 纳米工艺，CPU 性能提升百分之二十五。</p>
<p>第二段：M5 的神经网络引擎相比上代提速一倍，可更好地支持端侧 AI 模型推理任务。</p>
<p>第三段：新款芯片将首先搭载于下一代 MacBook Pro 与 iPad Pro 产品线之中。</p>
<div class="share">分享到：微博 微信 QQ</div>
</article>
<footer>版权所有 © 2026 测试网站 联系我们</footer>
<script>var x = 1;</script></body></html>`;
const r = extractContent(html);
check('标题提取', extractTitle(html) === '测试文章标题');
check('meta 描述提取', extractMetaDescription(html) === '这是页面描述');
check('正文含三段核心内容', r.paragraphs.length === 3);
check('正文过滤分享噪声', !r.text.includes('分享到'));
check('正文过滤页脚版权', !r.text.includes('版权所有'));
check('正文来源为容器', r.source === 'container');
const empty = extractContent('<html><head><meta name="description" content="兜底描述内容"></head><body><p>太短</p></body></html>');
check('无正文时回退 meta', empty.source === 'meta' && empty.text === '兜底描述内容');

/* ---------- 3. 事件聚类 ---------- */
console.log('[cluster] 事件聚类');
const now = Date.now();
const mk = (id, title, cat, src, titleZh) =>
  ({ id, category: cat, publishedAtMs: now - 3600000, title, source: src, titleZh });
const items = [
  mk('n1', 'OpenAI 发布 GPT-5 模型', 'ai', '量子位'),
  mk('n2', 'OpenAI 发布 GPT-5 模型，性能大幅提升', 'ai', '36氪'),
  mk('n3', '苹果发布 M5 芯片', 'today', 'IT之家'),
  mk('n4', '苹果发布 M5 芯片，性能更强', 'today', '少数派'),
  mk('n5', 'Apple announces the M5 chip with faster neural engine', 'today', 'The Verge', '苹果发布 M5 芯片，神经网络引擎更快'),
  mk('n6', '某电影票房突破 10 亿', 'ent', '百度电影榜'),
  mk('n7', '完全无关的科技新闻标题内容', 'ai', 'InfoQ'),
];
const map = assignStories(items);
check('同事件中文报道合并', items[0].storyId === items[1].storyId);
check('同事件不同源合并（今天）', items[2].storyId === items[3].storyId);
check('预翻译英文标题可并入中文 story', items[4].storyId === items[2].storyId);
check('不同事件不合并', items[5].storyId !== items[2].storyId);
check('不相关条目独立成组', items[6].storyId === 's' + items[6].id.slice(1));
const multi = [...map.values()].filter((v) => v.length >= 2).length;
check('多源报道组计数 = 2', multi === 2);

// 英文标题：无关标题不得因通用词误合并
const enItems = [
  mk('e1', 'TauricResearch/TradingAgents: A multi-agent trading research platform', 'ai', 'GitHub Trending'),
  mk('e2', 'paperclipai/paperclip: The open-source app for running AI agents', 'ai', 'GitHub Trending'),
  mk('e3', 'semantica-agi/semantica: Graph-Native Infrastructure for Context and Accountable AI Systems', 'ai', 'GitHub Trending'),
];
assignStories(enItems);
check('英文无关标题不合并', enItems[0].storyId !== enItems[1].storyId
  && enItems[1].storyId !== enItems[2].storyId
  && enItems[0].storyId !== enItems[2].storyId);

// 英文同事件（均有预翻译）应合并
const en2 = [
  mk('f1', 'Apple announces the M5 chip with a faster neural engine', 'today', 'The Verge',
    '苹果发布 M5 芯片，神经网络引擎更快'),
  mk('f2', 'Apple M5 chip launch: faster neural engine detailed', 'today', 'Ars Technica',
    '苹果 M5 芯片发布：更快的神经网络引擎详解'),
];
assignStories(en2);
check('英文同事件（均有译文）合并', en2[0].storyId === en2[1].storyId);

/* ---------- 4. 三大热搜解析（微博 / 头条 / 抖音） ---------- */
console.log('[hotsearch] 三大热搜解析');
const w = parseWeiboHot({ data: { realtime: [
  { word_scheme: '#测试热搜话题#', num: 1234567 },
  { word_scheme: '#短#', num: 10 },
  { word_scheme: '#某明星官宣恋情#', num: 888 },
] } });
check('微博：去井号且过滤过短', w.length === 2 && w[0].title === '测试热搜话题');
check('微博：链接指向话题搜索页', w[0].url.startsWith('https://s.weibo.com/weibo?q=%23'));
check('微博：热度值解析', w[0].hot === 1234567);

const t = parseToutiaoHot({ data: [
  { Title: '测试头条新闻标题', Url: 'https://www.toutiao.com/article/123/', HotValue: 987654 },
  { Title: '完全没有链接的条目', HotValue: 100 },
  { Title: '只有 ClusterId 的条目', ClusterId: '7698609753362026022' },
] });
check('头条：标题与热度解析', t.length === 2 && t[0].title === '测试头条新闻标题' && t[0].hot === 987654);
check('头条：缺 Url 时用 trending 兜底', t[1].url.includes('toutiao.com/trending/'));

const dy = parseDouyinHot({ data: { word_list: [
  { word: '抖音热点词条', hot_value: 12001581, sentence_id: '2704161' },
  { word: '无 sentence_id 的词条', hot_value: 5 },
  { word: 'ab' },
] } });
check('抖音：带 sentence_id 走 hot 链接',
  dy.length === 2 && dy[0].url === 'https://www.douyin.com/hot/'
    + encodeURIComponent('抖音热点词条') + '/2704161');
check('抖音：无 sentence_id 走搜索链接',
  dy[1].url === 'https://www.douyin.com/search/' + encodeURIComponent('无 sentence_id 的词条'));
check('热搜：空 payload 返回空数组',
  parseWeiboHot(null).length === 0 && parseToutiaoHot({}).length === 0
  && parseDouyinHot({ data: {} }).length === 0);

/* ---------- 5. 正文按板块选样 ---------- */
console.log('[content] 正文按板块选样');
const mit = (id, cat, ms) => ({ id, category: cat, url: 'https://example.com/' + id, publishedAtMs: ms, content: '' });
const pool = [
  mit('t1', 'today', 300), mit('t2', 'today', 200), mit('t3', 'today', 100),
  mit('a1', 'ai', 300), mit('a2', 'ai', 200),
  mit('e1', 'ent', 300),
  { id: 'no-url', category: 'today', url: '', publishedAtMs: 400, content: '' },
  { id: 'has-content', category: 'today', url: 'https://example.com/x', publishedAtMs: 400, content: '已有正文' },
];
const picked = pickContentTargets(pool, { perCategory: 2, limit: 100 });
check('每板块各取 2 条（today2+ai2+ent1=5）', picked.length === 5);
check('板块内按时间倒序', picked[0].id === 't1' && picked[1].id === 't2');
check('跳过无链接与已有正文的条目',
  !picked.some((x) => x.id === 'no-url' || x.id === 'has-content'));
check('perCategory=0 时退化为总量上限',
  pickContentTargets(pool, { perCategory: 0, limit: 3 }).length === 3);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
