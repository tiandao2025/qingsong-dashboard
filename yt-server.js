/**
 * 青松设计短视频多平台数据后台 - YouTube 接入服务
 * 功能：OAuth 授权、Token 管理、YouTube 数据 API 代理、托管后台页面
 * 启动：node yt-server.js
 * 说明：Client Secret 只保存在本服务中，不会暴露到前端页面
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CONFIG_PATH = path.join(__dirname, 'yt-config.json');
const TOKEN_PATH = path.join(__dirname, 'yt-token.json');
const PORT = 8080;

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error('缺少 yt-config.json，请先创建配置文件');
  process.exit(1);
}

const { client_id, client_secret, api_key, bilibili_uid = '', bilibili_cookie = '' } = config;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl'
].join(' ');

/* ---------- Token 管理 ---------- */
function readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; }
}
function writeToken(t) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2));
}

async function getAccessToken() {
  let token = readToken();
  if (!token) return null;
  if (Date.now() < (token.expires_at || 0)) return token.access_token;
  // access_token 过期，用 refresh_token 刷新
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id,
      client_secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (data.error) throw new Error('刷新Token失败: ' + (data.error_description || data.error));
  data.refresh_token = token.refresh_token;
  data.expires_at = Date.now() + data.expires_in * 1000 - 60000;
  writeToken(data);
  return data.access_token;
}

