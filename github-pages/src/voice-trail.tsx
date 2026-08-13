"use client";

import { FormEvent, useMemo, useState } from "react";

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
type Credit = { characterRole?: "MAIN" | "SUPPORTING" | "BACKGROUND" | null; characters?: { name: { full: string } }[]; node: Anime };
type ActorRow = Actor & { appearances: { anime: Anime; character: Character; role: string }[] };

const API = "https://graphql.anilist.co";
const FRANCHISE_LINKS = new Set(["PREQUEL", "SEQUEL", "SIDE_STORY", "SPIN_OFF", "PARENT"]);

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query, variables }) });
    const payload = await response.json();
    if (response.ok && !payload.errors) return payload.data as T;
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      await new Promise((resolve) => window.setTimeout(resolve, Math.max(retryAfter * 1000, 700 * (attempt + 1))));
      continue;
    }
    throw new Error(payload.errors?.[0]?.message || "AniList could not be reached.");
  }
  throw new Error("AniList could not be reached.");
}

const SEARCH_QUERY = `query ($search: String!) { Page(page: 1, perPage: 8) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { id type title { userPreferred english } coverImage { large medium } startDate { year month day } seasonYear format } } }`;
const ANIME_QUERY = `query ($id: Int!, $language: StaffLanguage!, $page: Int!) { Media(id: $id, type: ANIME) { id type title { userPreferred english } coverImage { large medium } startDate { year month day } seasonYear format relations { edges { relationType(version: 2) node { id type title { userPreferred english } coverImage { large medium } startDate { year month day } seasonYear format } } } characters(page: $page, perPage: 25, sort: [ROLE, RELEVANCE]) { pageInfo { hasNextPage } edges { role node { id name { full } image { large } } voiceActors(language: $language, sort: [RELEVANCE]) { id name { full } image { large } languageV2 } } } } }`;
const CREDITS_QUERY = `query ($id: Int!, $page: Int!) { Staff(id: $id) { characterMedia(page: $page, perPage: 25, sort: [START_DATE_DESC]) { pageInfo { hasNextPage } edges { characterRole characters { name { full } } node { id type title { userPreferred english } coverImage { large medium } startDate { year month day } seasonYear format } } } } }`;

function pretty(value?: string | null) { return value ? value.replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase()) : "Anime"; }
function title(anime: Anime) { return anime.title.english || anime.title.userPreferred; }

