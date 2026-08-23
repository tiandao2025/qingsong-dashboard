/**
 * sync-data.js - 定时抓取 YouTube / Bilibili 真实数据，输出到 data/*.json
 * 供 GitHub Actions 定时执行（也可本地 node sync-data.js 手动运行）
 * 配置通过环境变量注入：
 *   YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN   YouTube OAuth
 *   BILI_UID / BILI_COOKIE                               Bilibili 公开数据
 *   YT_VIDEO_MAX / BILI_VIDEO_MAX / BILI_COMMENT_VIDEOS  抓取数量
 * 输出：
 *   data/status.json            平台接入状态 + 频道/UP主信息
 *   data/youtube.json           YouTube 频道统计 + 视频列表
 *   data/bilibili.json          Bilibili 用户统计 + 视频列表
 *   data/youtube-comments.json  最新视频评论（前 YT_VIDEO_MAX 个视频）
 *   data/bilibili-comments.json 前 BILI_COMMENT_VIDEOS 个视频的评论
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const OUT_DIR = path.join(__dirname, 'data');
const ENV = {
  YT_CLIENT_ID: process.env.YT_CLIENT_ID || '',
  YT_CLIENT_SECRET: process.env.YT_CLIENT_SECRET || '',
  YT_REFRESH_TOKEN: process.env.YT_REFRESH_TOKEN || '',
  BILI_UID: (process.env.BILI_UID || '').trim(),
  BILI_COOKIE: (process.env.BILI_COOKIE || '').trim(),
  YT_VIDEO_MAX: Number(process.env.YT_VIDEO_MAX || 20),
  BILI_VIDEO_MAX: Number(process.env.BILI_VIDEO_MAX || 20),
  BILI_COMMENT_VIDEOS: Number(process.env.BILI_COMMENT_VIDEOS || 5)
};

const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ================= 通用工具 ================= */
function ensureOutDir() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}
function writeJson(name, obj) {
  ensureOutDir();
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj, null, 2), 'utf8');
  console.log('[ok] data/' + name);
}

