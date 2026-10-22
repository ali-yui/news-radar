/**
 * 腾讯云 COS 上传（零依赖）
 * ---------------------------------------------------------------
 * 只实现流水线真正需要的那一小块：PUT Object（小文件直传）+ 请求签名，
 * 不引入官方 SDK，保持项目「零依赖」的一贯做法。
 *
 * 用途：把 daily.json / cn.json 发布到对象存储，App 直接读公开 URL。
 *       这样数据分发不再依赖「公开 git 仓库的 raw / jsDelivr」，
 *       仓库因此可以自由设为私有，也不必维护 Gitee 镜像。
 *
 * 环境变量（Actions 存 Secrets，云函数存环境变量）：
 *   COS_BUCKET                 桶名（含 APPID，如 news-radar-1251234567）
 *   COS_REGION                 地域（如 ap-guangzhou）
 *   COS_SECRET_ID              密钥 SecretId（长期密钥，可选）
 *   COS_SECRET_KEY             密钥 SecretKey（长期密钥，可选）
 *   COS_ENDPOINT               可选：自定义接入域名
 *
 * 零长期密钥方案（推荐）：给 SCF 函数绑定 CAM「运行角色」后，平台会自动注入
 *   临时凭证 TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY / TENCENTCLOUD_SESSIONTOKEN，
 *   本模块优先使用它们，且签名会自动带上 x-cos-security-token。
 *   此时 COS_SECRET_ID / COS_SECRET_KEY 不用再配置。
 *
 * 变量名说明：腾讯云 SCF 把 SCF_ / QCLOUD_ / TENCENTCLOUD_ 三个前缀列为保留字，
 *            自定义环境变量不能再用它们打头，所以长期密钥统一用 COS_ 前缀。
 *
 * 签名算法：https://cloud.tencent.com/document/product/436/7778
 *
 * 为什么用 node:https 而不是 fetch：
 *   与 http.mjs 相反，这里不需要绕过 Cloudflare 指纹（COS 是腾讯云域名），
 *   而 PUT 必须精确控制 Content-Length 参与签名，node:https 更可控，
 *   也顺带避开 Node 22 undici 在中断响应体时的已知崩溃。
 */

import https from 'node:https';
import { createHash, createHmac } from 'node:crypto';

const DEFAULT_TIMEOUT = 30000;

/** 腾讯云的「安全 URL 编码」，与官方 SDK 的 camSafeUrlEncode 一致 */
function safeEncode(s) {
  return encodeURIComponent(s)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

const sha1hex = (s) => createHash('sha1').update(s).digest('hex');
const hmacSha1hex = (key, s) => createHmac('sha1', key).update(s).digest('hex');

/** 参与签名的 header/param 序列化：key 小写、字典序、key=value& 拼接 */
function serialize(entries) {
  return entries
    .slice()
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k.toLowerCase()}=${safeEncode(v)}`)
    .join('&');
}

/**
 * 生成 COS 请求签名（qSignAlgorithm=sha1）
 * @param {object} p
 * @param {string} p.secretId p.secretKey p.method p.keyPath
 * @param {Record<string,string>} p.headers 参与签名的请求头（key 会按小写处理）
 * @returns {string} Authorization 头的值
 */
export function buildAuthorization(p) {
  const { secretId, secretKey, method, keyPath, headers } = p;
  const now = Math.floor(Date.now() / 1000);
  // 往前留 60s 容忍本机时钟漂移，往后 1h 足够覆盖单次抓取
  const keyTime = `${now - 60};${now + 3600}`;
  const signKey = hmacSha1hex(secretKey, keyTime);

  // UriPathname：分段编码，保留路径分隔符 '/'
  const uriPathname = '/' + keyPath.split('/').map(safeEncode).join('/');

  const pairs = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]);
  const httpHeaders = serialize(pairs);
  const headerList = pairs.map(([k]) => k.toLowerCase()).sort().join(';');

  // HttpString 结尾必须带换行（HttpParameters 为空）
  const httpString = [method.toLowerCase(), uriPathname, '', httpHeaders, ''].join('\n');
  const stringToSign = ['sha1', keyTime, sha1hex(httpString), ''].join('\n');
  const signature = hmacSha1hex(signKey, stringToSign);

  return [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    'q-url-param-list=',
    `q-signature=${signature}`,
  ].join('&');
}

/** 从环境变量读取 COS 配置 */
export function cosConfigFromEnv() {
  // SCF 绑定「运行角色」后，平台会注入短期临时凭证（无需用户配置、会自动轮转）。
  // 注入的变量名是 TENCENTCLOUD_ 前缀（这正是它们被列为保留字的原因）。
  // 不同腾讯云产品的拼写略有差异，这里做兼容：
  const platformId = process.env.TENCENTCLOUD_SECRETID || process.env.TENCENTCLOUD_SECRET_ID || '';
  const platformKey = process.env.TENCENTCLOUD_SECRETKEY || process.env.TENCENTCLOUD_SECRET_KEY || '';
  const platformToken = process.env.TENCENTCLOUD_SESSIONTOKEN || process.env.TENCENTCLOUD_SESSION_TOKEN || '';

  return {
    bucket: process.env.COS_BUCKET || '',
    region: process.env.COS_REGION || '',
    // 优先用平台注入的临时凭证（运行角色），否则回退到用户配置的长期密钥。
    // 长期密钥变量用 COS_ 前缀：腾讯云 SCF 保留 SCF_ / QCLOUD_ / TENCENTCLOUD_，
    // 自定义环境变量不允许再用它们打头（会直接保存失败）。
    secretId: platformId || process.env.COS_SECRET_ID || '',
    secretKey: platformKey || process.env.COS_SECRET_KEY || '',
    // 临时凭证的 sessionToken：有了它，签名要额外带上 x-cos-security-token 头
    sessionToken: platformToken || process.env.COS_SESSION_TOKEN || '',
    // 自定义接入域名：云函数若部署在无公网的 VPC 内，可改为 COS 内网域名
    // 例如 news-radar-1251234567.cos-internal.ap-guangzhou.tencentcos.cn
    endpoint: process.env.COS_ENDPOINT || '',
  };
}

export function isCosConfigured(cfg = cosConfigFromEnv()) {
  return !!(cfg.bucket && cfg.region && cfg.secretId && cfg.secretKey);
}

/** 对象的公开访问地址（桶需为「公有读私有写」） */
export function publicUrl(bucket, region, keyPath) {
  return `https://${bucket}.cos.${region}.myqcloud.com/${keyPath}`;
}

