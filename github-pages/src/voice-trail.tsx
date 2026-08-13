"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Anime = {
  id: number;
  type?: string;
  title: { userPreferred: string; english?: string | null };
  coverImage: { large: string; medium?: string };
  startDate: { year?: number | null; month?: number | null; day?: number | null };
  seasonYear?: number | null;
  format?: string | null;
};

type Actor = { id: number; name: { full: string }; image: { large: string }; languageV2?: string | null };
type Character = { id: number; name: { full: string }; image: { large: string } };
type CastEdge = { role: "MAIN" | "SUPPORTING" | "BACKGROUND"; node: Character; voiceActors: Actor[] | null };
type RelationEdge = { relationType: string; node: Anime };
type AnimeDetail = Anime & { characters: { pageInfo: { hasNextPage: boolean }; edges: CastEdge[] }; relations: { edges: RelationEdge[] } };
type Credit = { characterRole?: "MAIN" | "SUPPORTING" | "BACKGROUND" | null; characters?: { id: number; name: { full: string } }[]; node: Anime };
type ActorRow = Actor & { appearances: { anime: Anime; character: Character; role: string }[] };
type ComparisonSelection = { root: AnimeDetail; series: AnimeDetail[] };
type SharedActor = { actor: ActorRow; matches: ActorRow[] };

const API = "https://graphql.anilist.co";
const FRANCHISE_LINKS = new Set(["PREQUEL", "SEQUEL", "SIDE_STORY", "SPIN_OFF", "PARENT"]);
const animeCache = new Map<string, Promise<AnimeDetail>>();
const franchiseCache = new Map<string, Promise<AnimeDetail[]>>();
let apiCooldownUntil = 0;
let activeApiRequests = 0;
const apiWaiters: (() => void)[] = [];
const MAX_API_CONCURRENCY = 3;
const MAX_FRANCHISE_ENTRIES = 40;
const MAX_FILMOGRAPHY_CREDITS = 400;
const FILMOGRAPHY_PAGE_SIZE = 25;
const FILMOGRAPHY_PAGES = MAX_FILMOGRAPHY_CREDITS / FILMOGRAPHY_PAGE_SIZE;
const STAFF_LANGUAGES = new Set(["JAPANESE", "ENGLISH", "KOREAN", "FRENCH", "GERMAN", "SPANISH", "PORTUGUESE"]);

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function acquireApiSlot() {
  if (activeApiRequests >= MAX_API_CONCURRENCY) await new Promise<void>((resolve) => apiWaiters.push(resolve));
  activeApiRequests += 1;
}

function releaseApiSlot() {
  activeApiRequests -= 1;
  apiWaiters.shift()?.();
}

async function limitedFetch(query: string, variables: Record<string, unknown>) {
  await acquireApiSlot();
  try {
    const cooldown = apiCooldownUntil - Date.now();
    if (cooldown > 0) await delay(cooldown);
    return await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query, variables }) });
  } finally {
    releaseApiSlot();
  }
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await limitedFetch(query, variables);
    } catch {
      if (attempt < 2) { await delay(1200 * (attempt + 1)); continue; }
      throw new Error("AniList’s public API is temporarily unreachable. Please try again in a few minutes.");
    }
    const payload = await response.json().catch(() => ({ errors: [{ message: "AniList returned an unreadable response." }] }));
    const remaining = Number(response.headers.get("x-ratelimit-remaining"));
    const limit = Number(response.headers.get("x-ratelimit-limit"));
    const resetAt = Number(response.headers.get("x-ratelimit-reset")) * 1000;
    if (Number.isFinite(remaining)) console.debug(`[VoiceTrail] AniList rate limit: ${remaining}/${Number.isFinite(limit) ? limit : "?"} remaining`);
    if (response.ok && !payload.errors) return payload.data as T;
    if (response.status === 403) throw new Error("AniList’s public API is temporarily unavailable. VoiceTrail will work again when AniList restores access.");
    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(response.headers.get("retry-after") || 0) * 1000;
      apiCooldownUntil = Math.max(apiCooldownUntil, retryAfter ? Date.now() + retryAfter : (resetAt > Date.now() ? resetAt + 250 : Date.now() + 60000));
      continue;
    }
    if (attempt < 2 && response.status >= 500) {
      await delay(1200 * (attempt + 1));
      continue;
    }
    if (response.status === 429) throw new Error("AniList is receiving too many requests right now. Please wait a minute and try again.");
    throw new Error(payload.errors?.[0]?.message || "AniList could not be reached.");
  }
  throw new Error("AniList could not be reached.");
}

