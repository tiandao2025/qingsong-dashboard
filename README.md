# 青松设计 · 短视频多平台数据集合后台

为青松设计（6 平台运营）提供的数据集合后台网页，支持查看各平台数据、用户画像、评论管理与回复。

## 功能

- 总览仪表盘：粉丝/播放/评论核心指标
- 平台 Tab：YouTube / 抖音 / 小红书 / 快手 / 微信视频号 / Bilibili
- 用户画像：年龄、性别、地域、活跃时段（Chart.js）
- 评论管理：按平台筛选、待回复/已回复切换、回复交互
- B 站接入：公开数据模式（方案A），登录态 Cookie 拉取真实数据

## 文件说明

| 文件 | 说明 |
|------|------|
| `index.html` | 前端页面（单文件 + Chart.js CDN，深色科技风） |
| `LOGO.png` | 页面左上角品牌 LOGO |
| `yt-server.js` | 本地 Node 服务（端口 8080）：YouTube OAuth + API 代理、B站公开数据（curl.exe + wbi + 缓存）、静态托管 |

## 本地运行

```bash
cd qingsong-dashboard
node yt-server.js
```

打开 http://localhost:8080

配置文件 `yt-config.json`（已被 .gitignore 排除，不入库）：

```json
{
  "client_id": "...",
  "client_secret": "...",
  "api_key": "...",
  "bilibili_uid": "...",
  "bilibili_cookie": "..."
}
```

## 部署

静态部署：`wrangler pages deploy . --project-name qingsong-dashboard`
（页面数据为示例/缓存，接口能力依赖本地 yt-server.js）
