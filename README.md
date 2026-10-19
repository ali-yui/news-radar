# 资讯雷达 News Radar

> **在线部署实例**：仓库 https://github.com/ali-yui/news-radar（已部署），Actions 每天北京时间 09:00 自动抓取。
> App 已预填的远程数据地址：
> - `https://cdn.jsdelivr.net/gh/ali-yui/news-radar@main/public/data/daily.json`（国内优先）
> - `https://raw.githubusercontent.com/ali-yui/news-radar/main/public/data/daily.json`（备用）
> 网页版：https://ali-yui.github.io/news-radar/


一个零后端、零付费密钥的新闻检索 App。数据由 **GitHub Actions 定时抓取**公开 RSS/API 生成 `public/data/daily.json`，前端为原生 HTML/CSS/JS 单页应用，直接读取 JSON 渲染。

四个 Tab：**今天**（军事 / 科技 / 民生 / 金融 热点）、**AI 圈**（GitHub 动态、AI Agent/MCP、Hacker News、Reddit、行业报道）、**娱乐圈**、**设置**。

## 功能清单

- 今日更新：按时间倒序展示，默认近 24 小时，更早内容归入「更早」分组
- 关键词搜索（标题 / 摘要 / 标签 / 来源）与来源筛选
- 每条资讯：标题、来源、发布时间、摘要、原文链接、标签、已读状态
- 去重：同一链接（剔除 utm 等跟踪参数后）、相同标题、标题 bigram 相似度 ≥ 0.82 均只保留一条
- 收藏、已读状态保存在浏览器 localStorage
- 手动刷新按钮；前端每天北京时间 09:00 后首次打开自动拉取一次
- 浅色 / 暗色 / 跟随系统三种主题
- 数据更新失败时显示上次缓存并提示失败原因（抓取错误随 daily.json 一并返回）
- 设置页：一键复制报错、GitHub Token（可选）、远程数据地址（国内网络推荐填 Gitee）、豆包 API（可选，默认不启用）
- 英文资讯卡片带「译」按钮：一键经百度整页翻译打开中文译文（`fanyi.baidu.com/transpage`，国内可访问）
- AI 圈内置 **GitHub Trending 日榜 / 周榜 / 月榜**，浮层一键查看，本地缓存 6 小时
- 直接双击 `index.html` 也能用（数据已内联到 `assets/data-bundle.js`）；APK 未配置远程地址时静默使用内置数据，不刷错误

## 目录结构

```
news-radar/
├── index.html
├── assets/
│   ├── style.css
│   ├── app.js            # 界面、状态、渲染、缓存
│   ├── live.js           # 浏览器端手动刷新（CORS 友好的源）
│   ├── trending.js       # GitHub Trending 日/周/月榜浮层
│   ├── doubao.js         # 豆包 AI 摘要（可选，默认不启用）
│   └── data-bundle.js    # 抓取脚本生成的内联数据（离线/直开兜底）
├── public/data/
│   └── daily.json        # GitHub Actions 定时生成的数据
├── scripts/
│   └── fetch-data.mjs    # 零依赖抓取脚本（Node >= 18）
└── .github/workflows/
    └── daily.yml         # 每天 UTC 01:00（北京 09:00）运行
```

## 部署（GitHub Pages，5 分钟）

1. 新建 GitHub 仓库，把本目录全部文件推到 `main` 分支
2. 仓库 **Settings → Pages → Build and deployment → Deploy from a branch**，选 `main` / 根目录
3. Actions 会自动运行，提交 `public/data/daily.json`，Pages 自动发布
4. 之后每天北京时间 09:00 自动更新；也可在 **Actions → daily-news → Run workflow** 手动触发
5. GitHub REST 限流无需配置即可使用；Actions 内置 `GITHUB_TOKEN` 会自动注入，把限流提升到 1000 次/小时

本地预览：`npx serve .` 或 `python3 -m http.server` 后访问（`file://` 直开也可，此时用内联数据，无法实时拉取 daily.json）。

## 国内网络 / APK 每日更新（Gitee 同步，推荐）

