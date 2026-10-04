// Vercel Serverless Function: GET /api/live?handle=Ncangpitung  (atau ?channel=UCxxxxxxxxxxxxxxxxxxxxxx)
// Mengembalikan: { isLive: boolean, videoId: string|null, channelId: string|null }
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

module.exports = async (req, res) => {
  const { handle, channel } = req.query;
  let path;
  if (channel && /^UC[\w-]{22}$/.test(channel)) path = `channel/${channel}`;
  else if (handle && /^[\w.\-]{1,60}$/.test(handle)) path = `@${handle}`;
  else return res.status(400).json({ error: "handle/channel tidak valid" });

  try {
    const r = await fetch(`https://www.youtube.com/${path}/live`, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: "CONSENT=YES+1; SOCS=CAI",
      },
      redirect: "follow",
    });
    const html = await r.text();

    // Kalau channel sedang live, halaman /live = halaman video (canonical -> watch?v=ID)
    const canon = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
    const liveNow = html.includes('"isLiveNow":true');
    const ch = html.match(/"channelId":"(UC[\w-]{22})"/) || html.match(/"externalId":"(UC[\w-]{22})"/);
    const isLive = !!(canon && liveNow);

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({
      isLive,
      videoId: isLive ? canon[1] : null,
      channelId: channel || (ch ? ch[1] : null),
    });
  } catch (e) {
    return res.status(502).json({ error: "gagal mengambil data YouTube" });
  }
};