const SEARCH_QUERY = `query ($search: String!) { Page(page: 1, perPage: 8) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { id type title { userPreferred english } coverImage { large medium } startDate { year month day } seasonYear format } } }`;
const ANIME_FIELDS = `fragment AnimeFields on Media { id type title { userPreferred english } coverImage { large medium } startDate { year month day } seasonYear format relations { edges { relationType(version: 2) node { id type title { userPreferred english } coverImage { large medium } startDate { year month day } seasonYear format } } } characters(page: $page, perPage: 50, sort: [ROLE, RELEVANCE]) { pageInfo { hasNextPage } edges { role node { id name { full } image { large } } voiceActors(language: $language, sort: [RELEVANCE]) { id name { full } image { large } languageV2 } } } }`;
async function fetchAnimeBatch(ids: number[], language: string) {
  const combined = new Map<number, AnimeDetail>();
  let active = [...ids];
  let page = 1;
  while (active.length) {
    const selections = active.map((id, index) => `m${index}: Media(id: ${id}, type: ANIME) { ...AnimeFields }`).join("\n");
    const data = await gql<Record<string, AnimeDetail>>(`query ($language: StaffLanguage!, $page: Int!) { ${selections} } ${ANIME_FIELDS}`, { language, page });
    const nextActive: number[] = [];
    active.forEach((id, index) => {
      const detail = data[`m${index}`];
      const previous = combined.get(id);
      combined.set(id, previous ? { ...previous, characters: { pageInfo: detail.characters.pageInfo, edges: [...previous.characters.edges, ...detail.characters.edges] } } : detail);
      if (detail.characters.pageInfo.hasNextPage) nextActive.push(id);
    });
    active = nextActive;
    page += 1;
  }
  return ids.map((id) => ({ ...combined.get(id)!, characters: { pageInfo: { hasNextPage: false }, edges: combined.get(id)!.characters.edges } }));
}

async function fetchFilmography(actorId: number) {
  const selections = Array.from({ length: FILMOGRAPHY_PAGES }, (_, index) => `p${index + 1}: Staff(id: ${actorId}) { characterMedia(page: ${index + 1}, perPage: ${FILMOGRAPHY_PAGE_SIZE}, sort: [START_DATE_DESC]) { edges { characterRole characters { id name { full } } node { id type title { userPreferred english } coverImage { large medium } startDate { year month day } seasonYear format } } } }`).join("\n");
  const data = await gql<Record<string, { characterMedia: { edges: Credit[] } }>>(`query { ${selections} }`, {});
  const found = Array.from({ length: FILMOGRAPHY_PAGES }, (_, index) => data[`p${index + 1}`]?.characterMedia.edges || []).flat();
  return { credits: [...new Map(found.map((item) => [item.node.id, item])).values()].slice(0, MAX_FILMOGRAPHY_CREDITS), truncated: found.length >= MAX_FILMOGRAPHY_CREDITS };
}

function pretty(value?: string | null) { return value ? value.replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase()) : "Anime"; }
function title(anime: Anime) { return anime.title.english || anime.title.userPreferred; }
function actorUrl(id: number) { return `https://anilist.co/staff/${id}`; }
function characterUrl(id: number) { return `https://anilist.co/character/${id}`; }
function uniqueCharacters(actor: ActorRow) { return [...new Map(actor.appearances.map((appearance) => [appearance.character.id, appearance.character])).values()]; }