APK 内置的是打包时的数据，每天 09:00 自动更新需要一个**国内可访问的远程数据地址**。GitHub / raw.githubusercontent 在国内不稳定，推荐用 Gitee 的 raw 文件：

1. Gitee 新建仓库 `news-radar`（建议直接选「导入已有仓库」，填入 GitHub 地址，保持 `main` 分支一致）
2. Gitee 头像 → 设置 → 私人令牌，新建一个勾选 `projects` 权限的令牌
3. 回到 GitHub 仓库 **Settings → Secrets and variables → Actions**：
   - 新增 Secret `GITEE_TOKEN`，值为 Gitee 令牌（可选，不配则只在 GitHub 内更新）
   - 若仓库路径不是 `yuihl/news-radar`，在 Variables 里加 `GITEE_REPO=你的用户名/news-radar`
4. 之后每天 Actions 抓取完会自动把数据推到 Gitee；手机打开 App → **设置 → 远程数据地址**填入：
   `https://gitee.com/yuihl/news-radar/raw/main/public/data/daily.json`
   保存后手动刷新一次即可；每天 09:00 后首次打开也会自动拉取。

> 手动刷新时浏览器端还会实时拉取 GitHub API（api.github.com）与 Hacker News（hn.algolia.com）；Reddit、Google News、Bing News 在国内不可达，脚本会自动跳过并在诊断中标记，不影响其他源。

### 已内置的国内源（免翻墙）

36氪、36氪快讯、量子位、InfoQ 中文、SegmentFault、IT之家、Solidot、少数派、中新网（财经/社会/国际）、知乎日报、百度热搜、百度电影榜、百度电视剧榜、B站热门、GitHub Trending RSS（GitHub Pages）。这些源在 Actions 抓取后进入 daily.json，App 经 Gitee 即可每天更新。

## 数据源说明

> 全部为公开、免登录、无需付费密钥的源；抓取脚本对每个源做了超时、重试与降级，单源失败不影响整体。

### 1. GitHub（REST API 主用，Atom 降级）

| 项 | 内容 |
| --- | --- |
| 地址 | `https://api.github.com/repos/morluto/rea/releases`、`/commits?per_page=20`、`/issues?state=all&per_page=20`；相关仓库 `GET /users/morluto/repos?per_page=100&sort=pushed`，再对 `rea` / `rea-*` 仓库取 `/commits?per_page=3` |
| 参数 | Header `Accept: application/vnd.github+json`；有 token 时带 `Authorization: Bearer <token>` |
| 字段映射 | releases: `tag_name/name→标题`、`html_url→链接`、`published_at→时间`、`body→摘要`；commits: `commit.message→标题/摘要`、`html_url→链接`、`commit.committer.date→时间`；issues: `title→标题`、`html_url→链接`、`updated_at→时间`、`body→摘要`（PR 已过滤） |
| 限流 | 未认证 60 次/小时/IP；带 Actions 内置 token 后 1000 次/小时；脚本一次运行约 15~20 次请求 |
| 失败降级 | REST 被限流（403/429）时自动切换官方公开 Atom：`/morluto/rea/releases.atom`、`commits.atom`、`issues.atom`；相关仓库改从 `github.com/morluto?tab=repositories` 页面解析 `rea-*` 仓库名后取各自 `commits.atom`。Atom 不受 REST 限流影响 |

### 2. Hacker News（Algolia 搜索 API）

| 项 | 内容 |
| --- | --- |
| 地址 | `https://hn.algolia.com/api/v1/search_by_date` |
| 参数 | `query=REA / reverse engineering / AI agent / MCP / Ghidra / JADX`、`tags=story`、`hitsPerPage=20`、`numericFilters=created_at_i>{7天前时间戳}` |
| 字段映射 | `title→标题`、`url→原文链接`（为空时用 `news.ycombinator.com/item?id=objectID`）、`created_at→时间`、`story_text→摘要`、`author/points→标签` |
| 限流 | 官方公开 API、无需密钥；脚本并发 6 个请求、每个间隔 180ms，远低于其承载 |
| 失败降级 | 失败则记录错误并跳过（旧数据保留在缓存）；备用源为 HN 官方 Firebase API（`hacker-news.firebaseio.com/v0/topstories.json`，可自行扩展） |

