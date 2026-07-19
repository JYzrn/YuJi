/**
 * YuJi 海外解析 Worker (Cloudflare Workers 免费层)
 * 直接从 Cloudflare 边缘节点访问 x.com / instagram.com / youtube.com,无需第三方、无需付费。
 *
 * 部署后地址形如: https://yujiparse.<你的子域>.workers.dev
 * 国内云函数调用: GET https://<worker>/parse?url=<编码后的链接>
 */

// 可选:填一个自定义密钥防止别人滥用(留空则不校验)
const SECRET = "";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
  });
}

function ok(data) {
  return { code: 0, msg: "ok", data };
}
function fail(msg, code = 1) {
  return { code, msg, data: null };
}

// 通用 fetch:走 fetch 自动跟随重定向
async function fetchText(url, extra = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
      ...extra,
    },
    redirect: "follow",
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, url: res.url };
}

async function fetchJson(url, extra = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "application/json,*/*;q=0.8",
      ...extra,
    },
    redirect: "follow",
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  return { status: res.status, data, text, url: res.url };
}

// ---------- Instagram ----------
// 思路:用桌面 UA 访问 oembed + 页面,提取 EdgeGraphMedia;同时尝试 i.instagram.com API
async function parseInstagram(rawUrl) {
  let url = rawUrl;
  // 统一为 www.instagram.com
  url = url.replace(/^(https?:\/\/)?(www\.)?instagram\.com/i, "https://www.instagram.com");
  // reel / p / tv
  const m = url.match(/instagram\.com\/(reel|p|tv)\/([^/?]+)/i);
  if (!m) throw new Error("无法识别 Instagram 链接格式");
  const short = m[2];

  // 方法1:桌面页面 HTML 里的 __additionalDataLoaded / window._sharedData
  const r = await fetchText("https://www.instagram.com/" + m[1] + "/" + short + "/", {
    "Cookie": "",
    "Sec-Fetch-Dest": "document",
  });
  const html = r.text || "";

  // 尝试从 HTML 里抓 JSON (新版:前端 hydration JSON)
  let mediaArr = [];
  let videoUrl = "";
  let title = "", author = "";

  // 新版 Instagram 把数据放在 <script type="application/json"> 里
  const scripts = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)].map(x => x[1]);
  for (const s of scripts) {
    // 匹配 video_url / image URL
    const vids = [...s.matchAll(/"video_url"\s*:\s*"([^"]+)"/g)].map(x => x[1].replace(/\\u0026/g, "&").replace(/\\/g, ""));
    if (vids.length) videoUrl = vids[0];
    const imgs = [...s.matchAll(/"display_url"\s*:\s*"([^"]+)"/g)].map(x => x[1].replace(/\\u0026/g, "&").replace(/\\/g, ""));
    if (imgs.length) mediaArr = imgs;
    const ti = s.match(/"title"\s*:\s*"([^"]+)"/);
    if (ti) title = ti[1];
    const au = s.match(/"owner"\s*:\s*\{[^}]*"username"\s*:\s*"([^"]+)"/);
    if (au) author = au[1];
  }

  // 老版:window._sharedData
  if (!videoUrl && !mediaArr.length) {
    const sd = html.match(/window\._sharedData\s*=\s*(\{[\s\S]*?\});<\/script>/);
    if (sd) {
      try {
        const j = JSON.parse(sd[1]);
        const media = j?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;
        if (media) {
          if (media.video_url) videoUrl = media.video_url;
          if (media.display_url && !mediaArr.length) mediaArr = [media.display_url];
          if (media.edge_sidecar_to_children?.edges) {
            mediaArr = media.edge_sidecar_to_children.edges.map(e => e.node?.video_url || e.node?.display_url).filter(Boolean);
            const v = media.edge_sidecar_to_children.edges.map(e => e.node?.video_url).filter(Boolean);
            if (v.length && !videoUrl) videoUrl = v[0];
          }
          title = media.title || title;
          author = media.owner?.username || author;
        }
      } catch (e) {}
    }
  }

  // 方法2:oembed 拿标题/作者(不可靠但作兜底)
  if (!title || !author) {
    try {
      const oe = await fetchJson("https://www.instagram.com/oembed/?url=" + encodeURIComponent("https://www.instagram.com/" + m[1] + "/" + short + "/"));
      if (oe.data) {
        title = title || oe.data.title || "";
        author = author || oe.data.author_name || oe.data.author_username || "";
      }
    } catch (e) {}
  }

  if (!videoUrl && !mediaArr.length) throw new Error("Instagram 解析失败:可能需要登录或链接失效");
  return { platform: "instagram", title: title || "Instagram 媒体", author: author || "", imageList: mediaArr || [], videoUrl };
}