export function VoiceTrail() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Anime[]>([]);
  const [series, setSeries] = useState<AnimeDetail[]>([]);
  const [comparisons, setComparisons] = useState<ComparisonSelection[]>([]);
  const [searchTarget, setSearchTarget] = useState<"primary" | "compare">("primary");
  const [scope, setScope] = useState<"entry" | "series">("series");
  const [language, setLanguage] = useState("JAPANESE");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [view, setView] = useState<"cast" | "overlap">("cast");
  const [openActor, setOpenActor] = useState<number | null>(null);
  const [credits, setCredits] = useState<Record<number, Credit[]>>({});
  const [limitedCredits, setLimitedCredits] = useState<Record<number, boolean>>({});
  const [loadingActor, setLoadingActor] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingAnime, setLoadingAnime] = useState(false);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [error, setError] = useState("");
  const urlGeneration = useRef(0);

  function writeUrl(primaryId?: number, comparisonId?: number, nextLanguage = language, nextScope = scope, mode: "push" | "replace" = "push") {
    const url = new URL(window.location.href);
    url.search = "";
    if (primaryId) url.searchParams.set("a", String(primaryId));
    if (comparisonId) url.searchParams.set("b", String(comparisonId));
    if (primaryId) {
      url.searchParams.set("lang", nextLanguage);
      url.searchParams.set("scope", nextScope);
    }
    window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", url);
  }

  const activeSeries = scope === "series" ? series : series.slice(0, 1);
  const actors = useMemo(() => groupActors(activeSeries), [activeSeries]);
  const comparisonActors = useMemo(() => comparisons.map((item) => groupActors(scope === "series" ? item.series : [item.root])), [comparisons, scope]);
  const overlap = useMemo(() => {
    const others = comparisonActors.map((cast) => new Map(cast.map((actor) => [actor.id, actor])));
    return actors.filter((actor) => others.length > 0 && others.every((cast) => cast.has(actor.id))).map((actor) => ({ actor, matches: others.map((cast) => cast.get(actor.id)!) }));
  }, [actors, comparisonActors]);

  useEffect(() => {
    const restoreUrl = async () => {
      const generation = ++urlGeneration.current;
      const params = new URLSearchParams(window.location.search);
      const primaryId = Number(params.get("a"));
      const comparisonId = Number(params.get("b"));
      const requestedLanguage = params.get("lang") || "JAPANESE";
      const nextLanguage = STAFF_LANGUAGES.has(requestedLanguage) ? requestedLanguage : "JAPANESE";
      const nextScope = params.get("scope") === "entry" ? "entry" : "series";
      if (!Number.isInteger(primaryId) || primaryId <= 0) {
        setSeries([]); setComparisons([]); setCredits({}); setLimitedCredits({}); setOpenActor(null); setView("cast");
        return;
      }
      setLanguage(nextLanguage); setScope(nextScope); setCredits({}); setLimitedCredits({}); setOpenActor(null); setLoadingAnime(true); setSeriesLoading(nextScope === "series"); setError("");
      try {
        const primaryRequest = (async () => { const root = await getAnime(primaryId, nextLanguage); return nextScope === "series" ? collectFranchise(root, nextLanguage) : [root]; })();
        const comparisonRequest = Number.isInteger(comparisonId) && comparisonId > 0 ? (async () => { const root = await getAnime(comparisonId, nextLanguage); return { root, series: nextScope === "series" ? await collectFranchise(root, nextLanguage) : [root] }; })() : Promise.resolve<ComparisonSelection | null>(null);
        const [restoredSeries, restoredComparison] = await Promise.all([primaryRequest, comparisonRequest]);
        if (generation !== urlGeneration.current) return;
        setSeries(restoredSeries); setComparisons(restoredComparison ? [restoredComparison] : []); setView(restoredComparison ? "overlap" : "cast");
      } catch (err) { if (generation === urlGeneration.current) setError(err instanceof Error ? err.message : "Shared comparison could not be loaded."); }
      finally { if (generation === urlGeneration.current) { setLoadingAnime(false); setSeriesLoading(false); } }
    };
    void restoreUrl();
    window.addEventListener("popstate", restoreUrl);
    return () => window.removeEventListener("popstate", restoreUrl);
  }, []);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true); setError(""); setResults([]);
    try { const data = await gql<{ Page: { media: Anime[] } }>(SEARCH_QUERY, { search: query.trim() }); setResults(data.Page.media); if (!data.Page.media.length) setError("No anime matched that title. Try a shorter title."); }
    catch (err) { setError(err instanceof Error ? err.message : "Search failed."); }
    finally { setSearching(false); }
  }

  async function getAnime(id: number, nextLanguage = language) {
    return (await getAnimeBatch([id], nextLanguage))[0];
  }

  async function getAnimeBatch(ids: number[], nextLanguage = language) {
    const uniqueIds = [...new Set(ids)];
    const missing = uniqueIds.filter((id) => !animeCache.has(`${nextLanguage}:${id}`));
    for (let start = 0; start < missing.length; start += 12) {
      const chunk = missing.slice(start, start + 12);
      const batch = fetchAnimeBatch(chunk, nextLanguage);
      chunk.forEach((id, index) => {
        const cacheKey = `${nextLanguage}:${id}`;
        const request = batch.then((details) => details[index]);
        animeCache.set(cacheKey, request);
        request.catch(() => { if (animeCache.get(cacheKey) === request) animeCache.delete(cacheKey); });
      });
    }
    return Promise.all(ids.map((id) => animeCache.get(`${nextLanguage}:${id}`)!));
  }

  async function collectFranchise(first: AnimeDetail, nextLanguage = language) {
    const cacheKey = `${nextLanguage}:${first.id}`;
    const cached = franchiseCache.get(cacheKey);
    if (cached) return cached;
    const request = (async () => {
      const loaded = new Map<number, AnimeDetail>([[first.id, first]]);
      const queued: Anime[] = first.relations.edges.filter((e) => FRANCHISE_LINKS.has(e.relationType) && e.node.type === "ANIME").map((e) => e.node);
      while (queued.length && loaded.size < MAX_FRANCHISE_ENTRIES) {
        const remaining = MAX_FRANCHISE_ENTRIES - loaded.size;
        const nextIds = [...new Set(queued.splice(0).map((anime) => anime.id))].filter((id) => !loaded.has(id)).slice(0, remaining);
        if (!nextIds.length) continue;
        const details = await getAnimeBatch(nextIds, nextLanguage);
        for (const detail of details) {
          loaded.set(detail.id, detail);
          for (const edge of detail.relations.edges) if (FRANCHISE_LINKS.has(edge.relationType) && edge.node.type === "ANIME" && !loaded.has(edge.node.id)) queued.push(edge.node);
        }
      }
      return [...loaded.values()].sort((a, b) => (a.startDate.year || 9999) - (b.startDate.year || 9999));
    })();
    franchiseCache.set(cacheKey, request);
    try { return await request; }
    catch (error) { franchiseCache.delete(cacheKey); throw error; }
  }

  async function loadFranchise(first: AnimeDetail, nextLanguage = language) {
    setSeriesLoading(true);
    setSeries(await collectFranchise(first, nextLanguage));
    setSeriesLoading(false);
  }

  async function chooseAnime(anime: Anime) {
    setLoadingAnime(true); setError(""); setResults([]); setCredits({}); setOpenActor(null);
    try {
      const detail = await getAnime(anime.id);
      if (searchTarget === "compare") {
        if (comparisons.length >= 1) { setError("You can compare two anime in total."); return; }
        if (series[0]?.id === detail.id || comparisons.some((item) => item.root.id === detail.id)) { setError("That anime is already in this comparison."); return; }
        const linked = scope === "series" ? await collectFranchise(detail) : [detail];
        setComparisons((current) => [...current, { root: detail, series: linked }]); setView("overlap"); writeUrl(series[0]?.id, detail.id);
      }
      else { setSeries([detail]); setComparisons([]); setView("cast"); await loadFranchise(detail); writeUrl(detail.id); }
      setQuery("");
      window.setTimeout(() => document.getElementById("cast")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch (err) { setError(err instanceof Error ? err.message : "Cast lookup failed."); setSeriesLoading(false); }
    finally { setLoadingAnime(false); }
  }

  async function changeLanguage(next: string) {
    setLanguage(next); setCredits({}); setOpenActor(null); setLoadingAnime(true);
    try {
      const primaryRequest = series[0] ? (async () => {
        const root = await getAnime(series[0].id, next);
        return scope === "series" ? collectFranchise(root, next) : [root];
      })() : Promise.resolve<AnimeDetail[]>([]);
      const comparisonRequest = Promise.all(comparisons.map(async (item) => {
        const root = await getAnime(item.root.id, next);
        return { root, series: scope === "series" ? await collectFranchise(root, next) : [root] };
      }));
      const [refreshedPrimary, refreshed] = await Promise.all([primaryRequest, comparisonRequest]);
      if (refreshedPrimary.length) setSeries(refreshedPrimary);
      setComparisons(refreshed);
      writeUrl(series[0]?.id, comparisons[0]?.root.id, next, scope);
    } catch (err) { setError(err instanceof Error ? err.message : "Dub lookup failed."); }
    finally { setLoadingAnime(false); }
  }

  async function changeScope(next: "entry" | "series") {
    setScope(next);
    writeUrl(series[0]?.id, comparisons[0]?.root.id, language, next);
    if (next === "series" && comparisons.some((item) => item.series.length <= 1)) {
      setSeriesLoading(true);
      try { const linked: ComparisonSelection[] = []; for (const item of comparisons) linked.push({ root: item.root, series: item.series.length > 1 ? item.series : await collectFranchise(item.root) }); setComparisons(linked); }
      catch (err) { setError(err instanceof Error ? err.message : "The comparison series could not be linked."); }
      finally { setSeriesLoading(false); }
    }
  }

  async function toggleActor(actor: ActorRow) {
    if (openActor === actor.id) { setOpenActor(null); return; }
    setOpenActor(actor.id);
    if (credits[actor.id]) return;
    setLoadingActor(actor.id);
    try {
      const filmography = await fetchFilmography(actor.id);
      setCredits((current) => ({ ...current, [actor.id]: filmography.credits }));
      setLimitedCredits((current) => ({ ...current, [actor.id]: filmography.truncated }));
    } catch (err) { setError(err instanceof Error ? err.message : "Filmography could not be loaded."); }
    finally { setLoadingActor(null); }
  }

  const primary = series[0];
  return <main className="site-shell">
    <nav className="nav" aria-label="Main navigation"><div className="brand"><span className="brand-mark">V</span> VoiceTrail</div><span className="source-pill">Powered by AniList data</span></nav>
    <section className="hero"><div className="eyebrow">Follow every voice, across every role</div><h1>Where else have you<br />heard that <span className="accent">voice?</span></h1><p className="hero-copy">Explore complete voice-actor filmographies, roll an entire series into one cast, or compare two anime to find the actors they share.</p></section>
    <section className="search-wrap" aria-label="Anime search">
      {primary && <div className="search-mode"><button className={searchTarget === "primary" ? "active" : ""} onClick={() => setSearchTarget("primary")}>Choose anime</button><button className={searchTarget === "compare" ? "active" : ""} onClick={() => setSearchTarget("compare")} disabled={comparisons.length >= 1}>Add comparison ({comparisons.length + 1}/2)</button></div>}
      <form className="search-box" onSubmit={search}><input aria-label="Anime title" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchTarget === "compare" ? "Search the anime to compare…" : "Try “Frieren” or “Mushoku Tensei”"} autoComplete="off" /><button className="primary-btn" disabled={searching || loadingAnime}>{searching ? "Searching…" : "Find anime"}</button></form>
      {results.length > 0 && <div className="results-popover" role="listbox" aria-label="Anime matches">{results.map((anime) => <button className="result-row" key={anime.id} onClick={() => chooseAnime(anime)} role="option" aria-selected="false"><img src={anime.coverImage.medium || anime.coverImage.large} alt={`${title(anime)} cover`} loading="lazy" decoding="async" /><span><span className="result-title">{title(anime)}</span><span className="result-meta">{anime.seasonYear || anime.startDate.year || "Year unknown"} · {pretty(anime.format)}</span></span><span className="result-arrow">→</span></button>)}</div>}
      {error && <div className="error" role="alert">{error}</div>}
    </section>

    {!primary ? <section className="empty-demo" aria-label="How it works"><div className="how-card"><span className="step">01</span><h3>Explore a whole series</h3><p>Merge connected seasons, OVAs, ONAs, specials, side stories, and spin-offs.</p></div><div className="how-card"><span className="step">02</span><h3>See every role</h3><p>Open an actor’s complete anime filmography, from first credit to latest.</p></div><div className="how-card"><span className="step">03</span><h3>Compare two casts</h3><p>Find exactly which actors appear in both anime or franchises.</p></div></section> :
    <section className="workspace" id="cast">
      <div className="selection-head"><div className="cover-stack">{activeSeries.slice(0, 3).reverse().map((anime) => <img src={anime.coverImage.large} alt={`${title(anime)} cover`} loading="lazy" decoding="async" key={anime.id} />)}</div><div><div className="selection-kicker">Exploring</div><h2>{title(primary)}</h2><div className="selection-meta">{scope === "series" ? `${series.length} connected anime · ${actors.length} unique voice actors` : `${primary.seasonYear || primary.startDate.year || "Year unknown"} · ${pretty(primary.format)} · ${actors.length} voice actors`}</div></div><div className="filters"><div className="select-wrap"><label htmlFor="scope">Scope</label><select id="scope" value={scope} onChange={(e) => changeScope(e.target.value as "entry" | "series")}><option value="series">Full series</option><option value="entry">This entry</option></select></div><div className="select-wrap"><label htmlFor="language">Dub</label><select id="language" value={language} onChange={(e) => changeLanguage(e.target.value)}><option value="JAPANESE">Japanese</option><option value="ENGLISH">English</option><option value="KOREAN">Korean</option><option value="FRENCH">French</option><option value="GERMAN">German</option><option value="SPANISH">Spanish</option><option value="PORTUGUESE">Portuguese</option></select></div></div></div>
      {seriesLoading && <div className="series-loading">Linking seasons, OVAs, and related entries…</div>}
      {scope === "series" && series.length > 1 && <div className="series-tabs">{series.map((anime) => <div className="series-tab" key={anime.id}><img src={anime.coverImage.medium || anime.coverImage.large} alt={`${title(anime)} cover`} loading="lazy" decoding="async" /><span>{title(anime)}<small>{anime.startDate.year || "TBA"} · {pretty(anime.format)}</small></span></div>)}</div>}
      {scope === "series" && series.length >= MAX_FRANCHISE_ENTRIES && <div className="limit-note">Showing the first {MAX_FRANCHISE_ENTRIES} connected entries to keep large franchises responsive.</div>}
      <div className="view-tabs"><button className={view === "cast" ? "active" : ""} onClick={() => setView("cast")}>Cast & filmographies</button><button className={view === "overlap" ? "active" : ""} onClick={() => { setView("overlap"); if (comparisons.length < 1) setSearchTarget("compare"); }}>Compare casts {comparisons.length > 0 && <span>{overlap.length}</span>}</button></div>
      {view === "overlap" ? <Comparison primary={primary} comparisons={comparisons} overlap={overlap} scope={scope} primaryCount={activeSeries.length} remove={() => { setComparisons([]); writeUrl(primary.id); }} addMore={() => { setSearchTarget("compare"); document.querySelector<HTMLInputElement>('[aria-label="Anime title"]')?.focus(); }} /> : <>
        <div className="cast-intro"><h3>Voice cast</h3><div className="select-wrap"><label htmlFor="role">Filmography</label><select id="role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}><option value="ALL">All roles</option><option value="MAIN">Main only</option><option value="SUPPORTING">Supporting</option><option value="BACKGROUND">Background</option></select></div></div>
        <div className="cast-list">{actors.length === 0 && <div className="notice">No {language.toLowerCase()} cast is listed for this selection.</div>}{actors.map((actor) => {
          const isOpen = openActor === actor.id;
          const filtered = (credits[actor.id] || []).filter((credit) => roleFilter === "ALL" || credit.characterRole === roleFilter);
          const current = actor.appearances[0];
          const characters = uniqueCharacters(actor);
          return <article className="actor-card" key={actor.id}>
            <div className="actor-summary">
              <a className="actor-profile" href={actorUrl(actor.id)} target="_blank" rel="noreferrer" aria-label={`${actor.name.full} on AniList`}>
                <img className="actor-photo" src={actor.image.large} alt={actor.name.full} loading="lazy" decoding="async" />
                <span><span className="actor-name">{actor.name.full}</span><span className="actor-language">{actor.languageV2 || pretty(language)}</span></span>
              </a>
              <span className="current-role">
                <a href={characterUrl(current.character.id)} target="_blank" rel="noreferrer" aria-label={`${current.character.name.full} on AniList`}><img className="char-photo" src={current.character.image.large} alt={current.character.name.full} loading="lazy" decoding="async" /></a>
                <span><span className="role-label">In this selection · {pretty(current.role)}</span><span className="role-name">{characters.map((character, index) => <span key={character.id}>{index > 0 && ", "}<a href={characterUrl(character.id)} target="_blank" rel="noreferrer">{character.name.full}</a></span>)}</span></span>
              </span>
              <button className="expand-label" onClick={() => toggleActor(actor)} aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} all roles for ${actor.name.full}`}>All roles <span className={`chevron ${isOpen ? "open" : ""}`}>⌄</span></button>
            </div>
            {isOpen && <div className="credits">{loadingActor === actor.id ? <div className="loading-row">Loading up to {MAX_FILMOGRAPHY_CREDITS} filmography credits…</div> : <>
              <div className="credits-title"><strong>Complete anime filmography</strong><span>{filtered.length} matching credits{limitedCredits[actor.id] ? ` · first ${MAX_FILMOGRAPHY_CREDITS} shown` : ""}</span></div>
              {filtered.length ? <div className="credit-grid">{filtered.map((credit) => <div className="credit" key={credit.node.id}><img src={credit.node.coverImage.medium || credit.node.coverImage.large} alt={`${title(credit.node)} cover`} loading="lazy" decoding="async" /><div><div className="credit-anime">{title(credit.node)}</div><div className="credit-char">{credit.characters?.length ? credit.characters.map((character, index) => <span key={character.id}>{index > 0 && ", "}<a href={characterUrl(character.id)} target="_blank" rel="noreferrer">{character.name.full}</a></span>) : "Character role"}</div>{credit.characterRole && <span className="role-chip">{pretty(credit.characterRole)}</span>}</div><span className="year">{credit.node.startDate.year || "TBA"}</span></div>)}</div> : <div className="notice">No roles matched this filter.</div>}
            </>}</div>}
          </article>;
        })}</div><p className="footer-note">Credits and franchise relationships come from AniList. Complete filmographies may take a moment for prolific actors.</p></>}
    </section>}
  </main>;
}

function groupActors(animeList: AnimeDetail[]): ActorRow[] {
  const grouped = new Map<number, ActorRow>();
  for (const anime of animeList) for (const edge of anime.characters.edges) for (const actor of edge.voiceActors || []) {
    const row = grouped.get(actor.id) || { ...actor, appearances: [] };
    if (!row.appearances.some((a) => a.anime.id === anime.id && a.character.id === edge.node.id)) row.appearances.push({ anime, character: edge.node, role: edge.role });
    grouped.set(actor.id, row);
  }
  return [...grouped.values()];
}

function Comparison({ primary, comparisons, overlap, scope, primaryCount, remove, addMore }: { primary: Anime; comparisons: ComparisonSelection[]; overlap: SharedActor[]; scope: "entry" | "series"; primaryCount: number; remove: (id: number) => void; addMore: () => void }) {
  if (!comparisons.length) return <div className="comparison-empty"><div className="compare-icon">⇄</div><h3>Add one anime to compare</h3><p>Choose “Add comparison” above. VoiceTrail will show the actors shared by both anime or franchises.</p></div>;
  const selections = [{ root: primary, count: primaryCount }, ...comparisons.map((item) => ({ root: item.root, count: scope === "series" ? item.series.length : 1 }))];
  return <div className="comparison-panel">
    <div className="comparison-toolbar"><div><strong>{selections.length} anime compared</strong><span>Actors must appear in both selected casts</span></div>{selections.length < 2 && <button onClick={addMore}>+ Add another anime</button>}</div>
    <div className="comparison-selections">{selections.map((item, index) => <div className="comparison-selection" key={item.root.id}><span className="selection-number">{index + 1}</span><img src={item.root.coverImage.large} alt={`${title(item.root)} cover`} loading="lazy" decoding="async" /><strong>{title(item.root)}{scope === "series" ? <small>{item.count} {item.count === 1 ? "entry" : "entries"}</small> : null}</strong>{index > 0 && <button onClick={() => remove(item.root.id)} aria-label={`Remove ${title(item.root)} from comparison`}>×</button>}</div>)}</div>
    <div className="overlap-head"><h3>{overlap.length} shared voice {overlap.length === 1 ? "actor" : "actors"}</h3><p>Shared across all {selections.length} selected casts in the chosen dub</p></div>
    {overlap.length ? <div className="overlap-grid">{overlap.map(({ actor, matches }) => <article className="overlap-card" key={actor.id}>
      <a className="overlap-actor" href={actorUrl(actor.id)} target="_blank" rel="noreferrer" aria-label={`${actor.name.full} on AniList`}><img src={actor.image.large} alt={actor.name.full} loading="lazy" decoding="async" /><span className="overlap-name">{actor.name.full}</span></a>
      <div className="role-pair">{[actor, ...matches].map((row, index) => {
        const characters = uniqueCharacters(row);
        const firstCharacter = characters[0];
        return <div key={selections[index].root.id}><a href={characterUrl(firstCharacter.id)} target="_blank" rel="noreferrer" aria-label={`${firstCharacter.name.full} on AniList`}><img className="overlap-character" src={firstCharacter.image.large} alt={firstCharacter.name.full} loading="lazy" decoding="async" /></a><div className="role-detail"><span>In {title(selections[index].root)}</span><strong>{characters.map((character, characterIndex) => <span className="character-link-wrap" key={character.id}>{characterIndex > 0 && ", "}<a href={characterUrl(character.id)} target="_blank" rel="noreferrer">{character.name.full}</a></span>)}</strong></div></div>;
      })}</div>
    </article>)}</div> : <div className="notice">No actors appear in both selected casts for this dub.</div>}
  </div>;
}