/* ---------- 通用请求（带超时） ---------- */
async function fetchTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- YouTube API 封装 ---------- */
async function ytFetch(pathname, params = {}, method = 'GET', body = null) {
  const accessToken = await getAccessToken();
  const url = new URL('https://www.googleapis.com/youtube/v3' + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchTimeout(url, {
    method,
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || ('YouTube API 错误 ' + res.status));
  return data;
}

/* ---------- 业务接口 ---------- */
async function getChannelStats() {
  const data = await ytFetch('/channels', {
    part: 'snippet,statistics,contentDetails',
    mine: true
  });
  const ch = data.items && data.items[0];
  if (!ch) throw new Error('未找到频道，请确认已绑定 YouTube 频道');
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

async function getVideos(uploadsPlaylist, max = 20) {
  const data = await ytFetch('/playlistItems', {
    part: 'snippet',
    playlistId: uploadsPlaylist,
    maxResults: max
  });
  const items = (data.items || []).filter(i => i.snippet.resourceId);
  const videoIds = items.map(i => i.snippet.resourceId.videoId).join(',');
  let statsMap = {};
  if (videoIds) {
    const stats = await ytFetch('/videos', { part: 'statistics,snippet', id: videoIds });
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

async function getComments(videoId = '', max = 30) {
  const params = { part: 'snippet', maxResults: max, textFormat: 'plainText' };
  if (videoId) params.videoId = videoId;
  const data = await ytFetch('/commentThreads', params);
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

async function replyComment(text, videoId, commentId) {
  const data = await ytFetch('/comments', {
    part: 'snippet'
  }, 'POST', {
    snippet: {
      textOriginal: text,
      videoId,
      parentId: commentId
    }
  });
  return data;
}

/* ================= Bilibili 接入模块（公开数据模式，方案A：无需认证，可看数据与评论，不支持回复） ================= */
function biliConfigReady() {
  return !!(bilibili_uid);
}

// B站公开接口需先访问主站拿 buvid3/b_nut cookie 才能过风控；
// Node fetch 的 TLS 指纹会被 B 站风控拦截（-799），故改用系统 curl.exe 发请求
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BILI_COOKIE_JAR = path.join(__dirname, '.bili-cookies.txt');
const BILI_COOKIE_STR = (bilibili_cookie || '').trim();
let biliCookieReady = false;
let biliCookieTime = 0;
// B站接口结果缓存（本地后台无需实时，缓存降低请求频率避免限流）
const biliCache = {
  user: { data: null, time: 0, ttl: 5 * 60 * 1000 },
  wbi: { data: null, time: 0, ttl: 2 * 60 * 60 * 1000 },
  videos: new Map(),   // key: mid:max
  comments: new Map()  // key: bvid:max
};
function biliFetch(url, referer) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-m', '15', url, '-H', 'User-Agent: ' + BILI_UA];
    if (referer) args.push('-H', 'Referer: ' + referer);
    if (BILI_COOKIE_STR) args.push('-H', 'Cookie: ' + BILI_COOKIE_STR);
    else if (fs.existsSync(BILI_COOKIE_JAR)) args.push('-b', BILI_COOKIE_JAR);
    execFile('curl.exe', args, { maxBuffer: 5 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      let data;
      try { data = JSON.parse(stdout); } catch (e) { return reject(new Error('B站响应解析失败: ' + stdout.slice(0, 200))); }
      resolve(data);
    });
  });
}
async function ensureBiliCookie() {
  // 已配置登录态 Cookie（yt-config.json -> bilibili_cookie）时直接就绪，优先于 jar 模式
  if (BILI_COOKIE_STR) {
    biliCookieReady = true;
    biliCookieTime = Date.now();
    return;
  }
  // jar 已存在且含 buvid3 时直接复用，避免频繁生成新 cookie 触发风控
  const jarExists = fs.existsSync(BILI_COOKIE_JAR) && fs.readFileSync(BILI_COOKIE_JAR, 'utf8').includes('buvid3');
  if (biliCookieReady && Date.now() - biliCookieTime < 3600 * 1000) return;
  if (jarExists) {
    biliCookieReady = true;
    biliCookieTime = Date.now();
    return;
  }
  await new Promise((resolve, reject) => {
    const args = ['-s', '-m', '15', '-c', BILI_COOKIE_JAR, 'https://www.bilibili.com/', '-H', 'User-Agent: ' + BILI_UA];
    execFile('curl.exe', args, { windowsHide: true }, (err) => {
      if (err) return reject(err);
      const jar = fs.existsSync(BILI_COOKIE_JAR) ? fs.readFileSync(BILI_COOKIE_JAR, 'utf8') : '';
      if (!jar.includes('buvid3')) return reject(new Error('获取B站cookie失败'));
      biliCookieReady = true;
      biliCookieTime = Date.now();
      resolve();
    });
  });
}
function biliCacheGet(mapOrObj, key) {
  if (mapOrObj instanceof Map) {
    const hit = mapOrObj.get(key);
    return hit && Date.now() - hit.time < hit.ttl ? hit.data : null;
  }
  return mapOrObj.data && Date.now() - mapOrObj.time < mapOrObj.ttl ? mapOrObj.data : null;
}
function biliCacheSet(mapOrObj, key, val, ttl) {
  if (mapOrObj instanceof Map) {
    mapOrObj.set(key, { data: val, time: Date.now(), ttl });
  } else {
    mapOrObj.data = val;
    mapOrObj.time = Date.now();
  }
}

// B站 wbi 签名（视频列表接口需要）
const mixinKeyEncTab = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
function getMixinKey(orig) {
  return mixinKeyEncTab.map(n => orig[n]).join('').slice(0, 32);
}
async function getWbiKeys() {
  const cached = biliCacheGet(biliCache.wbi);
  if (cached) return cached;
  await ensureBiliCookie();
  const data = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
  if (data.code !== 0) throw new Error('获取wbi密钥失败: ' + (data.message || data.code));
  const imgUrl = data.data.wbi_img.img_url;
  const subUrl = data.data.wbi_img.sub_url;
  const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1).split('.')[0];
  const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1).split('.')[0];
  const keys = { imgKey, subKey };
  biliCacheSet(biliCache.wbi, null, keys, biliCache.wbi.ttl);
  return keys;
}
function wbiSign(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const wts = Math.round(Date.now() / 1000);
  const query = { ...params, wts };
  const sorted = Object.keys(query).sort();
  const queryStr = sorted.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
  const w_rid = crypto.createHash('md5').update(queryStr + mixinKey).digest('hex');
  return queryStr + '&w_rid=' + w_rid;
}

// B站用户信息（公开接口：空间信息 + 关系统计）
async function biliUserInfo() {
  if (!bilibili_uid) throw new Error('未配置 B站 UID');
  const cached = biliCacheGet(biliCache.user);
  if (cached) return cached;
  const mid = String(bilibili_uid).trim();
  await ensureBiliCookie();
  // acc/info 新版要求 wbi 签名，否则 -799
  const { imgKey, subKey } = await getWbiKeys();
  const signed = wbiSign({ mid }, imgKey, subKey);
  const [info, stat] = await Promise.all([
    biliFetch('https://api.bilibili.com/x/space/acc/info?' + signed, 'https://space.bilibili.com/' + mid),
    biliFetch('https://api.bilibili.com/x/relation/stat?vmid=' + mid, 'https://space.bilibili.com/' + mid)
  ]);
  // acc/info 偶发 -799 风控：若查询的是登录账号本人，用 nav 接口兜底（name/face），视频数从 arc/search 补
  let acc = info.code === 0 ? info.data : null;
  let videoCount = 0;
  if (!acc && info.code === -799) {
    const nav = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
    if (nav.code === 0 && String(nav.data?.mid) === mid) {
      acc = nav.data;
      const signed2 = wbiSign({ mid, ps: 1, pn: 1, order: 'pubdate', platform: 'web' }, imgKey, subKey);
      const arc = await biliFetch('https://api.bilibili.com/x/space/wbi/arc/search?' + signed2, 'https://space.bilibili.com/' + mid);
      if (arc.code === 0) videoCount = Number(arc.data?.page?.count || 0);
    }
  }
  if (!acc) throw new Error('B站用户信息获取失败: ' + (info.message || info.code));
  const result = {
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
  biliCacheSet(biliCache.user, null, result, biliCache.user.ttl);
  return result;
}

// B站视频列表（wbi 签名公开接口，按 UP 主 UID 查询）
async function biliVideos(mid, max = 20) {
  const cacheKey = mid + ':' + max;
  const cached = biliCacheGet(biliCache.videos, cacheKey);
  if (cached) return cached;
  const { imgKey, subKey } = await getWbiKeys();
  const signed = wbiSign({ mid, ps: max, pn: 1, order: 'pubdate', platform: 'web' }, imgKey, subKey);
  const url = 'https://api.bilibili.com/x/space/wbi/arc/search?' + signed;
  await ensureBiliCookie();
  const data = await biliFetch(url, 'https://space.bilibili.com/' + mid);
  if (data.code !== 0) throw new Error('B站视频列表获取失败: ' + (data.message || data.code));
  const list = (data.data?.list?.vlist) || [];
  const result = list.map(v => ({
    id: String(v.bvid),
    title: v.title,
    publishedAt: new Date(v.created * 1000).toISOString(),
    thumb: v.pic,
    views: Number(v.play || 0),
    likes: Number(v.like || 0),
    comments: Number(v.comment || 0)
  }));
  biliCacheSet(biliCache.videos, cacheKey, result, 5 * 60 * 1000);
  return result;
}

// B站评论列表（公开接口，oId=视频 aid）
async function biliComments(bvid, max = 30) {
  const cacheKey = bvid + ':' + max;
  const cached = biliCacheGet(biliCache.comments, cacheKey);
  if (cached) return cached;
  // 先取 aid
  await ensureBiliCookie();
  const info = await biliFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, 'https://www.bilibili.com/video/' + bvid);
  if (info.code !== 0) throw new Error('视频信息获取失败: ' + (info.message || info.code));
  const aid = info.data.aid;
  const data = await biliFetch('https://api.bilibili.com/x/v2/reply/main?type=1&oid=' + aid + '&mode=3&ps=' + max, 'https://www.bilibili.com/video/' + bvid);
  if (data.code !== 0) throw new Error('B站评论获取失败: ' + (data.message || data.code));
  const replies = data.data?.replies || [];
  const result = replies.map(r => ({
    id: 'bili-' + r.rpid,
    author: r.member?.uname || '',
    avatar: r.member?.avatar || '',
    text: r.content?.message || '',
    publishedAt: new Date(r.ctime * 1000).toISOString(),
    likeCount: Number(r.like || 0),
    videoId: bvid,
    videoTitle: info.data.title || '',
    replyCount: Number(r.rcount || 0)
  }));
  biliCacheSet(biliCache.comments, cacheKey, result, 3 * 60 * 1000);
  return result;
}

/* ---------- HTTP 服务 ---------- */
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    // 静态页面
    if (p === '/' || p === '/index.html') {
      const file = path.join(__dirname, 'index.html');
      if (!fs.existsSync(file)) return sendHtml(res, 404, 'index.html 不存在');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(file).pipe(res);
    }

    // 1. 发起授权
    if (p === '/auth') {
      const state = crypto.randomBytes(16).toString('hex');
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        state
      });
      return res.writeHead(302, { Location: authUrl }).end();
    }

    // 2. 授权回调
    if (p === '/oauth2callback') {
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      if (err) return sendHtml(res, 400, '<h3>授权失败：' + err + '</h3><a href="/auth">重试</a>');
      if (!code) return sendHtml(res, 400, '<h3>缺少授权码</h3>');
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id,
          client_secret,
          code,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code'
        })
      });
      const token = await tokenRes.json();
      if (token.error) return sendHtml(res, 400, '<h3>换取Token失败：' + (token.error_description || token.error) + '</h3>');
      token.expires_at = Date.now() + token.expires_in * 1000 - 60000;
      writeToken(token);
      return sendHtml(res, 200, `<h3 style="font-family:sans-serif">✅ YouTube 授权成功！</h3><p style="font-family:sans-serif">可以关闭本页面，回到后台 <a href="/">http://localhost:${PORT}</a> 查看数据。</p>`);
    }

    // 3. 授权状态
    if (p === '/api/status') {
      const ytToken = readToken();
      let result = {
        youtube: { authorized: !!ytToken },
        bilibili: {
          mode: '公开数据（方案A）',
          configured: biliConfigReady(),
          authorized: biliConfigReady()
        }
      };
      if (ytToken) {
        try {
          const ch = await getChannelStats();
          result.youtube = { authorized: true, channel: ch };
        } catch (e) {
          result.youtube = { authorized: false, error: e.message };
        }
      }
      if (biliConfigReady()) {
        try {
          const info = await biliUserInfo();
          result.bilibili.channel = info;
        } catch (e) {
          result.bilibili = { mode: '公开数据（方案A）', configured: true, authorized: false, error: e.message };
        }
      }
      return sendJson(res, 200, result);
    }

    // 4. 频道统计
    if (p === '/api/youtube/channel') {
      const ch = await getChannelStats();
      return sendJson(res, 200, ch);
    }

    // 5. 视频列表
    if (p === '/api/youtube/videos') {
      const ch = await getChannelStats();
      const videos = await getVideos(ch.uploadsPlaylist, Number(url.searchParams.get('max') || 20));
      return sendJson(res, 200, { channel: ch, videos });
    }

    // 6. 评论列表
    if (p === '/api/youtube/comments') {
      const videoId = url.searchParams.get('videoId') || '';
      const comments = await getComments(videoId);
      return sendJson(res, 200, { comments });
    }

    // 7. 回复评论
    if (p === '/api/youtube/reply' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.text || (!body.commentId && !body.videoId)) {
        return sendJson(res, 400, { error: '缺少 text / commentId / videoId' });
      }
      const result = await replyComment(body.text, body.videoId, body.commentId);
      return sendJson(res, 200, { ok: true, comment: result });
    }

    // ============ Bilibili 路由（公开数据模式，无需授权） ============

    // 1. B站用户信息
    if (p === '/api/bilibili/userinfo') {
      const info = await biliUserInfo();
      return sendJson(res, 200, info);
    }

    // 2. B站视频列表
    if (p === '/api/bilibili/videos') {
      const info = await biliUserInfo();
      const videos = await biliVideos(info.mid, Number(url.searchParams.get('max') || 20));
      return sendJson(res, 200, { channel: info, videos });
    }

    // 3. B站评论列表
    if (p === '/api/bilibili/comments') {
      const bvid = url.searchParams.get('bvid') || '';
      if (!bvid) return sendJson(res, 400, { error: '缺少 bvid' });
      const comments = await biliComments(bvid, Number(url.searchParams.get('max') || 30));
      return sendJson(res, 200, { comments });
    }

    // 4. B站回复评论（方案A不支持）
    if (p === '/api/bilibili/reply' && req.method === 'POST') {
      return sendJson(res, 400, { error: '当前为B站公开数据模式（方案A），不支持回复评论。如需回复功能，请升级为企业认证（方案B）或 Cookie 登录态（方案C）' });
    }

    // 其他 API 未匹配
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: '接口不存在' });
    return sendHtml(res, 404, '<h3>404 Not Found</h3>');

  } catch (e) {
    console.error('[错误]', e.message);
    return sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('==============================================');
  console.log(' 青松设计短视频多平台数据后台 · 多平台接入服务');
  console.log(' 后台页面: http://localhost:' + PORT);
  console.log(' YouTube: 打开页面后点击"连接 YouTube 账号"');
  console.log(' Bilibili: 公开数据模式（方案A），在 yt-config.json 填写 bilibili_uid 即可');
  console.log('==============================================');
});