export function VoiceTrail() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Anime[]>([]);
  const [series, setSeries] = useState<AnimeDetail[]>([]);
  const [comparison, setComparison] = useState<AnimeDetail | null>(null);
  const [comparisonSeries, setComparisonSeries] = useState<AnimeDetail[]>([]);
  const [searchTarget, setSearchTarget] = useState<"primary" | "compare">("primary");
  const [scope, setScope] = useState<"entry" | "series">("series");
  const [language, setLanguage] = useState("JAPANESE");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [view, setView] = useState<"cast" | "overlap">("cast");
  const [openActor, setOpenActor] = useState<number | null>(null);
  const [credits, setCredits] = useState<Record<number, Credit[]>>({});
  const [loadingActor, setLoadingActor] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingAnime, setLoadingAnime] = useState(false);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [error, setError] = useState("");

  const activeSeries = scope === "series" ? series : series.slice(0, 1);
  const actors = useMemo(() => groupActors(activeSeries), [activeSeries]);
  const comparisonActors = useMemo(() => comparison ? groupActors(scope === "series" ? comparisonSeries : [comparison]) : [], [comparison, comparisonSeries, scope]);
  const overlap = useMemo(() => {
    const other = new Map(comparisonActors.map((actor) => [actor.id, actor]));
    return actors.filter((actor) => other.has(actor.id)).map((actor) => ({ left: actor, right: other.get(actor.id)! }));
  }, [actors, comparisonActors]);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true); setError(""); setResults([]);
    try { const data = await gql<{ Page: { media: Anime[] } }>(SEARCH_QUERY, { search: query.trim() }); setResults(data.Page.media); if (!data.Page.media.length) setError("No anime matched that title. Try a shorter title."); }
    catch (err) { setError(err instanceof Error ? err.message : "Search failed."); }
    finally { setSearching(false); }
  }

  async function getAnime(id: number, nextLanguage = language) {
    let page = 1;
    const first = (await gql<{ Media: AnimeDetail }>(ANIME_QUERY, { id, language: nextLanguage, page })).Media;
    const edges = [...first.characters.edges];
    let more = first.characters.pageInfo.hasNextPage;
    while (more) {
      page += 1;
      const next = (await gql<{ Media: AnimeDetail }>(ANIME_QUERY, { id, language: nextLanguage, page })).Media;
      edges.push(...next.characters.edges);
      more = next.characters.pageInfo.hasNextPage;
    }
    return { ...first, characters: { pageInfo: { hasNextPage: false }, edges } };
  }

  async function collectFranchise(first: AnimeDetail, nextLanguage = language) {
    const loaded = new Map<number, AnimeDetail>([[first.id, first]]);
    const queued: Anime[] = first.relations.edges.filter((e) => FRANCHISE_LINKS.has(e.relationType) && e.node.type === "ANIME").map((e) => e.node);
    while (queued.length) {
      const next = queued.shift()!;
      if (loaded.has(next.id)) continue;
      const detail = await getAnime(next.id, nextLanguage);
      loaded.set(detail.id, detail);
      for (const edge of detail.relations.edges) if (FRANCHISE_LINKS.has(edge.relationType) && edge.node.type === "ANIME" && !loaded.has(edge.node.id)) queued.push(edge.node);
    }
    return [...loaded.values()].sort((a, b) => (a.startDate.year || 9999) - (b.startDate.year || 9999));
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
      if (searchTarget === "compare") { setComparison(detail); setComparisonSeries([detail]); setView("overlap"); if (scope === "series") setComparisonSeries(await collectFranchise(detail)); }
      else { setSeries([detail]); setComparison(null); setComparisonSeries([]); setView("cast"); await loadFranchise(detail); }
      setQuery("");
      window.setTimeout(() => document.getElementById("cast")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch (err) { setError(err instanceof Error ? err.message : "Cast lookup failed."); setSeriesLoading(false); }
    finally { setLoadingAnime(false); }
  }

  async function changeLanguage(next: string) {
    setLanguage(next); setCredits({}); setOpenActor(null); setLoadingAnime(true);
    try {
      if (series[0]) { const fresh = await getAnime(series[0].id, next); setSeries([fresh]); if (scope === "series") await loadFranchise(fresh, next); }
      if (comparison) { const freshComparison = await getAnime(comparison.id, next); setComparison(freshComparison); setComparisonSeries(scope === "series" ? await collectFranchise(freshComparison, next) : [freshComparison]); }
    } catch (err) { setError(err instanceof Error ? err.message : "Dub lookup failed."); }
    finally { setLoadingAnime(false); }
  }

  async function changeScope(next: "entry" | "series") {
    setScope(next);
    if (next === "series" && comparison && comparisonSeries.length <= 1) {
      setSeriesLoading(true);
      try { setComparisonSeries(await collectFranchise(comparison)); }
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
      const found: Credit[] = []; let page = 1; let more = true;
      while (more) {
        const data = await gql<{ Staff: { characterMedia: { pageInfo: { hasNextPage: boolean }; edges: Credit[] } } }>(CREDITS_QUERY, { id: actor.id, page });
        found.push(...data.Staff.characterMedia.edges); more = data.Staff.characterMedia.pageInfo.hasNextPage; page += 1;
      }
      setCredits((current) => ({ ...current, [actor.id]: [...new Map(found.map((item) => [item.node.id, item])).values()] }));
    } catch (err) { setError(err instanceof Error ? err.message : "Filmography could not be loaded."); }
    finally { setLoadingActor(null); }
  }

  const primary = series[0];
  return <main className="site-shell">
    <nav className="nav" aria-label="Main navigation"><div className="brand"><span className="brand-mark">V</span> VoiceTrail</div><span className="source-pill">Powered by AniList data</span></nav>
    <section className="hero"><div className="eyebrow">Follow every voice, across every role</div><h1>Where else have you<br />heard that <span className="accent">voice?</span></h1><p className="hero-copy">Explore complete voice-actor filmographies, roll an entire series into one cast, or compare two anime to find the actors they share.</p></section>
    <section className="search-wrap" aria-label="Anime search">
      {primary && <div className="search-mode"><button className={searchTarget === "primary" ? "active" : ""} onClick={() => setSearchTarget("primary")}>Choose anime</button><button className={searchTarget === "compare" ? "active" : ""} onClick={() => setSearchTarget("compare")}>Add comparison</button></div>}
      <form className="search-box" onSubmit={search}><input aria-label="Anime title" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchTarget === "compare" ? "Search the anime to compareâ€¦" : "Try â€œFrierenâ€ or â€œMushoku Tenseiâ€"} autoComplete="off" /><button className="primary-btn" disabled={searching || loadingAnime}>{searching ? "Searchingâ€¦" : "Find anime"}</button></form>
      {results.length > 0 && <div className="results-popover" role="listbox" aria-label="Anime matches">{results.map((anime) => <button className="result-row" key={anime.id} onClick={() => chooseAnime(anime)} role="option" aria-selected="false"><img src={anime.coverImage.medium || anime.coverImage.large} alt="" /><span><span className="result-title">{title(anime)}</span><span className="result-meta">{anime.seasonYear || anime.startDate.year || "Year unknown"} Â· {pretty(anime.format)}</span></span><span className="result-arrow">â†’</span></button>)}</div>}
      {error && <div className="error" role="alert">{error}</div>}
    </section>

    {!primary ? <section className="empty-demo" aria-label="How it works"><div className="how-card"><span className="step">01</span><h3>Explore a whole series</h3><p>Merge connected seasons, OVAs, ONAs, specials, side stories, and spin-offs.</p></div><div className="how-card"><span className="step">02</span><h3>See every role</h3><p>Open an actorâ€™s complete anime filmography, from first credit to latest.</p></div><div className="how-card"><span className="step">03</span><h3>Compare two casts</h3><p>Find exactly which actors appear in both anime or franchises.</p></div></section> :
    <section className="workspace" id="cast">
      <div className="selection-head"><div className="cover-stack">{activeSeries.slice(0, 3).reverse().map((anime) => <img src={anime.coverImage.large} alt="" key={anime.id} />)}</div><div><div className="selection-kicker">Exploring</div><h2>{title(primary)}</h2><div className="selection-meta">{scope === "series" ? `${series.length} connected anime Â· ${actors.length} unique voice actors` : `${primary.seasonYear || primary.startDate.year || "Year unknown"} Â· ${pretty(primary.format)} Â· ${actors.length} voice actors`}</div></div><div className="filters"><div className="select-wrap"><label htmlFor="scope">Scope</label><select id="scope" value={scope} onChange={(e) => changeScope(e.target.value as "entry" | "series")}><option value="series">Full series</option><option value="entry">This entry</option></select></div><div className="select-wrap"><label htmlFor="language">Dub</label><select id="language" value={language} onChange={(e) => changeLanguage(e.target.value)}><option value="JAPANESE">Japanese</option><option value="ENGLISH">English</option><option value="KOREAN">Korean</option><option value="FRENCH">French</option><option value="GERMAN">German</option><option value="SPANISH">Spanish</option><option value="PORTUGUESE">Portuguese</option></select></div></div></div>
      {seriesLoading && <div className="series-loading">Linking seasons, OVAs, and related entriesâ€¦</div>}
      {scope === "series" && series.length > 1 && <div className="series-tabs">{series.map((anime) => <div className="series-tab" key={anime.id}><img src={anime.coverImage.medium || anime.coverImage.large} alt="" /><span>{title(anime)}<small>{anime.startDate.year || "TBA"} Â· {pretty(anime.format)}</small></span></div>)}</div>}
      <div className="view-tabs"><button className={view === "cast" ? "active" : ""} onClick={() => setView("cast")}>Cast & filmographies</button><button className={view === "overlap" ? "active" : ""} onClick={() => { setView("overlap"); setSearchTarget("compare"); }}>Compare casts {comparison && <span>{overlap.length}</span>}</button></div>
      {view === "overlap" ? <Comparison primary={primary} comparison={comparison} overlap={overlap} scope={scope} primaryCount={activeSeries.length} comparisonCount={scope === "series" ? comparisonSeries.length : comparison ? 1 : 0} remove={() => { setComparison(null); setComparisonSeries([]); }} /> : <>
        <div className="cast-intro"><h3>Voice cast</h3><div className="select-wrap"><label htmlFor="role">Filmography</label><select id="role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}><option value="ALL">All roles</option><option value="MAIN">Main only</option><option value="SUPPORTING">Supporting</option><option value="BACKGROUND">Background</option></select></div></div>
        <div className="cast-list">{actors.length === 0 && <div className="notice">No {language.toLowerCase()} cast is listed for this selection.</div>}{actors.map((actor) => {
          const isOpen = openActor === actor.id; const filtered = (credits[actor.id] || []).filter((c) => roleFilter === "ALL" || c.characterRole === roleFilter); const current = actor.appearances[0];
          return <article className="actor-card" key={actor.id}><button className="actor-summary" onClick={() => toggleActor(actor)} aria-expanded={isOpen}><img className="actor-photo" src={actor.image.large} alt="" /><span><span className="actor-name">{actor.name.full}</span><span className="actor-language">{actor.languageV2 || pretty(language)}</span></span><span className="current-role"><img className="char-photo" src={current.character.image.large} alt="" /><span><span className="role-label">In this selection Â· {pretty(current.role)}</span><span className="role-name">{[...new Set(actor.appearances.map((a) => a.character.name.full))].join(", ")}</span></span></span><span className="expand-label">All roles <span className={`chevron ${isOpen ? "open" : ""}`}>âŒ„</span></span></button>{isOpen && <div className="credits">{loadingActor === actor.id ? <div className="loading-row">Loading the complete filmographyâ€¦</div> : <><div className="credits-title"><strong>Complete anime filmography</strong><span>{filtered.length} matching credits</span></div>{filtered.length ? <div className="credit-grid">{filtered.map((credit) => <div className="credit" key={credit.node.id}><img src={credit.node.coverImage.medium || credit.node.coverImage.large} alt="" /><div><div className="credit-anime">{title(credit.node)}</div><div className="credit-char">{credit.characters?.map((c) => c.name.full).join(", ") || "Character role"}</div>{credit.characterRole && <span className="role-chip">{pretty(credit.characterRole)}</span>}</div><span className="year">{credit.node.startDate.year || "TBA"}</span></div>)}</div> : <div className="notice">No roles matched this filter.</div>}</>}</div>}</article>;
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

function Comparison({ primary, comparison, overlap, scope, primaryCount, comparisonCount, remove }: { primary: Anime; comparison: AnimeDetail | null; overlap: { left: ActorRow; right: ActorRow }[]; scope: "entry" | "series"; primaryCount: number; comparisonCount: number; remove: () => void }) {
  if (!comparison) return <div className="comparison-empty"><div className="compare-icon">â‡„</div><h3>Add another anime to compare</h3><p>Use â€œAdd comparisonâ€ above, then search for something like Mushoku Tensei. VoiceTrail will reveal every actor shared by both casts.</p></div>;
  return <div className="comparison-panel"><div className="versus"><div><img src={primary.coverImage.large} alt="" /><strong>{title(primary)}{scope === "series" ? ` Â· ${primaryCount} entries` : ""}</strong></div><span>and</span><div><img src={comparison.coverImage.large} alt="" /><strong>{title(comparison)}{scope === "series" ? ` Â· ${comparisonCount} entries` : ""}</strong><button onClick={remove} aria-label="Remove comparison">Ã—</button></div></div><div className="overlap-head"><h3>{overlap.length} shared voice {overlap.length === 1 ? "actor" : "actors"}</h3><p>Matching actor identities in the selected dub</p></div>{overlap.length ? <div className="overlap-grid">{overlap.map(({ left, right }) => <article className="overlap-card" key={left.id}><img src={left.image.large} alt="" /><div className="overlap-name">{left.name.full}</div><div className="role-pair"><div><span>In {title(primary)}</span><strong>{[...new Set(left.appearances.map((a) => a.character.name.full))].join(", ")}</strong></div><div><span>In {title(comparison)}</span><strong>{[...new Set(right.appearances.map((a) => a.character.name.full))].join(", ")}</strong></div></div></article>)}</div> : <div className="notice">No shared actors were found for these casts and the selected dub.</div>}</div>;
}

