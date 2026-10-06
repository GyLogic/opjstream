// Vercel Serverless Function
// GET /api/live?handle=Ncangpitung   atau   /api/live?channel=UCxxxxxxxxxxxxxxxxxxxxxx
// Respon: { isLive, videoId, channelId }
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function getHtml(path) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(`https://www.youtube.com/${path}`, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: "CONSENT=YES+cb; SOCS=CAI",
      },
      redirect: "follow",
      signal: ctl.signal,
    });
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

function findChannelId(html) {
  const m =
    html.match(/<meta itemprop="(?:channelId|identifier)" content="(UC[\w-]{22})"/) ||
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ||
    html.match(/"externalId":"(UC[\w-]{22})"/) ||
    html.match(/"channelId":"(UC[\w-]{22})"/) ||
    html.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
  return m ? m[1] : null;
}

module.exports = async (req, res) => {
  const { handle, channel } = req.query;
  let path;
  if (channel && /^UC[\w-]{22}$/.test(channel)) path = `channel/${channel}`;
  else if (handle && /^[\w.\-]{1,60}$/.test(handle)) path = `@${handle.replace(/^@/, "")}`;
  else return res.status(400).json({ error: "handle/channel tidak valid" });

  try {
    const html = await getHtml(`${path}/live`);

    // Kalau sedang live, halaman /live = halaman video (canonical -> watch?v=ID)
    const canon = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
    const liveNow = html.includes('"isLiveNow":true');
    const isLive = !!(canon && liveNow);

    let channelId = channel || findChannelId(html);

    // Belum ketemu channelId? ambil dari halaman channel-nya langsung
    if (!channelId) {
      try {
        channelId = findChannelId(await getHtml(path));
      } catch (e) {}
    }

    // Jangan di-cache kalau gagal membaca apa pun (mis. diblokir / halaman consent)
    res.setHeader(
      "Cache-Control",
      channelId ? "s-maxage=30, stale-while-revalidate=60" : "no-store"
    );
    return res.status(200).json({
      isLive,
      videoId: isLive ? canon[1] : null,
      channelId: channelId || null,
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "gagal mengambil data YouTube" });
  }
};
