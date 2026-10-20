/**
 * 正文抽取（零依赖 readability-lite）
 * ---------------------------------------------------------------
 * 从文章 HTML 中提取正文段落，供「App 内读全文」使用。
 * 不引入 npm 依赖，规则：
 *   1. 去 script/style/noscript/svg/模板等噪声节点
 *   2. 优先在 article / main / [role=main] / .article / .content 等容器内找段落
 *   3. 容器缺失时按「段落文本密度」挑选最佳块级元素
 *   4. 过滤导航、版权、分享、评论等噪声段落；按空行分段
 */

const NOISE_BLOCK = /<(script|style|noscript|template|svg|iframe|form|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// 段落噪声：导航/交互/版权/分享提示等
const NOISE_TEXT = /^(分享|评论|收藏|点赞|转发|登录|注册|版权|免责|声明|关于我们|联系方式|点击|查看更多|展开全文|收起|下一篇|上一篇|相关阅读|推荐阅读|关键词|标签|来源|编辑|作者|点击进入|扫一扫|关注我们|广告|推广|APP|下载|客户端|微博|微信|QQ|头条号|订阅|投稿|Tag)/i;

function decodeEntities(s) {
  if (!s) return '';
  const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    '#39': "'", '#x27': "'", '#x2f': '/', hellip: '…', mdash: '—',
    ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    middot: '·', copy: '©', reg: '®',
  };
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z0-9#x]+);/g, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** 去掉注释与噪声块，返回相对干净的 HTML */
function cleanHtml(html) {
  return (html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(NOISE_BLOCK, ' ');
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 提取页面 <title> 作为兜底标题 */
export function extractTitle(html) {
  const m = (html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]) : '';
}

/** 提取 meta description 作为摘要兜底 */
export function extractMetaDescription(html) {
  const m = (html || '').match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i)
    || (html || '').match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i);
  return m ? stripTags(m[1]) : '';
}

const CONTAINER_RE = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i;
const CLASS_CONTENT_RE = /<(div|section)\b[^>]*(?:class|id)=["'][^"']*(?:article|content|post|entry|main|detail|news|text|body)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;

/** 取候选容器（按优先级），返回容器内 HTML 或 null */
function pickContainer(html) {
  const cleaned = cleanHtml(html);
  const m = cleaned.match(CONTAINER_RE);
  if (m && m[2].length > 200) return m[2];
  let best = null;
  let bestLen = 0;
  CLASS_CONTENT_RE.lastIndex = 0;
  let cm;
  while ((cm = CLASS_CONTENT_RE.exec(cleaned))) {
    if (cm[2].length > bestLen) { best = cm[2]; bestLen = cm[2].length; }
  }
  if (best && bestLen > 200) return best;
  return null;
}

/** 把一段 HTML 切成段落数组（按 <p>、<br>、空行） */
function paragraphsOf(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .split(/\n+/)
    .map((raw) => stripTags(raw))
    .filter(Boolean);
}

function isNoiseParagraph(p) {
  if (p.length < 12) return true;
  if (NOISE_TEXT.test(p)) return true;
  // 超链接堆叠（导航块）
  if ((p.match(/https?:\/\//g) || []).length > 1) return true;
  return false;
}

/**
 * 从整页 HTML 提取正文
 * @param {string} html 页面 HTML
 * @param {{maxChars?: number, minParagraphs?: number}} opts
 * @returns {{text: string, paragraphs: string[], source: 'container'|'fallback'|'meta'}}
 */
export function extractContent(html, opts = {}) {
  const maxChars = opts.maxChars ?? 6000;
  const minParagraphs = opts.minParagraphs ?? 3;
  const cleaned = cleanHtml(html);

  let paras = [];
  let origin = 'fallback';
  const container = pickContainer(html);
  if (container) {
    paras = paragraphsOf(container);
    origin = 'container';
  }
  if (paras.filter((p) => !isNoiseParagraph(p)).length < minParagraphs) {
    // 兜底：全文所有段落
    paras = paragraphsOf(cleaned);
    origin = 'fallback';
  }

  const kept = [];
  let total = 0;
  for (const p of paras) {
    if (isNoiseParagraph(p)) continue;
    if (total + p.length > maxChars) break;
    kept.push(p);
    total += p.length;
  }
  if (kept.length < minParagraphs) {
    const meta = extractMetaDescription(html);
    if (meta) return { text: meta, paragraphs: [meta], source: 'meta' };
  }
  return { text: kept.join('\n\n'), paragraphs: kept, source: origin };
}

export { stripTags, decodeEntities };
