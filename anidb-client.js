/**
 * AniDB Client-Side Extractor for andbgithub API
 * Connects directly to Cloudflare Worker proxy from browser JavaScript.
 */

const WORKER_PROXY_URL = "https://old-sun-d12a.andruilsyestems.workers.dev";
const ANIDB_BASE = "https://anidb.app";

const memoryCache = new Map();
const TTL_MS = 86400 * 1000;

function cacheGet(key) {
  const cached = memoryCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }
  memoryCache.delete(key);
  return null;
}

function cacheSet(key, data, ttlMs = TTL_MS) {
  memoryCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

function attr(tagStr, name) {
  const m = tagStr.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"));
  return m ? m[1] : "";
}

function decodeEntities(s = "") {
  if (!s) return "";
  if (typeof document !== "undefined") {
    const txt = document.createElement("textarea");
    txt.innerHTML = s;
    return txt.value.trim();
  }
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .trim();
}

function stripTags(htmlStr = "") {
  if (!htmlStr) return "";
  const clean = htmlStr.replace(/<[^>]*>/g, "");
  return decodeEntities(clean);
}

async function proxyFetch(targetUrl, referer = "https://anidb.app/", isXhr = false) {
  const proxyEndpoint = `${WORKER_PROXY_URL}/?url=${encodeURIComponent(targetUrl)}&ref=${encodeURIComponent(referer)}${isXhr ? "&xhr=1" : ""}`;
  const res = await fetch(proxyEndpoint);
  if (!res.ok) {
    throw new Error(`Proxy HTTP ${res.status} fetching ${targetUrl}`);
  }
  return await res.text();
}

async function proxyFetchJson(targetUrl, referer = "https://anidb.app/") {
  const text = await proxyFetch(targetUrl, referer, true);
  return JSON.parse(text);
}

export async function getAniListMedia(anilistId) {
  const query = `
    query ($id: Int) {
      Media (id: $id, type: ANIME) {
        id
        idMal
        title { english romaji native }
        status
        format
        episodes
        seasonYear
        synonyms
        bannerImage
        coverImage { extraLarge large }
      }
    }
  `;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { id: Number(anilistId) } })
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const data = await res.json();
  const media = data?.data?.Media;
  if (!media) throw new Error(`No media found for AniList ID ${anilistId}`);
  return media;
}

export function buildTitles(media, anizip = null) {
  const titles = [];
  if (media?.title) {
    for (const k of ["english", "romaji", "native"]) {
      if (media.title[k]) titles.push(media.title[k]);
    }
  }
  if (media?.synonyms) {
    for (const syn of media.synonyms) {
      if (syn) titles.push(syn);
    }
  }
  if (anizip?.titles) {
    for (const val of Object.values(anizip.titles)) {
      if (val) titles.push(val);
    }
  }
  return [...new Set(titles)];
}