/* ================= Bilibili（公开接口 + wbi 签名） ================= */
function biliFetch(url, referer) {
  const headers = ['User-Agent: ' + BILI_UA];
  if (referer) headers.push('Referer: ' + referer);
  if (ENV.BILI_COOKIE) headers.push('Cookie: ' + ENV.BILI_COOKIE);
  // 优先系统 curl（Linux/macOS 自带），失败降级 node fetch
  try {
    const args = ['-s', '-m', '20', url, ...headers.map(h => ['-H', h]).flat()];
    const out = execFileSync('curl', args, { maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
    return JSON.parse(out);
  } catch (e) {
    // fallback
  }
  return fetch(url, {
    headers: {
      'User-Agent': BILI_UA,
      ...(referer ? { Referer: referer } : {}),
      ...(ENV.BILI_COOKIE ? { Cookie: ENV.BILI_COOKIE } : {})
    }
  }).then(r => r.json());
}

const mixinKeyEncTab = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
function getMixinKey(orig) {
  return mixinKeyEncTab.map(n => orig[n]).join('').slice(0, 32);
}
async function getWbiKeys() {
  const data = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
  if (data.code !== 0) throw new Error('获取wbi密钥失败: ' + (data.message || data.code));
  const imgUrl = data.data.wbi_img.img_url;
  const subUrl = data.data.wbi_img.sub_url;
  return {
    imgKey: imgUrl.slice(imgUrl.lastIndexOf('/') + 1).split('.')[0],
    subKey: subUrl.slice(subUrl.lastIndexOf('/') + 1).split('.')[0]
  };
}
function wbiSign(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const wts = Math.round(Date.now() / 1000);
  const query = { ...params, wts };
  const queryStr = Object.keys(query).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
  return queryStr + '&w_rid=' + crypto.createHash('md5').update(queryStr + mixinKey).digest('hex');
}

async function biliUserInfo(keys) {
  const mid = ENV.BILI_UID;
  const signed = wbiSign({ mid }, keys.imgKey, keys.subKey);
  const [info, stat] = await Promise.all([
    biliFetch('https://api.bilibili.com/x/space/acc/info?' + signed, 'https://space.bilibili.com/' + mid),
    biliFetch('https://api.bilibili.com/x/relation/stat?vmid=' + mid, 'https://space.bilibili.com/' + mid)
  ]);
  let acc = info.code === 0 ? info.data : null;
  let videoCount = 0;
  if (!acc && info.code === -799) {
    // 查询的是登录账号本人时，用 nav 接口兜底
    const nav = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
    if (nav.code === 0 && String(nav.data?.mid) === mid) {
      acc = nav.data;
      const signed2 = wbiSign({ mid, ps: 1, pn: 1, order: 'pubdate', platform: 'web' }, keys.imgKey, keys.subKey);
      const arc = await biliFetch('https://api.bilibili.com/x/space/wbi/arc/search?' + signed2, 'https://space.bilibili.com/' + mid);
      if (arc.code === 0) videoCount = Number(arc.data?.page?.count || 0);
    }
  }
  if (!acc) throw new Error('B站用户信息获取失败: ' + (info.message || info.code));
  return {
    mid: Number(mid),
    name: acc.name || acc.uname || '',
    face: acc.face || '',
    sign: acc.sign || '',
    followers: Number(stat.data?.follower || 0),
    following: Number(stat.data?.following || 0),
    videoCount: videoCount || Number(acc.videos || 0),
    viewCount: Number(stat.data?.view || 0),
    likeCount: Number(stat.data?.like || 0)
  };
}

async function biliVideos(keys, max) {
  const mid = ENV.BILI_UID;
  const signed = wbiSign({ mid, ps: max, pn: 1, order: 'pubdate', platform: 'web' }, keys.imgKey, keys.subKey);
  const data = await biliFetch('https://api.bilibili.com/x/space/wbi/arc/search?' + signed, 'https://space.bilibili.com/' + mid);
  if (data.code !== 0) throw new Error('B站视频列表获取失败: ' + (data.message || data.code));
  return (data.data?.list?.vlist || []).map(v => ({
    id: String(v.bvid),
    title: v.title,
    publishedAt: new Date(v.created * 1000).toISOString(),
    thumb: (v.pic || '').replace(/^http:/i, 'https:'),
    views: Number(v.play || 0),
    likes: Number(v.like || 0),
    comments: Number(v.comment || 0)
  }));
}

async function biliComments(bvid, max = 30) {
  const info = await biliFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, 'https://www.bilibili.com/video/' + bvid);
  if (info.code !== 0) throw new Error('视频信息获取失败: ' + (info.message || info.code));
  const aid = info.data.aid;
  const data = await biliFetch('https://api.bilibili.com/x/v2/reply/main?type=1&oid=' + aid + '&mode=3&ps=' + max, 'https://www.bilibili.com/video/' + bvid);
  if (data.code !== 0) throw new Error('B站评论获取失败: ' + (data.message || data.code));
  return (data.data?.replies || []).map(r => ({
    id: 'bili-' + r.rpid,
    author: r.member?.uname || '',
    avatar: (r.member?.avatar || '').replace(/^http:/i, 'https:'),
    text: r.content?.message || '',
    publishedAt: new Date(r.ctime * 1000).toISOString(),
    likeCount: Number(r.like || 0),
    videoId: bvid,
    videoTitle: info.data.title || '',
    replyCount: Number(r.rcount || 0)
  }));
}

/* ================= YouTube（OAuth + API） ================= */
async function ytGetAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: ENV.YT_CLIENT_ID,
      client_secret: ENV.YT_CLIENT_SECRET,
      refresh_token: ENV.YT_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (data.error) throw new Error('YT Token 刷新失败: ' + (data.error_description || data.error));
  return data.access_token;
}
async function ytFetch(pathname, params, token) {
  const url = new URL('https://www.googleapis.com/youtube/v3' + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || ('YouTube API 错误 ' + res.status));
  return data;
}
async function ytChannelStats(token) {
  const data = await ytFetch('/channels', { part: 'snippet,statistics,contentDetails', mine: true }, token);
  const ch = data.items && data.items[0];
  if (!ch) throw new Error('未找到 YouTube 频道');
  return {
    id: ch.id,
    title: ch.snippet.title,
    thumb: ch.snippet.thumbnails?.default?.url || '',
    subscribers: Number(ch.statistics.subscriberCount || 0),
    videoCount: Number(ch.statistics.videoCount || 0),
    viewCount: Number(ch.statistics.viewCount || 0),
    uploadsPlaylist: ch.contentDetails.relatedPlaylists.uploads
  };
}
async function ytVideos(channel, token, max) {
  const data = await ytFetch('/playlistItems', { part: 'snippet', playlistId: channel.uploadsPlaylist, maxResults: max }, token);
  const items = (data.items || []).filter(i => i.snippet.resourceId);
  const videoIds = items.map(i => i.snippet.resourceId.videoId).join(',');
  let statsMap = {};
  if (videoIds) {
    const stats = await ytFetch('/videos', { part: 'statistics,snippet', id: videoIds }, token);
    statsMap = Object.fromEntries((stats.items || []).map(v => [v.id, v]));
  }
  return items.map(i => {
    const vid = i.snippet.resourceId.videoId;
    const st = statsMap[vid]?.statistics || {};
    return {
      id: vid,
      title: i.snippet.title,
      publishedAt: i.snippet.publishedAt,
      thumb: i.snippet.thumbnails?.medium?.url || '',
      views: Number(st.viewCount || 0),
      likes: Number(st.likeCount || 0),
      comments: Number(st.commentCount || 0)
    };
  });
}
async function ytComments(token, videoId = '', max = 30) {
  const params = { part: 'snippet', maxResults: max, textFormat: 'plainText' };
  if (videoId) params.videoId = videoId;
  const data = await ytFetch('/commentThreads', params, token);
  return (data.items || []).map(t => {
    const s = t.snippet.topLevelComment.snippet;
    return {
      id: t.id,
      author: s.authorDisplayName,
      avatar: s.authorProfileImageUrl || '',
      text: s.textDisplay,
      publishedAt: s.publishedAt,
      likeCount: s.likeCount,
      videoId: s.videoId,
      videoTitle: s.videoTitle || '',
      replyCount: t.snippet.totalReplyCount || 0
    };
  });
}

