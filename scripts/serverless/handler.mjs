#!/usr/bin/env node
/**
 * 云函数入口（腾讯云 SCF / 阿里云 FC 通用）
 * ---------------------------------------------------------------
 * 用途：承担「国内路」抓取（微博 / 头条 / 抖音 + 各中文 RSS），
 *       把 cn.json 发布到对象存储，从而不再需要电脑开机跑计划任务。
 *
 * 云函数配置：
 *   入口文件：scripts/serverless/handler.mjs
 *   处理函数：handler
 *   超时：建议 300s（国内源抓取 + 正文抽取 + 上传）
 *   内存：建议 512MB
 *   定时触发：cron(0 * * * *) 每小时一次
 *
 * 环境变量（云函数控制台配置）：
 *   STORE=cos                  发布目标：cos（默认）/ git / cos,git
 *
 *   —— 发布到 COS（默认，推荐）时必填 ——
 *   COS_BUCKET                 桶名（含 APPID，如 news-radar-1251234567）
 *   COS_REGION                 地域（如 ap-guangzhou）
 *   COS_SECRET_ID              密钥 SecretId（不能用 TENCENTCLOUD_ 前缀，SCF 保留）
 *   COS_SECRET_KEY             密钥 SecretKey
 *   COS_KEY=data/cn.json       对象路径（默认 data/cn.json）
 *   COS_ENDPOINT               可选，上传走内网域名时填写
 *
 *   —— 发布到 git 仓库（可选：用作 jsDelivr 兜底地址）时必填 ——
 *   PLATFORM=github|gitee      默认 github
 *   REPO_OWNER / REPO_NAME     默认 ali-yui / news-radar
 *   DATA_BRANCH=data-cn        存放 cn.json 的分支
 *   DATA_TOKEN=平台令牌          GitHub PAT（repo）或 Gitee 私人令牌（projects）
 *   PURGE_JSDELIVR=1           写完后刷新 jsDelivr 缓存
 *
 *   —— 抓取参数 ——
 *   CONTENT_PER_CATEGORY=50    正文抓取配额（国内网络抓取快，可放宽）
 *   RUNTIME_DIR=/tmp           可写目录（云函数环境自动识别，一般无需手填）
 *
 * 先单独验证 COS 配置是否正确（不抓数据）：
 *   node scripts/upload-cos.mjs public/data/daily.json data/test.json
 * 本地试跑：node scripts/serverless/handler.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { putFile } from '../lib/git-api.mjs';
import { putObject, cosConfigFromEnv, isCosConfigured } from '../lib/cos.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 真的能在该目录里建子目录吗。
 * 比 fs.access 的权限位判断可靠：以 root 运行时 access 会永远返回可写，而实际可能是只读挂载。
 */
function writable(dir) {
  const probe = join(dir, '.nr-write-probe');
  try {
    mkdirSync(probe, { recursive: true });
    rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 云函数的代码目录是只读的，产物与正文缓存都要落到 /tmp。
 * 本地 / Actions 不设该变量，保持写入仓库的原有行为。
 */
function detectRuntimeDir() {
  if (process.env.RUNTIME_DIR) return process.env.RUNTIME_DIR;
  const serverless = process.env.SCF_FUNCTIONNAME || process.env.SCF_NAMESPACE
    || process.env.TENCENTCLOUD_SESSIONTOKEN || process.env.TENCENTCLOUD_RUNENV
    || process.env.FC_FUNC_CODE_PATH;
  if (serverless) return '/tmp';
  // 兜底：连探针目录都建不了，说明这就是只读环境（云函数的普遍约定）
  return writable(ROOT) ? '' : '/tmp';
}

export async function handler(event, context) {
  const started = Date.now();
  const runtimeDir = detectRuntimeDir();
  const dataPath = join(runtimeDir || ROOT, 'public', 'data', 'cn.json');
  const perCategory = process.env.CONTENT_PER_CATEGORY || '50';

  // 1. 抓取国内源（SOURCES=cn），产出 cn.json
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'fetch-data.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      RUNTIME_DIR: runtimeDir,
      SOURCES: 'cn',
      DATA_FILE: 'cn.json',
      SKIP_TRANSLATE: '1',
      CONTENT_CACHE: process.env.CONTENT_CACHE || '1',
      CONTENT_PER_CATEGORY: perCategory,
      CONTENT_LIMIT: process.env.CONTENT_LIMIT || '160',
    },
    encoding: 'utf8',
    timeout: 240000,
  });
  if (r.status !== 0) {
    return {
      ok: false,
      stage: 'fetch',
      message: (r.stderr || r.stdout || '').slice(-300) || `抓取退出码 ${r.status}`,
      ms: Date.now() - started,
    };
  }

  // 2. 读取产物
  let text = '';
  try {
    text = await readFile(dataPath, 'utf8');
  } catch (e) {
    return { ok: false, stage: 'read', message: String(e.message || e), ms: Date.now() - started };
  }
  let items = 0;
  try {
    items = (JSON.parse(text).items || []).length;
  } catch {
    return { ok: false, stage: 'parse', message: 'cn.json 不是合法 JSON', ms: Date.now() - started };
  }

  // 3. 按 STORE 发布
  const stores = (process.env.STORE || 'cos')
    .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const published = {};
  let anyOk = false;

  if (stores.includes('cos')) {
    const cfg = cosConfigFromEnv();
    if (!isCosConfigured(cfg)) {
      published.cos = 'skipped: 未配置 COS_BUCKET / COS_REGION / TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY';
    } else {
      const up = await putObject({
        ...cfg,
        key: process.env.COS_KEY || 'data/cn.json',
        body: text,
      });
      published.cos = up.ok ? `ok ${up.url}` : `fail ${up.message}`;
      if (up.ok) anyOk = true;
    }
  }

  if (stores.includes('git')) {
    const platform = (process.env.PLATFORM || 'github').toLowerCase();
    const owner = process.env.REPO_OWNER || 'ali-yui';
    const repo = process.env.REPO_NAME || 'news-radar';
    const branch = process.env.DATA_BRANCH || 'data-cn';
    const token = process.env.DATA_TOKEN || '';

    if (!token) {
      published.git = 'skipped: 未配置 DATA_TOKEN';
    } else {
      const put = await putFile({
        platform,
        owner,
        repo,
        branch,
        path: 'public/data/cn.json',
        content: text,
        message: `chore(data): cn news ${new Date().toISOString().slice(0, 13)}:00 UTC`,
        token,
      });
      let purged = 'skipped';
      if (process.env.PURGE_JSDELIVR === '1') {
        try {
          const resp = await fetch(`https://purge.jsdelivr.net/gh/${owner}/${repo}@${branch}/public/data/cn.json`);
          purged = resp.ok ? 'ok' : `fail ${resp.status}`;
        } catch (e) {
          purged = `fail: ${e.message || e}`;
        }
      }
      published.git = put.ok ? `ok (purge ${purged})` : `fail ${put.message}`;
      if (put.ok) anyOk = true;
    }
  }

  return {
    ok: anyOk,
    stage: 'done',
    items,
    bytes: text.length,
    published,
    ms: Date.now() - started,
  };
}

// 本地试跑
if (process.argv[1] && process.argv[1].endsWith('handler.mjs')) {
  handler({}, {}).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export default { handler };
