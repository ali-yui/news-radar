// 临时工具：jsdom 功能测试（含本轮回归修复 + 热搜源）
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const ROOT = 'e:/news/news-radar';
let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log(' FAIL ' + name); }
};

const html = await readFile(ROOT + '/index.html', 'utf8');
const daily = JSON.parse(await readFile(ROOT + '/public/data/daily.json', 'utf8'));
const css = await readFile(ROOT + '/assets/style.css', 'utf8');

const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
window.fetch = async () => ({ ok: false, status: 0, text: async () => '' });
window.open = () => {};

for (const f of ['data-bundle.js', 'dedup.js', 'doubao.js', 'translator.js', 'live.js', 'trending.js', 'detail.js', 'app.js']) {
  window.eval(await readFile(ROOT + '/assets/' + f, 'utf8'));
}
window.__NEWS_RADAR_BOOTSTRAP__ = daily;
const doc = window.document;
await new Promise((r) => setTimeout(r, 300));

console.log('[boot]');
check('NRApp 已暴露', !!window.NRApp);
check('列表已渲染', doc.querySelectorAll('#list .item').length > 0);
check('一眼预览卡片存在', !!doc.querySelector('#list .digest-card'));

console.log('[数据：三大热搜]');
const srcs = new Set(daily.items.map((i) => i.source));
check('微博热搜已入库', srcs.has('微博热搜'));
check('今日头条已入库', srcs.has('今日头条'));
check('抖音热点已入库', srcs.has('抖音热点'));
check('热搜娱乐跨挂生效', daily.items.some((i) => (i.extraCategories || []).includes('ent')
  && ['微博热搜', '今日头条', '抖音热点'].includes(i.source)));
check('有条目带正文', daily.items.some((i) => i.content && i.content.length > 100));

console.log('[Trending 回归修复]');
const maskRule = css.match(/\.sheet-mask\s*\{[^}]*\}/);
check('遮罩为 fixed（视口锚定）', !!maskRule && /position:\s*fixed/.test(maskRule[0]));
const tabRule = css.match(/\.tabbar\s*\{[^}]*\}/);
check('tabbar 为 fixed 且层级低于遮罩', !!tabRule && /position:\s*fixed/.test(tabRule[0])
  && /z-index:\s*40/.test(tabRule[0]) && /z-index:\s*50/.test(maskRule[0]));

doc.querySelector('.tab[data-tab="ai"]').click();
await new Promise((r) => setTimeout(r, 50));
window.Trending.show('daily');
await new Promise((r) => setTimeout(r, 200));
check('AI 圈可打开榜单浮层', !doc.querySelector('#trendingSheet').classList.contains('hidden'));
const sheetEl = doc.querySelector('#trendingSheet .sheet');
check('浮层宽度按 App 宽度设定', !!sheetEl && !!sheetEl.style.maxWidth);
check('榜单条目已渲染', doc.querySelectorAll('#trendingBody .trend-item').length > 0);

doc.querySelector('.tab[data-tab="today"]').click();
await new Promise((r) => setTimeout(r, 50));
check('切换 Tab 自动收起榜单', doc.querySelector('#trendingSheet').classList.contains('hidden'));
check('body 滚动已恢复', doc.body.style.overflow === '');

doc.querySelector('.tab[data-tab="ai"]').click();
window.Trending.show('daily');
await new Promise((r) => setTimeout(r, 200));
const firstItem = doc.querySelector('#trendingBody .trend-item');
if (firstItem) {
  firstItem.click();
  check('点榜单条目打开 App 内仓库详情', !doc.querySelector('#page-detail').classList.contains('hidden'));
  check('仓库详情提供「在 App 内打开原文」', !!doc.querySelector('[data-act="open-url"]'));
  doc.querySelector('#detailBack').click();
}

console.log('[详情页]');
const firstCard = doc.querySelector('#list .item[data-id]');
window.Detail.open(firstCard.dataset.id);
check('详情页可打开', !doc.querySelector('#page-detail').classList.contains('hidden'));
check('详情标题非空', (doc.querySelector('.detail-title')?.textContent || '').length > 0);
doc.querySelector('#detailViewSeg button[data-view="summary"]').click();
check('切到只看摘要有提示', (doc.querySelector('#detailContentZone')?.textContent || '').includes('只看摘要'));
doc.querySelector('#detailViewSeg button[data-view="full"]').click();
const fullZone = doc.querySelector('#detailContentZone')?.textContent || '';
check('切回全文：有正文或给出无全文降级',
  fullZone.length > 0 && (fullZone.includes('暂无全文') || fullZone.length > 80));
const beforeFont = doc.querySelector('#detailScroll').style.getPropertyValue('--reader-font');
doc.querySelector('[data-font="inc"]').click();
check('字号可调', doc.querySelector('#detailScroll').style.getPropertyValue('--reader-font') !== beforeFont);
doc.querySelector('#detailBack').click();
check('详情页可关闭', doc.querySelector('#page-detail').classList.contains('hidden'));

console.log('[事件聚类卡]');
const toggle = doc.querySelector('#list .item.cluster [data-act="cluster-toggle"]');
if (toggle) {
  const box = doc.querySelector('#list .item.cluster .cluster-members');
  const wasHidden = box.classList.contains('hidden');
  toggle.click();
  check('聚类卡可展开/收起', box.classList.contains('hidden') !== wasHidden);
} else {
  console.log('  (当前筛选结果无多源聚类，跳过)');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