export async function searchAniDB(query) {
  let html = "";
  try {
    html = await proxyFetch(`${ANIDB_BASE}/search/suggestions?q=${encodeURIComponent(query)}`, `${ANIDB_BASE}/home`, true);
  } catch (e) {
    html = "";
  }

  const results = [];
  const matches = html.matchAll(/<a\b[^>]*data-search-item\b[^>]*>[\s\S]*?<\/a>/gi);
  for (const m of matches) {
    const tag = m[0].match(/<a\b[^>]*>/i)?.[0] ?? "";
    const href = attr(tag, "href");
    const path = href.startsWith("http") ? new URL(href).pathname : href;
    const slug = path.match(/^\/anime\/([^/?#]+)/)?.[1];
    if (!slug) continue;
    const titleRaw = m[0].match(/<p\b[^>]*class=["'][^"']*text-sm[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
    const metaRaw = m[0].match(/<p\b[^>]*class=["'][^"']*text-xs[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
    const title = stripTags(titleRaw);
    const meta = stripTags(metaRaw);
    const siteId = Number(slug.match(/-(\d+)$/)?.[1]);
    results.push({ slug, title: title || slug.replace(/-/g, " "), meta, siteId });
  }

  if (results.length) return results;

  let browseHtml = "";
  try {
    browseHtml = await proxyFetch(`${ANIDB_BASE}/browse?q=${encodeURIComponent(query)}`, `${ANIDB_BASE}/home`, false);
  } catch (e) {
    browseHtml = "";
  }

  const seen = new Set();
  const browseMatches = browseHtml.matchAll(/<a\b[^>]*href=["'](?:https:\/\/anidb\.app)?\/anime\/([^"']+)["'][^>]*class=["'][^"']*\banime-card\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi);
  for (const m of browseMatches) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const cardHtml = m[0];
    const tMatch = cardHtml.match(/title=["']([^"']+)["']/i) || cardHtml.match(/alt=["']([^"']+)["']/i);
    const title = stripTags(tMatch?.[1] ?? "") || slug.replace(/-/g, " ");
    const siteId = Number(slug.match(/-(\d+)$/)?.[1]);
    results.push({ slug, title, meta: "", siteId });
  }

  return results;
}

function parseExternalIds(htmlStr) {
  return {
    anilistId: Number(htmlStr.match(/https:\/\/anilist\.co\/anime\/(\d+)/i)?.[1]) || null,
    malId: Number(htmlStr.match(/https:\/\/myanimelist\.net\/anime\/(\d+)/i)?.[1]) || null,
    anidbId: Number(htmlStr.match(/https:\/\/anidb\.net\/anime\/(\d+)/i)?.[1]) || null,
    kitsuId: Number(htmlStr.match(/https:\/\/kitsu\.app\/anime\/(\d+)/i)?.[1]) || null,
  };
}

function parsePageTitle(htmlStr) {
  return stripTags(htmlStr.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
}

function searchQueries(media, anizip = null) {
  const titles = buildTitles(media, anizip);
  const out = new Set();
  for (const title of titles.slice(0, 5)) {
    out.add(title);
    const words = title.trim().split(/\s+/);
    if (words.length > 4) out.add(words.slice(0, 4).join(" "));
  }
  return [...out].filter((q) => q.length >= 2);
}

export async function resolveSeries(anilistId, ctx = {}) {
  const cacheKey = `np:anidbapp:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const media = ctx.media ?? await getAniListMedia(anilistId);
  const queries = searchQueries(media, ctx.anizip);
  const candidates = new Map();

  await Promise.all(queries.map(async (q) => {
    try {
      const res = await searchAniDB(q);
      for (const r of res) {
        if (!candidates.has(r.slug)) candidates.set(r.slug, r);
      }
    } catch (e) {}
  }));

  for (const candidate of candidates.values()) {
    let html = "";
    try {
      html = await proxyFetch(`${ANIDB_BASE}/anime/${candidate.slug}`, `${ANIDB_BASE}/home`);
    } catch (e) {}
    if (!html) continue;
    const ids = parseExternalIds(html);
    if (ids.anilistId === Number(anilistId)) {
      const data = {
        slug: candidate.slug,
        siteId: candidate.siteId || Number(candidate.slug.match(/-(\d+)$/)?.[1]),
        title: parsePageTitle(html) || candidate.title,
        matchType: "anilist",
        matchScore: 1,
        ...ids
      };
      cacheSet(cacheKey, data);
      return data;
    }
  }

  const malId = media?.idMal ?? null;
  if (malId) {
    for (const candidate of candidates.values()) {
      let html = "";
      try {
        html = await proxyFetch(`${ANIDB_BASE}/anime/${candidate.slug}`, `${ANIDB_BASE}/home`);
      } catch (e) {}
      if (!html) continue;
      const ids = parseExternalIds(html);
      if (ids.anilistId || ids.malId !== Number(malId)) continue;
      const data = {
        slug: candidate.slug,
        siteId: candidate.siteId || Number(candidate.slug.match(/-(\d+)$/)?.[1]),
        title: parsePageTitle(html) || candidate.title,
        matchType: "mal",
        matchScore: 0.9,
        ...ids
      };
      cacheSet(cacheKey, data);
      return data;
    }
  }

  throw new Error(`AniDB.app match not found for AniList ${anilistId}`);
}

export async function fetchProviderEpisodes(siteId) {
  const data = await proxyFetchJson(`${ANIDB_BASE}/api/frontend/anime/${siteId}/episodes`, `${ANIDB_BASE}/anime/${siteId}`);
  return Array.isArray(data?.episodes) ? data.episodes : [];
}

export async function fetchLanguages(episodeId, seriesSlug) {
  try {
    const data = await proxyFetchJson(`${ANIDB_BASE}/api/frontend/episode/${episodeId}/languages`, `${ANIDB_BASE}/anime/${seriesSlug}`);
    return Array.isArray(data?.languages) ? data.languages : [];
  } catch (e) {
    return [];
  }
}

export function languageForAudio(languages, audio) {
  const preferred = audio === "sub" ? ["jpn", "ja", "japanese"] : ["eng", "en", "english"];
  return languages.find((l) => preferred.includes(String(l.code ?? "").toLowerCase()))
    ?? languages.find((l) => preferred.includes(String(l.name ?? "").toLowerCase()))
    ?? null;
}

export function hasLanguage(languages, audio) {
  return Boolean(languageForAudio(languages, audio)?.embed_url);
}

function extractHls(htmlStr) {
  const patterns = [
    /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\/master\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
  ];
  for (const pattern of patterns) {
    const m = htmlStr.match(pattern);
    if (m?.[1]) return decodeEntities(m[1]);
  }
  return null;
}

export async function streamsForEmbed(embedUrl, audio, language) {
  let html = "";
  try {
    html = await proxyFetch(embedUrl, `${ANIDB_BASE}/`);
  } catch (e) {}
  const hls = html ? extractHls(html) : null;
  const streams = [];
  if (hls) {
    const origin = new URL(embedUrl).origin + "/";
    streams.push({
      url: hls,
      type: "hls",
      audio,
      language: language?.code,
      server: "AniDB.app",
      embed: embedUrl,
      referer: origin,
      priority: 5,
      isActive: true,
    });
  }
  streams.push({
    url: embedUrl,
    type: "embed",
    audio,
    language: language?.code,
    server: "AniDB.app-embed",
    referer: `${ANIDB_BASE}/`,
    priority: 4,
    isActive: !hls,
  });
  return streams;
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media ?? await getAniListMedia(anilistId);
  const localCtx = { ...ctx, media };
  const series = await resolveSeries(anilistId, localCtx);
  const episodes = await fetchProviderEpisodes(series.siteId);

  const sampleLanguages = [];
  if (episodes.length) {
    for (const ep of episodes.slice(0, 5)) {
      if (ep?.id) {
        const langs = await fetchLanguages(ep.id, series.slug);
        sampleLanguages.push(...langs);
      }
    }
  }

  const availability = {
    hasSub: hasLanguage(sampleLanguages, "sub") || !sampleLanguages.length,
    hasDub: hasLanguage(sampleLanguages, "dub"),
  };

  const sub = [];
  const dub = [];
  for (const src of episodes) {
    const sourceNumber = Number(src.number);
    if (!Number.isFinite(sourceNumber) || sourceNumber < 1) continue;
    const base = {
      number: sourceNumber,
      title: `Episode ${sourceNumber}`,
      filler: src.filler ?? false,
      sourceNumber,
      sourceId: src.id,
    };
    if (availability.hasSub) sub.push({ ...base, id: `watch/anidbapp/${anilistId}/sub/anidbapp-${sourceNumber}`, audio: "sub" });
    if (availability.hasDub) dub.push({ ...base, id: `watch/anidbapp/${anilistId}/dub/anidbapp-${sourceNumber}`, audio: "dub" });
  }

  return {
    meta: {
      id: series.slug,
      siteId: series.siteId,
      title: series.title,
      source: "anidbapp",
      matchScore: series.matchScore,
      matchType: series.matchType,
      anilistId: series.anilistId,
      malId: series.malId,
      media,
    },
    episodes: { sub, dub }
  };
}

export async function handleWatch(anilistId, audio = "both", epNum = 1, ctx = {}) {
  const series = await resolveSeries(anilistId, ctx);
  const episodes = await fetchProviderEpisodes(series.siteId);
  const cleanEp = Number(String(epNum).toLowerCase().replace("anidbapp-", "").trim());
  const episode = episodes.find((e) => Number(e.number) === cleanEp);

  if (!episode) {
    throw new Error(`AniDB.app episode ${epNum} not found`);
  }

  const languages = await fetchLanguages(episode.id, series.slug);
  const audStr = String(audio || "both").toLowerCase();
  const audiosToFetch = audStr === "sub" ? ["sub"] : audStr === "dub" ? ["dub"] : ["sub", "dub"];

  const allStreams = [];
  const usedLangCodes = [];

  for (const aud of audiosToFetch) {
    const language = languageForAudio(languages, aud);
    if (language?.embed_url) {
      const embedUrl = decodeEntities(language.embed_url);
      const st = await streamsForEmbed(embedUrl, aud, language);
      allStreams.push(...st);
      if (language.code) usedLangCodes.push(language.code);
    }
  }

  return {
    anilistId: Number(anilistId),
    episode: cleanEp,
    providerEpisode: cleanEp,
    audio,
    language: usedLangCodes.length ? usedLangCodes.join(",") : null,
    streams: allStreams
  };
}