// ---------- X (Twitter) ----------
// 思路:用 syndication API 拿推文数据(无需登录)
async function parseX(rawUrl) {
  let url = rawUrl;
  const m = url.match(/(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/i);
  if (!m) throw new Error("无法识别 X 链接格式");
  const id = m[1];

  // 方法1:syndication API(公开,无需登录)
  try {
    const r = await fetchJson("https://cdn.syndication.twimg.com/tweet-result?id=" + id + "&token=0");
    if (r.data) {
      const d = r.data;
      const vids = (d.video || {}).variants || [];
      // 选最高码率
      let best = null;
      for (const v of vids) {
        if (v.type && v.type.indexOf("mp4") >= 0) {
          if (!best || (v.bitrate || 0) > (best.bitrate || 0)) best = v;
        }
      }
      const img = (d.video?.poster) || (d.photos && d.photos[0] && d.photos[0].url) || "";
      const photos = (d.photos || []).map(p => p.url);
      return {
        platform: "x",
        title: d.text || "",
        author: (d.user && d.user.name) ? d.user.name : ((d.user && d.user.screen_name) ? "@" + d.user.screen_name : ""),
        imageList: photos.length ? photos : (img ? [img] : []),
        videoUrl: best ? best.url : "",
      };
    }
  } catch (e) {}

  // 方法2:页面 og 标签兜底
  try {
    const r = await fetchText(url);
    const ogVideo = (r.text.match(/<meta[^>]+property="og:video[^"]*"[^>]+content="([^"]+)"/) || [])[1];
    const ogImage = (r.text.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/) || [])[1];
    const ogTitle = (r.text.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/) || [])[1];
    if (ogVideo || ogImage) {
      return { platform: "x", title: ogTitle || "", author: "", imageList: ogImage ? [ogImage] : [], videoUrl: ogVideo || "" };
    }
  } catch (e) {}

  throw new Error("X 解析失败:可能推文不存在或需登录");
}

// ---------- YouTube ----------
// 思路:YouTube 的官方 oEmbed 不给视频直链;用 innertube player API 拿自适应码流。
// 由于微信小程序不能播放 HLS/DASH,这里尽量找 mp4 直链(标清~高清),并提供缩略图。
async function parseYouTube(rawUrl) {
  let url = rawUrl;
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/i);
  if (!m) throw new Error("无法识别 YouTube 链接格式");
  const vid = m[1];

  let title = "", author = "", thumb = "";
  // oembed 拿标题/作者/缩略图
  try {
    const oe = await fetchJson("https://www.youtube.com/oembed?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + vid) + "&format=json");
    if (oe.data) { title = oe.data.title || ""; author = oe.data.author_name || ""; thumb = oe.data.thumbnail_url || ""; }
  } catch (e) {}

  // innertube player 拿视频流(免登录部分)
  let videoUrl = "";
  let streamData = null;
  try {
    const r = await fetch("https://www.youtube.com/youtubei/v1/player?key=" + "AIzaSyAO_FJ2SlqU8Q4STYJ3GoV-CoqV4KoWAIo", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30 } },
        videoId: vid,
      }),
    });
    streamData = await r.json();
  } catch (e) {
    streamData = null;
  }

  if (streamData) {
    const fs = streamData.streamingData || {};
    // 优先 progressive (mp4 音视频合一,小程序可直接播)
    const mp4 = (fs.formats || []).filter(f => f.mimeType && f.mimeType.indexOf("mp4") >= 0);
    if (mp4.length) {
      // 选分辨率最高的 mp4
      mp4.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
      videoUrl = mp4[0].url || "";
    }
    // 备选:取第一个 adaptive mp4
    if (!videoUrl) {
      const am = (fs.adaptiveFormats || []).filter(f => f.mimeType && f.mimeType.indexOf("mp4") >= 0 && f.hasVideo);
      if (am.length) { am.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)); videoUrl = am[0].url || ""; }
    }
  }

  if (!videoUrl) {
    throw new Error("YouTube 解析失败:仅能拿到缩略图,视频直链需要登录或有年龄限制");
  }
  return { platform: "youtube", title: title || "YouTube 视频", author: author || "", imageList: thumb ? [thumb] : [], videoUrl };
}


// ---------- 主入口 ----------
async function handleParse(rawUrl) {
  let url = (rawUrl || "").trim();
  if (!url) return fail("缺少 url 参数");

  // 补协议
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }

  let result;
  if (/instagram\.com/i.test(url)) {
    result = await parseInstagram(url);
  } else if (/(?:twitter|x)\.com/i.test(url)) {
    result = await parseX(url);
  } else if (/(?:youtube\.com|youtu\.be)/i.test(url)) {
    result = await parseYouTube(url);
  } else {
    return fail("不支持的海外平台:仅支持 Instagram / X(Twitter) / YouTube");
  }
  return ok(result);
}


// Vercel entry (converted from Cloudflare Worker)
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const u = new URL(req.url, 'http://localhost');
  const request = { url: req.url, method: req.method, headers: req.headers };
  try {

    const u = new URL(request.url);

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" } });
    }

    // 简单鉴权(若设置 SECRET)
    if (SECRET) {
      const t = request.headers.get("X-Api-Token") || u.searchParams.get("token");
      if (t !== SECRET) return json(fail("鉴权失败", 401), 401);
    }

    if (u.pathname === "/parse" || u.pathname === "/") {
      const url = u.searchParams.get("url") || (request.method === "POST" ? (await request.json().catch(() => ({}))).url : "");
      try {
        return json(await handleParse(url));
      } catch (e) {
        return json(fail(e.message || "解析失败"));
      }
    }

    if (u.pathname === "/ping") return json(ok({ pong: true, time: Date.now() }));

    return json(fail("未知路径,可用: /parse?url= , /ping"));
  
  } catch (e) {
    res.status(200).json({ code: 1, msg: e.message || 'error', data: null });
  }
};
