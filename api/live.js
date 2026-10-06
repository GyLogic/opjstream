// Vercel Serverless Function
// GET /api/live?handle=NamaHandle  atau  /api/live?channel=UCxxxxxxxxxxxxxxxxxxxxxx
// Tambahkan &debug=1 untuk melihat detail diagnosa.
// TikTok: /api/live?platform=tiktok&handle=username  (deteksi live bersifat best-effort)
// Opsional (paling akurat): set Environment Variable YT_API_KEYS (beberapa key dipisah koma) di Vercel.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------- Multi API key (otomatis pindah kalau kuota habis) ----------
// Isi Environment Variable di Vercel (pilih salah satu cara):
//   YT_API_KEYS = key1,key2,key3          (dipisah koma)
//   atau YT_API_KEY, YT_API_KEY_2, YT_API_KEY_3 ... (satu per variabel)
const KEYS = [
  ...String(process.env.YT_API_KEYS || "").split(/[\s,;]+/),
  process.env.YT_API_KEY,
  process.env.YT_API_KEY_2,
  process.env.YT_API_KEY_3,
  process.env.YT_API_KEY_4,
  process.env.YT_API_KEY_5,
]
  .map((k) => (k || "").trim())
  .filter((k, i, a) => k && a.indexOf(k) === i);

// Status tiap key: kapan boleh dipakai lagi. Tersimpan di memori instance (reset kalau instance restart, tidak masalah).
const keyBlockedUntil = new Map();
// Cache handle -> channelId supaya hemat 1 unit kuota per pengecekan
const channelCache = new Map();

// Kuota YouTube reset tiap tengah malam Pacific Time
function nextQuotaReset() {
  const now = new Date();
  const pt = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const midnight = new Date(pt);
  midnight.setHours(24, 0, 0, 0);
  return Date.now() + (midnight - pt) + 60 * 1000;
}

function availableKeys() {
  const now = Date.now();
  return KEYS.map((key, i) => ({ key, i })).filter(({ key }) => (keyBlockedUntil.get(key) || 0) <= now);
}

