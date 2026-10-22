/**
 * 国内三大热搜解析（纯函数，便于自测）
 * 端点均为公开 JSON，免登录免签名；已在 2026-10-20 实测可用。
 * 知乎热榜需登录（返回 AuthenticationError），故未纳入。
 */

/** 微博热搜：`https://weibo.com/ajax/side/hotSearch` → data.realtime[] */
export function parseWeiboHot(json) {
  const list = json?.data?.realtime || [];
  return list.map((it) => {
    const title = (it.word_scheme || it.word || '').replace(/^#+|#+$/g, '').trim();
    return {
      title,
      url: title ? 'https://s.weibo.com/weibo?q=' + encodeURIComponent('#' + title + '#') : '',
      hot: typeof it.num === 'number' ? it.num : 0,
    };
  }).filter((x) => x.title.length >= 3 && x.url);
}

/** 今日头条热点：`https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc` → data[] */
export function parseToutiaoHot(json) {
  const list = json?.data || [];
  return list.map((it) => {
    const title = (it.Title || '').trim();
    const url = it.Url || (it.ClusterId ? `https://www.toutiao.com/trending/${it.ClusterId}/` : '');
    return { title, url, hot: typeof it.HotValue === 'number' ? it.HotValue : 0 };
  }).filter((x) => x.title.length >= 3 && x.url);
}

/** 抖音热点：aweme/v1/web/hot/search/list → data.word_list[] */
export function parseDouyinHot(json) {
  const list = json?.data?.word_list || [];
  return list.map((it) => {
    const title = (it.word || '').trim();
    const sid = it.sentence_id || '';
    const url = title
      ? (sid
        ? `https://www.douyin.com/hot/${encodeURIComponent(title)}/${sid}`
        : `https://www.douyin.com/search/${encodeURIComponent(title)}`)
      : '';
    return { title, url, hot: typeof it.hot_value === 'number' ? it.hot_value : 0 };
  }).filter((x) => x.title.length >= 3 && x.url);
}

export default { parseWeiboHot, parseToutiaoHot, parseDouyinHot };
