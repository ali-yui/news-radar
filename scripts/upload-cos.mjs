#!/usr/bin/env node
/**
 * 上传本地文件到腾讯云 COS（供 GitHub Actions / 命令行使用）
 * ---------------------------------------------------------------
 * 用法：
 *   node scripts/upload-cos.mjs public/data/daily.json data/daily.json
 *   node scripts/upload-cos.mjs public/data/daily.json        # key 默认 data/<文件名>
 *
 * 环境变量：COS_BUCKET / COS_REGION，密钥二选一：
 *   长期密钥  COS_SECRET_ID / COS_SECRET_KEY
 *   临时凭证  平台注入的 TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY / TENCENTCLOUD_SESSIONTOKEN
 *   （TENCENTCLOUD_ 前缀是腾讯云 SCF 的保留字，自定义变量不能再用，但平台注入的临时凭证正是这个名字）
 *
 * 退出码：0 成功或「未配置而跳过」；1 上传失败。
 *   未配置时按 0 退出，是为了让 COS 成为可选项——数据照常提交到 GitHub，
 *   只是不额外分发到对象存储。
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { putObject, cosConfigFromEnv, isCosConfigured, publicUrl } from './lib/cos.mjs';

const [file, keyArg] = process.argv.slice(2);

if (!file) {
  console.error('用法：node scripts/upload-cos.mjs <本地文件> [对象 key]');
  process.exit(1);
}

const cfg = cosConfigFromEnv();
if (!isCosConfigured(cfg)) {
  console.log('[cos] 未配置 COS_BUCKET / COS_REGION 或密钥（长期密钥或运行角色临时凭证），跳过上传');
  process.exit(0);
}

const key = keyArg || `data/${basename(file)}`;

try {
  const body = await readFile(file);
  const r = await putObject({ ...cfg, key, body });
  if (r.ok) {
    console.log(`[cos] 上传成功：${r.url}（${(body.length / 1024).toFixed(1)} KB）`);
    process.exit(0);
  }
  console.error(`[cos] 上传失败：${r.message}`);
  process.exit(1);
} catch (e) {
  console.error('[cos] 上传异常：', e && e.message ? e.message : e);
  process.exit(1);
}
