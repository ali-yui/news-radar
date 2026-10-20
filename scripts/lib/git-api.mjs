/**
 * Git 平台「文件内容 API」封装（零依赖）
 * ---------------------------------------------------------------
 * 云函数环境没有 git 工作区，无法 commit/push，只能走平台 API 直接写入文件。
 * 支持 GitHub（api.github.com）与 Gitee（gitee.com/api/v5）。
 *
 * 权限：token 需要 repo（GitHub）/ projects（Gitee）写权限。
 */

import { httpGet } from './http.mjs';

function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

function buildUrl(base, params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') usp.append(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${base}?${qs}` : base;
}

async function requestJson(url, method, headers, bodyObj, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method,
      headers: { Accept: 'application/json', 'User-Agent': 'news-radar/2.2', ...headers },
      signal: controller.signal,
      body: bodyObj ? JSON.stringify(bodyObj) : undefined,
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, body: text };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 创建或更新仓库里的一个文件（云函数场景：无需 git 工作区）
 * @param {object} p
 * @param {'github'|'gitee'} [p.platform=github]
 * @param {string} p.owner p.repo p.branch p.path p.content(文本) p.message p.token
 * @returns {Promise<{ok:boolean, status:number, message:string, created:boolean}>}
 */
export async function putFile(p) {
  const { platform = 'github', owner, repo, branch = 'main', path, content, message, token } = p;
  if (!owner || !repo || !path || !token || content == null) {
    return { ok: false, status: 0, message: 'missing owner/repo/path/token/content', created: false };
  }
  const gh = platform === 'github';
  const base = gh
    ? `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
    : `https://gitee.com/api/v5/repos/${owner}/${repo}/contents/${path}`;
  const authParams = gh ? {} : { access_token: token };
  const headers = gh
    ? { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
    : { 'Content-Type': 'application/json;charset=UTF-8' };

  // 1. 取已有文件 sha（更新时必填）
  let sha = '';
  const cur = await httpGet(buildUrl(base, { ...authParams, ref: branch }),
    { timeout: 20000, headers: gh ? headers : {} });
  if (cur.ok) {
    try { sha = JSON.parse(cur.body).sha || ''; } catch { sha = ''; }
  }

  // 2. 写入：GitHub 用 PUT；Gitee 新建 POST、更新 PUT
  const body = { message, content: b64(content), branch };
  if (sha) body.sha = sha;
  const method = gh || sha ? 'PUT' : 'POST';
  const r = await requestJson(buildUrl(base, authParams), method, headers, body);
  return {
    ok: r.ok,
    status: r.status,
    created: !sha,
    message: r.ok ? 'ok' : (r.error ? (r.error.message || 'error') : String(r.body || '').slice(0, 200)),
  };
}

export default { putFile };