async function http(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    return await fetch(url, { headers, redirect: "follow", signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getHtml(path) {
  const r = await http(`https://www.youtube.com/${path}`, {
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: "CONSENT=YES+cb; SOCS=CAI",
  });
  return r.text();
}

async function getJson(url) {
  const r = await http(url);
  const j = await r.json();
  if (j.error) {
    const err = new Error(j.error.message || "api error");
    err.reason = (j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || j.error.status || "";
    throw err;
  }
  return j;
}

function findChannelId(html) {
  const m =
    html.match(/<meta itemprop="(?:channelId|identifier)" content="(UC[\w-]{22})"/) ||
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ||
    html.match(/"externalId":"(UC[\w-]{22})"/) ||
    html.match(/"channelId":"(UC[\w-]{22})"/);
  return m ? m[1] : null;
}

// Halaman /live: kalau sedang live, isinya halaman video yang berstatus live
function parseLivePage(html) {
  const canon = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
  const vd = html.match(/"videoDetails":\{"videoId":"([\w-]{11})"/);
  const id = (canon && canon[1]) || (vd && vd[1]);
  const live =
    html.includes('"isLiveNow":true') ||
    /"videoDetails":\{[\s\S]{0,1500}?"isLive":true/.test(html);
  return id && live ? id : null;
}

// Tab /streams: cari video yang berlabel LIVE
function parseStreamsPage(html) {
  const i = html.search(/"style":"LIVE"|BADGE_STYLE_TYPE_LIVE_NOW/);
  if (i < 0) return null;
  const ids = [...html.slice(Math.max(0, i - 4000), i).matchAll(/"videoId":"([\w-]{11})"/g)];
  return ids.length ? ids[ids.length - 1][1] : null;
}

// Cadangan tanpa kuota: RSS channel -> 2 video terbaru -> cek halaman watch (isLiveNow)
async function viaRss(channelId, dbg) {
  const r = await http(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { "User-Agent": UA });
  const xml = await r.text();
  const ids = [...xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map((m) => m[1]).slice(0, 2);
  dbg.rssIds = ids;
  const pages = await Promise.all(ids.map((id) => getHtml(`watch?v=${id}`).then((h) => ({ id, h })).catch(() => null)));
  const hit = pages.find((x) => x && x.h.includes('"isLiveNow":true'));
  return hit ? hit.id : null;
}

// Cara paling akurat: YouTube Data API (±3 unit per cek, ±2 kalau channelId sudah di-cache)
async function viaApiWithKey(key, handle, channel) {
  const base = "https://www.googleapis.com/youtube/v3";
  let ch = channel || channelCache.get(handle);
  if (!ch) {
    const r = await getJson(`${base}/channels?part=id&forHandle=${encodeURIComponent("@" + handle)}&key=${key}`);
    ch = r.items && r.items[0] && r.items[0].id;
    if (ch) channelCache.set(handle, ch);
  }
  if (!ch) return null;
  const pl = await getJson(`${base}/playlistItems?part=contentDetails&playlistId=UU${ch.slice(2)}&maxResults=10&key=${key}`);
  const ids = (pl.items || []).map((i) => i.contentDetails.videoId);
  let live = null;
  if (ids.length) {
    const v = await getJson(`${base}/videos?part=liveStreamingDetails&id=${ids.join(",")}&key=${key}`);
    live = (v.items || []).find((x) => x.liveStreamingDetails && x.liveStreamingDetails.actualStartTime && !x.liveStreamingDetails.actualEndTime);
  }
  return { isLive: !!live, videoId: live ? live.id : null, channelId: ch };
}

// Coba key satu per satu; key yang kuotanya habis ditandai lalu otomatis pindah ke key berikutnya
async function viaApi(handle, channel, dbg) {
  dbg.keys = { total: KEYS.length, available: availableKeys().length, tried: [] };
  for (const { key, i } of availableKeys()) {
    try {
      const out = await viaApiWithKey(key, handle, channel);
      dbg.keys.tried.push({ key: i + 1, ok: true });
      if (out) out.keyUsed = i + 1;
      return out;
    } catch (e) {
      const msg = String(e.message || e);
      const reason = String(e.reason || "");
      if (/quota|rateLimit/i.test(reason + " " + msg)) {
        keyBlockedUntil.set(key, nextQuotaReset());
        dbg.keys.tried.push({ key: i + 1, error: "kuota habis -> pindah key" });
      } else if (/keyInvalid|API key not valid|accessNotConfigured|has not been used|disabled|ipRefererBlocked|forbidden/i.test(reason + " " + msg)) {
        keyBlockedUntil.set(key, Date.now() + 60 * 60 * 1000); // key bermasalah: lewati 1 jam
        dbg.keys.tried.push({ key: i + 1, error: "key tidak valid / API belum diaktifkan: " + msg.slice(0, 120) });
      } else {
        dbg.keys.tried.push({ key: i + 1, error: msg.slice(0, 120) });
        throw e; // error lain (jaringan, dll): jangan habiskan key lain, biar jatuh ke scraping
      }
    }
  }
  return null; // semua key habis -> pemanggil memakai scraping
}


// ---------- TikTok (best-effort) ----------
// TikTok tidak punya API publik untuk cek status live. Kita baca halaman profil dan lihat
// apakah user punya roomId aktif. Kalau TikTok memblokir/format berubah -> isLive: null (tidak pasti).
async function tiktokStatus(user) {
  const r = await http(`https://www.tiktok.com/@${user}`, {
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
  });
  const html = await r.text();
  let roomId = null;
  let known = false;
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      const detail = data["__DEFAULT_SCOPE__"] && data["__DEFAULT_SCOPE__"]["webapp.user-detail"];
      const u = detail && detail.userInfo && detail.userInfo.user;
      if (u) {
        known = true;
        roomId = u.roomId && u.roomId !== "0" ? String(u.roomId) : null;
      }
    } catch (e) {}
  }
  if (!known) {
    const rm = html.match(/"roomId":"(\d*)"/);
    if (rm) {
      known = true;
      roomId = rm[1] && rm[1] !== "0" ? rm[1] : null;
    }
  }
  return { platform: "tiktok", isLive: known ? !!roomId : null, roomId, handle: user, source: "tiktok-page" };
}

module.exports = async (req, res) => {
  const { handle, channel, debug, platform } = req.query;
  const cleanHandle = handle ? String(handle).replace(/^@/, "") : "";

  if (platform === "tiktok") {
    if (!/^[\w.]{2,40}$/.test(cleanHandle)) return res.status(400).json({ error: "username TikTok tidak valid" });
    try {
      const out = await tiktokStatus(cleanHandle);
      res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
      return res.status(200).json(out);
    } catch (e) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ platform: "tiktok", isLive: null, handle: cleanHandle, error: String(e.message || e) });
    }
  }

  let path;
  if (channel && /^UC[\w-]{22}$/.test(channel)) path = `channel/${channel}`;
  else if (cleanHandle && /^[\w.\-]{1,60}$/.test(cleanHandle)) path = `@${cleanHandle}`;
  else return res.status(400).json({ error: "handle/channel tidak valid" });

  const dbg = { hasApiKey: KEYS.length > 0, apiKeys: KEYS.length };
  let out = null;

  if (KEYS.length && availableKeys().length === 0) dbg.apiSkipped = "semua key kuotanya habis, memakai scraping";
  if (KEYS.length && availableKeys().length > 0) {
    try {
      out = await viaApi(cleanHandle, channel, dbg);
      if (out) out.source = "api";
    } catch (e) {
      dbg.apiError = String(e.message || e);
    }
  }

  if (!out) {
    try {
      const html = await getHtml(`${path}/live`);
      dbg.liveHtmlLength = html.length;
      dbg.consentPage = /consent\.youtube\.com|Before you continue/.test(html);
      let videoId = parseLivePage(html);
      dbg.live = {
        title: (html.match(/<title>([^<]*)<\/title>/) || [])[1] || null,
        canonical: (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1] || null,
        isLiveNowTrue: html.includes('"isLiveNow":true'),
        isLiveNowFalse: html.includes('"isLiveNow":false'),
      };
      let channelId = channel || findChannelId(html);
      let source = "live-page";

      if (!videoId && channelId) {
        try {
          videoId = await viaRss(channelId, dbg);
          if (videoId) source = "rss-watch";
        } catch (e) { dbg.rssError = String(e.message || e); }
      }

      if (!videoId) {
        try {
          const h2 = await getHtml(`${path}/streams`);
          dbg.streamsHtmlLength = h2.length;
          videoId = parseStreamsPage(h2);
          channelId = channelId || findChannelId(h2);
          if (videoId) source = "streams-page";
        } catch (e) {}
      }
      out = { isLive: !!videoId, videoId: videoId || null, channelId: channelId || null, source };
    } catch (e) {
      dbg.scrapeError = String(e.message || e);
    }
  }

  if (!out) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "gagal mengambil data YouTube", ...(debug ? { debug: dbg } : {}) });
  }

  res.setHeader("Cache-Control", debug || !out.channelId ? "no-store" : "s-maxage=30, stale-while-revalidate=60");
  return res.status(200).json(debug ? { ...out, debug: dbg } : out);
};