### 3. Reddit（JSON 主用，RSS 降级）

| 项 | 内容 |
| --- | --- |
| 地址 | `https://www.reddit.com/r/{sub}/new.json?limit=20`；AI 类：`ReverseEngineering`、`netsec`、`LocalLLaMA`、`MachineLearning`、`artificial`、`singularity`；娱乐类：`entertainment`、`movies`、`television`、`Fauxmoi` |
| 字段映射 | `data.children[].data`：`title`、`is_self?permalink:url`（自建贴用永久链接）、`created_utc→时间`、`selftext→摘要`、`subreddit→来源` |
| 限流 | 匿名建议 ≤ 10 次/分钟；数据中心 IP 可能遇到 429；脚本并发 5 |
| 失败降级 | JSON 失败时改取 `https://www.reddit.com/r/{sub}/new.rss?limit=20`；再失败则跳过该板块并记录错误 |

### 4. Google News RSS（主用新闻源）

| 项 | 内容 |
| --- | --- |
| 地址 | `https://news.google.com/rss/search?q={关键词+when:2d}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`（英文词用 `hl=en-US&gl=US&ceid=US:en`） |
| 参数 | 今天：军事 / 科技 / 民生 / 金融；AI 圈：AI Agent / MCP 大模型 / 人工智能 / reverse engineering AI agent / Ghidra JADX / MCP model context protocol；娱乐圈：娱乐 / 明星 / 电影 / 电视剧 / 综艺 / 音乐 |
| 字段映射 | `<title>→标题`（自动去掉末尾来源后缀）、`<link>→原文链接`（Google News 跳转链接，打开即到原文）、`<pubDate>→时间`、`<description>→摘要`、`<source>→来源` |
| 限流 | 官方公开 RSS、无密钥；脚本并发 4、间隔 300ms；数据中心 IP 偶尔 429 |
| 失败降级 | 单个关键词失败自动改 Bing News RSS；整源失败时前端继续展示上次缓存 |

### 5. Bing News RSS（Google News 降级源）

| 项 | 内容 |
| --- | --- |
| 地址 | `https://www.bing.com/news/search?q={关键词}&format=RSS&mkt=zh-CN`（英文用 `mkt=en-US`） |
| 字段映射 | 同 RSS：`<title>`、`<link>`、`<pubDate>`、`<description>`、`<source>` |
| 限流 | 公开 RSS、无密钥；注意部分地区会把 `www.bing.com` 重定向到 `cn.bing.com` 且不再返回 RSS（脚本会校验返回体必须是 XML，否则判失败） |
| 失败降级 | 记录错误，由缓存兜底；可再换 Google News 英文频道或其他 RSS |

### 6. GitHub Trending RSS（社区维护，补充开源动态）

| 项 | 内容 |
| --- | --- |
| 地址 | `https://mshibanami.github.io/GitHubTrendingRSS/{daily,weekly,monthly}/all.xml`（抓取脚本取日榜；App 内「Trending 榜单」按日/周/月实时拉取） |
| 字段映射 | `<title>（owner/repo）+<description>→标题/摘要`、`<link>→仓库链接`、频道 `<pubDate>→时间`（条目无独立日期时兜底）；description 第一段 `<p>` 为仓库简介 |
| 限流 | GitHub Pages 静态托管，返回 `Access-Control-Allow-Origin: *`，浏览器可直接跨域读取，国内可访问 |
| 失败降级 | 改用 GitHub 搜索 API `search/repositories?q=created:>{日期}&sort=stars`（REST 可用时）；App 端降级显示本地缓存 |

### 7. 中文补充源（公开 RSS / JSON）