/**
 * 上传一个小文件到 COS（覆盖已有对象）
 * @param {object} p
 * @param {string} p.bucket p.region p.secretId p.secretKey p.key
 * @param {string|Buffer} p.body 文件内容
 * @param {string} [p.contentType]
 * @param {number} [p.timeout]
 * @returns {Promise<{ok:boolean, status:number, url:string, message:string}>}
 */
export async function putObject(p) {
  const {
    bucket, region, secretId, secretKey, key,
    body, contentType = 'application/json; charset=utf-8',
    timeout = DEFAULT_TIMEOUT,
    // 上传通道可自定义（如走 COS 内网域名），但对外公开的 URL 始终用标准公网域名
    endpoint = '',
    // 临时凭证的 sessionToken：SCF 运行角色注入，签名与请求都要带上
    sessionToken = '',
  } = p;

  const keyPath = String(key || '').replace(/^\/+/, '');
  if (!bucket || !region || !secretId || !secretKey || !keyPath) {
    return { ok: false, status: 0, url: '', message: 'missing bucket/region/secretId/secretKey/key' };
  }

  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const host = endpoint || `${bucket}.cos.${region}.myqcloud.com`;

  // 参与签名的头必须与真实发送的头一致（尤其 Content-Length）
  const signHeaders = {
    host,
    'content-type': contentType,
    'content-length': String(buf.length),
  };
  // 临时凭证：x-cos-security-token 既参与签名，也要随请求发送
  if (sessionToken) signHeaders['x-cos-security-token'] = sessionToken;
  const authorization = buildAuthorization({
    secretId, secretKey, method: 'PUT', keyPath, headers: signHeaders,
  });

  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const req = https.request({
      hostname: host,
      path: '/' + keyPath,
      method: 'PUT',
      headers: {
        Host: host,
        Authorization: authorization,
        'Content-Type': contentType,
        'Content-Length': buf.length,
        ...(sessionToken ? { 'x-cos-security-token': sessionToken } : {}),
      },
    }, (res) => {
      // 响应体只在失败时有意义（COS 返回 XML 错误），最多读 2KB
      const chunks = [];
      res.on('data', (c) => { if (chunks.length < 8) chunks.push(c); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          done({ ok: true, status: 200, url: publicUrl(bucket, region, keyPath), message: 'ok' });
        } else {
          const text = Buffer.concat(chunks).toString('utf8');
          done({
            ok: false,
            status: res.statusCode || 0,
            url: '',
            message: `COS 返回 ${res.statusCode}：${text.slice(0, 200)}`,
          });
        }
      });
      res.on('error', (e) => done({ ok: false, status: 0, url: '', message: e.message || '响应错误' }));
    });

    req.setTimeout(timeout, () => req.destroy(new Error('COS 上传超时')));
    req.on('error', (e) => done({ ok: false, status: 0, url: '', message: e.message || '请求失败' }));
    req.on('timeout', () => req.destroy(new Error('COS 上传超时')));
    req.end(buf);
  });
}

export default { putObject, publicUrl, cosConfigFromEnv, isCosConfigured, buildAuthorization };
