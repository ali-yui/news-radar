/*
 * 豆包 API 摘要（可选，默认不启用）
 * 在设置页开启并填写密钥后，资讯卡片上出现「AI 摘要」按钮。
 * 走 OpenAI 兼容协议（火山方舟 Ark）；密钥仅保存在浏览器 localStorage。
 */
window.DoubaoAI = (function () {
  const DEFAULT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3';

  function enabled(settings) {
    return !!(settings && settings.doubaoEnabled && settings.doubaoKey && settings.doubaoModel);
  }

  async function summarize(item, settings) {
    if (!enabled(settings)) {
      throw new Error('未开启豆包 API 或未填写密钥 / 模型');
    }
    const base = (settings.doubaoEndpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + settings.doubaoKey,
        },
        body: JSON.stringify({
          model: settings.doubaoModel,
          temperature: 0.3,
          messages: [
            {
              role: 'system',
              content: '你是资深新闻摘要助手。基于用户给出的标题、来源与原文摘录，用 2-3 句话、120 字以内概括核心事实；摘录信息不足时不要编造。',
            },
            {
              role: 'user',
              content:
                '标题：' + item.title +
                '\n来源：' + item.source +
                '\n发布时间：' + new Date(item.publishedAtMs).toLocaleString('zh-CN') +
                '\n原文摘录：' + (item.summary || '（无摘录）'),
            },
          ],
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error('接口返回 HTTP ' + resp.status + (text ? '：' + text.slice(0, 180) : ''));
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('接口未返回摘要内容');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  return { enabled, summarize, DEFAULT_ENDPOINT };
})();