| 源 | 地址 | 分类 | 说明 |
| --- | --- | --- | --- |
| IT之家 | `https://www.ithome.com/rss/` | 今天·科技 | RSS，30 条 |
| 中新网财经 | `https://www.chinanews.com.cn/rss/finance.xml` | 今天·金融 | RSS |
| 中新网社会 | `https://www.chinanews.com.cn/rss/society.xml` | 今天·民生 | RSS |
| 中新网国际 | `https://www.chinanews.com.cn/rss/world.xml` | 今天·军事/国际 | RSS |
| Solidot | `https://www.solidot.org/index.rss` | AI 圈·科技行业 | RSS，安全/AI 报道多 |
| 少数派 | `https://sspai.com/feed` | 今天·科技 | RSS |
| 36氪 | `https://www.36kr.com/feed` | AI 圈/今天 | RSS；AI 相关归入 AI 圈，其余归今天 |
| 36氪快讯 | `https://www.36kr.com/feed-newsflash` | 今天·滚动快讯 | RSS |
| 量子位 | `https://www.qbitai.com/feed` | AI 圈·AI | RSS |
| InfoQ 中文 | `https://www.infoq.cn/feed` | AI 圈·技术 | RSS |
| SegmentFault | `https://segmentfault.com/feeds` | AI 圈·开发社区 | Atom，仅保留 AI/开发相关条目 |
| 知乎日报 | `https://news-at.zhihu.com/api/4/news/latest` | 今天·热点 | 公开 JSON，无时间戳，标记为热榜 |
| 百度热搜 | `https://top.baidu.com/api/board?platform=pc&tab=realtime` | 今天·热点（娱乐相关跨挂娱乐圈） | 公开 JSON，带 `desc` 摘要 |
| 百度电影榜 | `https://top.baidu.com/api/board?platform=pc&tab=movie` | 娱乐圈·电影 | 公开 JSON |
| 百度电视剧榜 | `https://top.baidu.com/api/board?platform=pc&tab=teleplay` | 娱乐圈·电视剧 | 公开 JSON |
| B站热门 | `https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1` | 娱乐圈 | 公开 JSON，仅保留影视/娱乐/音乐/动画等分区 |

以上补充源均为页面实际使用的公开接口；任一失败自动跳过。`scripts/fetch-data.mjs` 中可用 `SKIP_源名=1` 跳过（如 `SKIP_REDDIT=1`）。

## 数据文件结构

```json
{
  "version": 1,
  "generatedAt": "ISO 时间",
  "generatedAtBeijing": "北京时间字符串",
  "stats": { "total": 0, "byCategory": { "today": 0, "ai": 0, "ent": 0 }, "bySource": {} },
  "sourceStatus": [{ "source": "github", "ok": true, "mode": "rest|atom", "items": 0, "error": null }],
  "errors": [{ "source": "reddit", "stage": "request", "message": "HTTP 429", "at": "..." }],
  "items": [{
    "id": "n…", "category": "today|ai|ent", "source": "…", "sourceType": "github|hn|reddit|googleNews|bing|rss|json",
    "title": "", "url": "", "publishedAt": "ISO", "publishedAtMs": 0,
    "summary": "标题+来源+原文摘录规则生成", "tags": [], "hot": false
  }]
}
```

## 豆包 API（可选，默认不启用）

设置页填入「火山方舟 / 豆包」OpenAI 兼容接口信息并开启后，资讯卡片会出现「AI 摘要」按钮：

- 接口：`POST {baseUrl}/chat/completions`，默认 `https://ark.cn-beijing.volces.com/api/v3`
- 模型：填入推理接入点 ID（如 `ep-xxxx`）或模型名
- 密钥仅保存在本地浏览器 localStorage，随请求发送，不经任何第三方
- 不开启时完全使用本地规则摘要，不产生任何费用

## 手动刷新说明

- 顶部刷新按钮：先按「设置的远程数据地址 → 同目录 `public/data/daily.json`」顺序拉取，再在浏览器端直接请求 GitHub API、HN Algolia（均支持跨域）做增量合并；RSS 源因浏览器跨域限制以 Actions 产物为准
- AI 圈的「Trending 日/周/月榜」是浏览器端实时拉取 GitHub Pages RSS（支持跨域），与刷新无关，随时点开即看，缓存 6 小时
- 每天北京时间 09:00 后首次打开会自动刷新一次；失败保留缓存并在顶部提示原因
- 英文文章点卡片上的「译」按钮，经百度整页翻译（`https://fanyi.baidu.com/transpage?query={原文URL}&source=url&from=en&to=zh`）打开中文译文，在系统浏览器中显示