/* ================= 主流程 ================= */
(async () => {
  const results = { youtube: null, bilibili: null };
  const now = new Date().toISOString();
  const status = { updated_at: now };

  // ---- YouTube ----
  if (ENV.YT_CLIENT_ID && ENV.YT_CLIENT_SECRET && ENV.YT_REFRESH_TOKEN) {
    try {
      const token = await ytGetAccessToken();
      const channel = await ytChannelStats(token);
      const videos = await ytVideos(channel, token, ENV.YT_VIDEO_MAX);
      results.youtube = { channel, videos };
      writeJson('youtube.json', results.youtube);
      status.youtube = { authorized: true, channel };
      // 评论：前 3 个视频
      let comments = [];
      for (const v of videos.slice(0, 3)) {
        try {
          const cs = await ytComments(token, v.id);
          comments = comments.concat(cs);
        } catch (e) { console.warn('[yt-comments] skip', v.id, e.message); }
      }
      writeJson('youtube-comments.json', { comments });
    } catch (e) {
      console.error('[yt] 抓取失败:', e.message);
      status.youtube = { authorized: false, error: e.message };
    }
  } else {
    status.youtube = { authorized: false, error: '未配置 YouTube 环境变量' };
  }

  // ---- Bilibili ----
  if (ENV.BILI_UID) {
    try {
      const keys = await getWbiKeys();
      const channel = await biliUserInfo(keys);
      const videos = await biliVideos(keys, ENV.BILI_VIDEO_MAX);
      results.bilibili = { channel, videos };
      writeJson('bilibili.json', results.bilibili);
      status.bilibili = { mode: '公开数据（线上定时同步）', configured: true, authorized: true, channel };
      // 评论：前 N 个视频
      let comments = [];
      for (const v of videos.slice(0, ENV.BILI_COMMENT_VIDEOS)) {
        try {
          const cs = await biliComments(v.id);
          comments = comments.concat(cs);
        } catch (e) { console.warn('[bili-comments] skip', v.id, e.message); }
      }
      writeJson('bilibili-comments.json', { comments });
    } catch (e) {
      console.error('[bili] 抓取失败:', e.message);
      status.bilibili = { mode: '公开数据（线上定时同步）', configured: true, authorized: false, error: e.message };
    }
  } else {
    status.bilibili = { configured: false, authorized: false };
  }

  writeJson('status.json', status);
  console.log('[done]', now);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
