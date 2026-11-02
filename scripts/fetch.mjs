// AIニュース収集スクリプト（Node.js 18+、追加ライブラリ不要）
// RSS/Atomフィードを取得し、docs/data.json に保存する
import { writeFile, readFile, mkdir } from "node:fs/promises";

const FEEDS = [
  // 日本語
  { name: "ITmedia AI+", lang: "ja", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml" },
  { name: "Googleニュース（生成AI）", lang: "ja", url: "https://news.google.com/rss/search?q=%E7%94%9F%E6%88%90AI+when:2d&hl=ja&gl=JP&ceid=JP:ja" },
  { name: "Googleニュース（AI活用）", lang: "ja", url: "https://news.google.com/rss/search?q=AI+%E6%B4%BB%E7%94%A8+when:3d&hl=ja&gl=JP&ceid=JP:ja" },
  { name: "Googleニュース（ChatGPT/Claude/Gemini）", lang: "ja", url: "https://news.google.com/rss/search?q=ChatGPT+OR+Claude+OR+Gemini+when:2d&hl=ja&gl=JP&ceid=JP:ja" },
  // 英語
  { name: "TechCrunch AI", lang: "en", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { name: "The Verge AI", lang: "en", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { name: "VentureBeat AI", lang: "en", url: "https://venturebeat.com/category/ai/feed/" },
  { name: "MIT Technology Review", lang: "en", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed" },
  { name: "OpenAI News", lang: "en", url: "https://openai.com/news/rss.xml" },
  { name: "Google AI Blog", lang: "en", url: "https://blog.google/technology/ai/rss/" },
  { name: "Hugging Face Blog", lang: "en", url: "https://huggingface.co/blog/feed.xml" },
  // YouTube（チャンネルIDを追加すれば増やせる）
  ...[
    ["KEITO【AI&WEB ch】", "ja", "UCfapRkagDtoQEkGeyD3uERQ"],
    ["OpenAI", "en", "UCXZCJLdBC09xxGZ6gcdrc6A"],
    ["Anthropic", "en", "UCrDwWp7EBBv4NwvScIpBDOA"],
    ["Google DeepMind", "en", "UCP7jMXSY2xbc3KCAE0MHQ-A"],
    ["AI Explained", "en", "UCNJ1Ymd5yFuUPtn21xtRbbw"],
    ["Two Minute Papers", "en", "UCbfYPyITQ-7l4upoX8nvctg"],
    ["Matthew Berman", "en", "UCawZsQWqfGSbCI5yjkdVkTA"],
    ["Wes Roth", "en", "UCqcbQf6yw5KzRoDDcZ_wBSw"],
    ["bycloud", "en", "UCgfe2ooZD3VJPB6aJAnuQng"],
  ].map(([name, lang, id]) => ({ name: `▶ ${name}`, lang, video: true, url: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}` })),
];

const CATEGORIES = {
  new: /リリース|発表|公開|提供開始|新機能|新モデル|搭載|アップデート|ベータ|launch|release|introduc|unveil|announc|rolls? out|new model|\bGPT-?\d|Claude|Gemini|Llama|Sora|beta|update/i,
  biz: /資金|調達|買収|提携|市場|投資|規制|法案|企業|売上|決算|株価|億|兆|雇用|fund|rais|acqui|invest|deal|partner|regulat|law|lawsuit|IPO|billion|million|valuation|revenue|market|startup|layoff|policy|antitrust/i,
  howto: /使い方|活用|方法|テクニック|効率|業務|導入事例|事例|プロンプト|コツ|入門|解説|自動化|how to|tips|guide|use case|tutorial|prompt|productivity|workflow|hands-on|explain/i,
};

const MAX_DAYS = 7;
const MAX_ITEMS = 400;

function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}
const stripTags = (s) => decode(decode(s)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
};

function parse(xml, feed) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    let title = stripTags(tag(b, "title"));
    let link = decode(tag(b, "link")).trim();
    if (!link) {
      const m = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)/i) || b.match(/<link[^>]*href=["']([^"']+)/i);
      link = m ? decode(m[1]) : "";
    }
    const date = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date");
    let summary = stripTags(tag(b, "description") || tag(b, "media:description") || tag(b, "summary") || tag(b, "content"));
    const vid = feed.video ? stripTags(tag(b, "yt:videoId")) : "";
    if (vid && /\/shorts\//.test(link)) continue; // ショート動画は除外
    let source = feed.name;
    // Googleニュースは「タイトル - 媒体名」形式
    if (feed.url.includes("news.google.com")) {
      const src = stripTags(tag(b, "source"));
      if (src) {
        source = src;
        title = title.replace(new RegExp(`\\s*-\\s*${src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
      }
      summary = "";
    }
    if (summary.length > 160) summary = summary.slice(0, 160) + "…";
    const t = Date.parse(stripTags(date));
    if (!title || !link) continue;
    const text = `${title} ${summary}`;
    const cats = Object.keys(CATEGORIES).filter((k) => CATEGORIES[k].test(text));
    if (vid) cats.push("video");
    items.push({ title, link, source, lang: feed.lang, summary, date: isNaN(t) ? null : new Date(t).toISOString(), cats, ...(vid && { thumb: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg` }) });
  }
  return items;
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "Mozilla/5.0 (AI News Reader; +https://github.com)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parse(await res.text(), feed)
      .sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0))
      .slice(0, 30);
    console.log(`OK   ${feed.name}: ${items.length}件`);
    return items;
  } catch (e) {
    console.log(`FAIL ${feed.name}: ${e.message}`);
    return [];
  }
}

const normTitle = (t) => t.toLowerCase().replace(/[\s\p{P}]/gu, "").slice(0, 40);

async function main() {
  const out = new URL("../docs/data.json", import.meta.url);
  let old = [];
  try { old = JSON.parse(await readFile(out, "utf8")).items || []; } catch {}

  const fresh = (await Promise.all(FEEDS.map(fetchFeed))).flat();
  const now = Date.now();
  const seen = new Set();
  const all = [];
  for (const it of [...fresh, ...old]) {
    const key = normTitle(it.title);
    if (seen.has(key) || seen.has(it.link)) continue;
    seen.add(key); seen.add(it.link);
    if (!it.date) it.date = new Date(now).toISOString();
    if (now - Date.parse(it.date) > MAX_DAYS * 864e5) continue;
    if (Date.parse(it.date) > now + 864e5) continue;
    all.push(it);
  }
  all.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  await mkdir(new URL("../docs/", import.meta.url), { recursive: true });
  await writeFile(out, JSON.stringify({ updated: new Date(now).toISOString(), items: all.slice(0, MAX_ITEMS) }, null, 1));
  console.log(`保存: ${Math.min(all.length, MAX_ITEMS)}件`);
}
main();
