/*
 * 豆包 API 摘要（可选，默认不启用）
 * 在设置页开启并填写密钥后：
 *   - 资讯卡片/详情页出现「AI 摘要」按钮（单条）
 *   - 列表顶部出现「一眼预览」（板块级重点摘要）
 * 走 OpenAI 兼容协议（火山方舟 Ark）；密钥仅保存在浏览器 localStorage。
 */
window.DoubaoAI = (function () {
  const DEFAULT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3';
  const TAB_NAMES = { today: '今天', ai: 'AI 圈', ent: '娱乐圈' };

  function enabled(settings) {
    return !!(settings && settings.doubaoEnabled && settings.doubaoKey && settings.doubaoModel);
  }

  async function chat(messages, settings, timeout = 45000) {
    const base = (settings.doubaoEndpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + settings.doubaoKey,
        },
        body: JSON.stringify({ model: settings.doubaoModel, temperature: 0.3, messages }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error('接口返回 HTTP ' + resp.status + (text ? '：' + text.slice(0, 180) : ''));
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('接口未返回内容');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  async function summarize(item, settings) {
    if (!enabled(settings)) {
      throw new Error('未开启 AI 接口或未填写密钥 / 模型');
    }
    return chat([
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
    ], settings);
  }

  /**
   * 板块级「一眼预览」：基于当前列表生成重点摘要
   * @param {string} tab today / ai / ent
   * @param {Array} items 当前列表条目（已排序）
   */
  async function digest(tab, items, settings) {
    if (!enabled(settings)) {
      throw new Error('未开启 AI 接口或未填写密钥 / 模型');
    }
    const list = items.slice(0, 40).map((it, i) =>
      `${i + 1}. ${it.titleZh || it.title}（${it.source}）`
      + (it.summaryZh || it.summary ? '：' + (it.summaryZh || it.summary).slice(0, 90) : '')
    ).join('\n');
    return chat([
      {
        role: 'system',
        content: '你是资深新闻编辑。基于用户给出的「' + (TAB_NAMES[tab] || tab) + '」板块新闻列表，'
          + '提炼 5-8 条本期重点，每条一句话（40 字以内），按重要性排序，格式为「· 要点」。'
          + '只总结列表里有的内容，不要编造，不要输出列表以外的信息。',
      },
      { role: 'user', content: '新闻列表：\n' + list },
    ], settings);
  }

  return { enabled, summarize, digest, DEFAULT_ENDPOINT };
})();
