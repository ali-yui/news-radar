#!/usr/bin/env node
/**
 * 云函数入口（腾讯云 SCF / 阿里云 FC 通用）
 * ---------------------------------------------------------------
 * 用法（云函数配置）：
 *   入口文件：scripts/serverless/handler.mjs
 *   处理函数：handler
 *   超时：建议 300s（国内源抓取 + 正文抽取）
 *   内存：建议 512MB
 *   定时触发：SCF 定时触发器 cron(0 * * * *) 每小时一次
 *
 * 环境变量（云函数控制台配置）：
 *   PLATFORM=github|gitee            默认 github（国内数据经 jsDelivr 分发）
 *   REPO_OWNER / REPO_NAME           默认 ali-yui / news-radar
 *   DATA_BRANCH=data-cn              存放 cn.json 的分支（建议独立分支，避免污染 main 历史）
 *   DATA_TOKEN=平台令牌              GitHub PAT（repo 权限）或 Gitee 私人令牌（projects 权限）
 *   CONTENT_PER_CATEGORY=50          正文抓取配额（国内网络抓取快，可放宽）
 *   PURGE_JSDELIVR=1                 写完后刷新 jsDelivr 缓存
 *
 * 本地试跑：node scripts/serverless/handler.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { putFile } from '../lib/git-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_PATH = join(ROOT, 'public', 'data', 'cn.json');

export async function handler(event, context) {
  const started = Date.now();
  const platform = (process.env.PLATFORM || 'github').toLowerCase();
  const owner = process.env.REPO_OWNER || 'ali-yui';
  const repo = process.env.REPO_NAME || 'news-radar';
  const branch = process.env.DATA_BRANCH || 'data-cn';
  const token = process.env.DATA_TOKEN || '';
  const perCategory = process.env.CONTENT_PER_CATEGORY || '50';

  // 1. 抓取国内源（SOURCES=cn），产出 public/data/cn.json
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'fetch-data.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
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
    return { ok: false, stage: 'fetch', message: (r.stderr || '').slice(0, 300), ms: Date.now() - started };
  }

  // 2. 读取产物
  let text = '';
  try { text = await readFile(DATA_PATH, 'utf8'); }
  catch (e) { return { ok: false, stage: 'read', message: String(e.message || e), ms: Date.now() - started }; }
  let items = 0;
  try { items = (JSON.parse(text).items || []).length; }
  catch { return { ok: false, stage: 'parse', message: 'cn.json 不是合法 JSON', ms: Date.now() - started }; }

  // 3. 写入仓库（无 git 工作区，走平台 API）
  let published = { ok: false, status: 0, message: 'DATA_TOKEN 未配置，跳过发布' };
  if (token) {
    published = await putFile({
      platform,
      owner,
      repo,
      branch,
      path: 'public/data/cn.json',
      content: text,
      message: `chore(data): cn news ${new Date().toISOString().slice(0, 13)}:00 UTC`,
      token,
    });
  }

  // 4. 刷新 jsDelivr（可选）
  let purged = 'skipped';
  if (process.env.PURGE_JSDELIVR === '1') {
    try {
      const resp = await fetch(`https://purge.jsdelivr.net/gh/${owner}/${repo}@${branch}/public/data/cn.json`);
      purged = resp.ok ? 'ok' : ('fail ' + resp.status);
    } catch (e) { purged = 'fail: ' + (e.message || e); }
  }

  return {
    ok: published.ok,
    stage: 'done',
    items,
    published,
    purged,
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
