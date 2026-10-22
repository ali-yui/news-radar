/*
 * 豆包 API 摘要（可选，默认不启用）
 * 在设置页开启并填写密钥后：
 *   - 资讯卡片/详情页出现「AI 摘要」按钮（单条）
 *   - 列表顶部出现「一眼预览」（板块级重点摘要）
 * 走 OpenAI 兼容协议（火山方舟 Ark）；密钥仅保存在浏览器 localStorage。
 */
window.DoubaoAI = (function () {
  'use strict';

  const DEFAULT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3';
  const TAB_NAMES = { today: '今天', ai: 'AI 圈', ent: '娱乐圈' };

  // 单条摘要送入正文的上限（字符，约 2400 字 ≈ 1500 tokens），既保证信息量又不超预算
  const CONTENT_LIMIT = 2400;
  // 板块「一眼预览」：参与提炼的条数与每条摘要字数
  const DIGEST_ITEMS = 40;
  const DIGEST_SNIPPET = 90;
  // 默认超时：AI 生成通常 10-30s，给到 75s 容忍后端排队
  const DEFAULT_TIMEOUT = 75000;

  function enabled(settings) {
    return !!(settings && settings.doubaoEnabled && settings.doubaoKey && settings.doubaoModel);
  }

  function clip(text, limit) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return s.length > limit ? s.slice(0, limit) + '…' : s;
  }

  /** HTTP 状态码 → 用户能看懂的中文错误 */
  function httpError(status, text) {
    const tail = text ? '：' + clip(text, 160) : '';
    if (status === 401 || status === 403) return new Error('密钥无效或无权限（HTTP ' + status + '）' + tail);
    if (status === 429) return new Error('请求过于频繁或额度不足（HTTP 429），请稍后再试');
    if (status >= 500) return new Error('AI 服务暂时不可用（HTTP ' + status + '），请稍后重试');
    return new Error('接口返回 HTTP ' + status + tail);
  }

  /** 把浏览器的原始异常（含 "signal is aborted without reason"）转成人话 */
  function friendly(err, timeoutMs) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒），请重试或稍后再试');
    }
    if (err && /Failed to fetch|NetworkError|load failed|ERR_NETWORK/i.test(err.message || '')) {
      return new Error('网络连接失败，请检查网络或接口地址是否正确');
    }
    return err;
  }

  async function chat(messages, settings, timeout = DEFAULT_TIMEOUT) {
    const base = (settings.doubaoEndpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    const controller = new AbortController();
    // 用 TimeoutError 作为 abort 原因：浏览器默认的 "signal is aborted without reason"
    // 对用户毫无意义，且会被直接透传到 UI。
    const timer = setTimeout(
      () => controller.abort(new DOMException('timeout', 'TimeoutError')), timeout);
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
        throw httpError(resp.status, text);
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('接口未返回内容，请检查模型 / 推理接入点配置');
      return content;
    } catch (e) {
      throw friendly(e, timeout);
    } finally {
      clearTimeout(timer);
    }
  }

  async function summarize(item, settings) {
    if (!enabled(settings)) {
      throw new Error('未开启 AI 接口或未填写密钥 / 模型');
    }
    // 优先用正文（截断到 CONTENT_LIMIT）喂给模型；没有正文时退回摘要摘录，
    // 避免像旧版那样只凭标题+一句摘录去猜。
    const body = clip(item.content, CONTENT_LIMIT);
    const userContent = [
      '标题：' + (item.title || '（无）'),
      '来源：' + (item.source || '（无）'),
      '发布时间：' + (item.publishedAtMs
        ? new Date(item.publishedAtMs).toLocaleString('zh-CN') : '（未知）'),
      body ? ('原文正文（可能被截断）：\n' + body)
        : ('原文摘录：' + (item.summary || '（无摘录）')),
    ].join('\n');
    return chat([
      {
        role: 'system',
        content: '你是资深新闻编辑。基于用户提供的标题、来源、时间与原文（可能被截断），'
          + '用 2-4 句话、150 字以内概括这条新闻的核心事实、关键数据与影响。'
          + '只使用原文中出现的信息，不要编造，不要复述标题，'
          + '不要写「本文」「该文」之类的元话术。',
      },
      { role: 'user', content: userContent },
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
    const list = items.slice(0, DIGEST_ITEMS).map((it, i) =>
      `${i + 1}. ${it.titleZh || it.title}（${it.source}）`
      + (it.summaryZh || it.summary ? '：' + clip(it.summaryZh || it.summary, DIGEST_SNIPPET) : '')
    ).join('\n');
    return chat([
      {
        role: 'system',
        content: '你是资深新闻主编。基于用户给出的「' + (TAB_NAMES[tab] || tab) + '」板块新闻列表，'
          + '提炼 5-8 条本期重点，按重要性排序，每条一句话（不超过 40 字），'
          + '以「· 」开头逐条输出。只总结列表里已有的内容，不要编造或补充列表外的信息。',
      },
      { role: 'user', content: '新闻列表：\n' + list },
    ], settings);
  }

  return { enabled, summarize, digest, DEFAULT_ENDPOINT };
})();
