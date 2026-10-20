/**
 * 极简 HTTP 客户端（零依赖）
 * ---------------------------------------------------------------
 * 为什么不用 AbortController 超时：
 *   Node 22 的 undici 在「中断正在读取的响应体」时会抛
 *   ERR_ASSERTION: assert(!this.paused) 直接崩进程（已知 bug）。
 *   本模块改用「竞速超时」：超时后不 abort，只是不再等待结果，
 *   并在后台取消 body 释放连接，从根本上绕过该崩溃。
 *
 * 为什么不用 node:https 直连：
 *   Cloudflare 站点（如 openai.com）按 TLS 指纹拦截 node:https，
 *   而 undici fetch 的指纹可通过，故优先 fetch，仅在无 fetch 时降级。
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const DEFAULT_UA = 'news-radar/2.0 (+https://github.com/; public RSS/API aggregator)';

/* ---------- node:https 降级通道 ---------- */
function getOnceNative(url, headers, timeout, maxBytes) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': DEFAULT_UA, 'Accept-Encoding': 'identity', ...headers },
    }, (resp) => {
      const chunks = [];
      let size = 0;
      resp.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('响应过大')); return; }
        chunks.push(c);
      });
      resp.on('end', () => resolve({
        status: resp.statusCode,
        headers: resp.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      resp.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

async function getNative(url, opts) {
  let current = url;
  for (let i = 0; i <= (opts.maxRedirects ?? 5); i++) {
    try {
      const r = await getOnceNative(current, opts.headers || {}, opts.timeout ?? 12000, opts.maxBytes ?? 2_000_000);
      if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
        current = new URL(r.headers.location, current).toString();
        continue;
      }
      return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body };
    } catch (e) {
      return { ok: false, status: 0, body: '', error: e };
    }
  }
  return { ok: false, status: 0, body: '', error: new Error('重定向次数过多') };
}

/* ---------- undici fetch 通道（竞速超时，不 abort） ---------- */
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new Error('请求超时'));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function getFetch(url, opts) {
  const headers = { 'User-Agent': DEFAULT_UA, ...(opts.headers || {}) };
  let fetchPromise;
  try {
    fetchPromise = fetch(url, { headers, redirect: 'follow' });
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e };
  }
  let resp;
  try {
    resp = await withTimeout(fetchPromise, opts.timeout ?? 12000, () => {
      // 超时后不 abort：请求最终完成时取消 body，释放连接
      // 注意 cancel() 可能返回 rejected promise（流已锁定时），必须接住
      fetchPromise.then((r) => cancelBody(r)).catch(() => {});
    });
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e };
  }
  try {
    const text = await withTimeout(resp.text(), opts.timeout ?? 12000, () => cancelBody(resp));
    return { ok: resp.ok, status: resp.status, body: text };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e };
  }
}

// 安全取消响应体：同步抛出与异步拒绝都要接住，避免变成未处理拒绝拖垮进程
function cancelBody(resp) {
  try {
    const p = resp && resp.body ? resp.body.cancel() : null;
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* 忽略：流已锁定/已关闭 */ }
}

/**
 * GET（跟随重定向）
 * @returns {Promise<{ok:boolean, status:number, body:string, error?:Error}>}
 */
export async function httpGet(url, opts = {}) {
  if (typeof fetch === 'function') return getFetch(url, opts);
  return getNative(url, opts);
}

export default { httpGet };
