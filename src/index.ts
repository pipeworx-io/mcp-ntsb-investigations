interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * NTSB Investigations — aviation accident/incident investigations by
 * registration (tail) number or aircraft make/model. Fleet #2791.
 *
 * SOURCE: the NTSB's own eADMS aviation accident database, published as a
 * Microsoft Access (.mdb) bulk file at
 *   https://data.ntsb.gov/avdata/FileDirectory/DownloadFile?fileID=C%3A%5Cavdata%5Cavall.zip
 * (confirmed live 2026-10-07, ~96 MB zipped / ~561 MB unzipped, 31,620 events /
 * 31,854 aircraft rows at that pull). This is the route CLAUDE.md's standing
 * bulk-data rule calls for: "the source only publishes bulk files" is a
 * reason to flatten and serve them ourselves, not a reason to stop.
 *
 * CAROL (data.ntsb.gov/carol-main-public), the modern search UI, was probed
 * first per the task's own instruction. Its JSON endpoint
 * (api/Query/Main and api/Query/FileExport) is UNDOCUMENTED and returned HTTP
 * 500 "An unknown exception occured." / "An error has occurred." against
 * every QueryGroups/QueryRules shape reverse-engineered from a public
 * NTSB_api GitHub proxy and from the CAROL-Guide.pdf's end-user field list —
 * CAROL's own frontend never ships a devtools-free schema and the server
 * gives no hint why the shape it wants differs. NTSB also runs a NEWER
 * official REST API at developer.ntsb.gov (Aviation/Safety-Recommendations/
 * Data-Dictionary APIs via an Azure APIM gateway at api.ntsb.gov), but that
 * portal requires a signed-up developer account + subscription key before
 * any "Try it" call succeeds — an auth wall, not merely an undocumented
 * shape, and per CLAUDE.md's robots/auth rules an account wall is never a
 * free pass to build around; it would need its own key decision. The bulk
 * avall.zip has neither problem: no login, no undocumented request shape,
 * explicitly public, and it is the SAME data CAROL serves (eADMS/avdata is
 * the dataset CAROL's aviation lens queries).
 *
 * SCHEMA (mdb-schema against avall.mdb, not guessed): `events` keyed by
 * ev_id carries ntsb_no/ev_date/ev_city/ev_state/ev_country/
 * ev_highest_injury; `aircraft` keyed by (ev_id, Aircraft_Key) carries
 * regis_no/acft_make/acft_model/acft_series/damage; `narratives` carries
 * narr_cause (primary) / narr_accp (probable-cause narrative, used as
 * fallback) per (ev_id, Aircraft_Key); `Events_Sequence` carries a
 * human-readable `Occurrence_Description` ("Landing-flare/touchdown Loss of
 * control on ground") per occurrence, with `Defining_ev` flagging the
 * primary one; `Findings` carries one `finding_description` row per
 * (ev_id, Aircraft_Key, finding_no) with a Cause_Factor flag ('C'ause or
 * 'F'actor). Injury codes (FATL/SERS/MINR/NONE/UNK) are mapped via the
 * mdb's own eADMSPUB_DataDictionary table, not hardcoded from memory.
 *
 * DOCKET LINK: https://data.ntsb.gov/Docket/?NTSBNumber=<ntsb_no> — confirmed
 * live (HTTP 200, real docket-management-system HTML) for a real ntsb_no
 * pulled from this same mdb (ERA24LA090). The docket page is where NTSB
 * publishes the final report and supporting documents for a case; there is
 * no separate "report PDF" URL pattern that does not require knowing which
 * document id the docket assigned, so this one link is both.
 *
 * REGISTRATION REUSE: N-numbers are reassigned over time, so `registration`
 * can legitimately match more than one unrelated aircraft/event. This tool
 * does NOT silently collapse them: every match is returned with its own
 * ev_date, and an optional `year` argument narrows to the matching
 * incarnation(s) rather than guessing which one the caller means.
 *
 * STORAGE — SHARDED, not one object (PM review, fleet #2791 follow-up): the
 * dataset originally shipped as a single 27 MB `ntsb/aviation-cases.json`
 * blob, fully re-fetched and JSON.parsed on EVERY call, with deliberately no
 * module-scope cache (see below) — which meant two concurrent calls held two
 * ~27 MB parses in the same isolate at once, the #2754/#2755 failure class
 * against a 128 MB isolate ceiling. Replaced with:
 *   - `ntsb/manifest.json` (~200 KB) — for every make, either
 *     `{type:"flat", slug}`, `{type:"by_year", slug, years:[...]}` (only
 *     CESSNA needs this, at this pull — its flat shard would be ~6 MB), or
 *     `{type:"bucket", bucket}` for the ~3,800 makes with under 5 rows each,
 *     which share OTHER_BUCKET_COUNT small pooled shards rather than one
 *     file apiece (a 4,100-file refresh for no byte savings otherwise).
 *   - `ntsb/by-registration.json` (~1.4 MB) — normalised registration ->
 *     the distinct (make, year) pairs it appears under. The one index a
 *     registration query needs to know WHICH shard(s) to open.
 *   - `ntsb/by-make/<slug>.json` / `.../<slug>/<year>.json` /
 *     `.../_other/<bucket>.json` — the actual case arrays, each at most a
 *     few MB (the largest at this pull: PIPER, 3.74 MB).
 * A make/model query reads the manifest + exactly one shard (two R2 objects)
 * in the common case. A registration query reads the manifest, the
 * registration index, and the (typically one, occasionally a few — N-number
 * reuse is rare but real, see below) distinct shard(s) its matches resolve
 * to. Neither path ever reads the old monolith, which scripts/refresh.mjs
 * deletes from the bucket once the shards are up. Built by
 * scripts/refresh.mjs from a fresh avall.zip pull; see that file for the
 * exact shard layout. No Supabase migration — storage is R2-only.
 *
 * NO MODULE-SCOPE CACHE, ON PURPOSE: caching a parsed shard across calls in
 * a `let` at module scope would reintroduce the same isolate-memory problem
 * one shard at a time instead of one 27 MB blob at a time — still unbounded
 * with enough distinct makes/years touched in one isolate's lifetime. Every
 * call re-fetches what it needs; the fix is that what it needs is now small
 * (a few MB at most), not that it is remembered.
 *
 * UNBOUNDED QUERIES ARE REFUSED, NOT SERVED SLOWLY: a bare `make` whose
 * shard is year-split (CESSNA: 19 year-files) with no `year` and no `model`
 * would need to read every year-shard for that make — not a full dataset
 * scan, but not a bounded couple of objects either. MAX_YEAR_SHARD_FANOUT
 * caps this; past the cap the tool asks for `year` (or a `model`, which does
 * not change which shards get read but narrows the point of asking) rather
 * than silently fanning out across a growing number of objects.
 *
 * This file makes NO outbound network call — there is no live upstream in
 * the request path, only R2 reads — so `pnpm check:fetch-timeout` and
 * `check:user-agent` have nothing to enforce here.
 */

const DOCKET_URL = (ntsbNo: string) => `https://data.ntsb.gov/Docket/?NTSBNumber=${encodeURIComponent(ntsbNo)}`;
const SOURCE_URL = 'https://data.ntsb.gov/avdata';

const MANIFEST_KEY = 'ntsb/manifest.json';
const REG_INDEX_KEY = 'ntsb/by-registration.json';

// Past this many distinct candidate makes (exact + substring fallback), the
// query is too broad to answer with a bounded read — ask for a narrower make.
const MAX_MAKE_CANDIDATES = 5;
// Past this many year-shards for ONE make, a bare make-only (no year, no
// model) query is refused rather than fanning out across that many objects.
const MAX_YEAR_SHARD_FANOUT = 8;
// Registration reuse is rare (1,000 of 30,566 registrations had more than
// one distinct (make, year) pairing at the 2026-10-07 pull, virtually all
// of those exactly two) — this is headroom, not an expected ceiling, and
// exists only so a pathological index entry can never turn into an
// unbounded fan-out.
const MAX_REG_SHARDS = 8;

// Past this many distinct calendar years, a date-range query for
// ntsb_accidents_by_period is refused rather than fanning out across that
// many by-year shards — ask for a narrower range instead.
const MAX_PERIOD_YEAR_FANOUT = 8;
// Cap on individual records returned by ntsb_accidents_by_period. The
// per-state counts in `by_state` always reflect every match, capped or not.
const MAX_PERIOD_RESULTS = 200;

interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

type ShardRef =
  | { type: 'flat'; slug: string }
  | { type: 'by_year'; slug: string; years: string[] }
  | { type: 'bucket'; bucket: number };

type YearShardRef = { type: 'flat' } | { type: 'by_month'; months: string[] };

interface Manifest {
  data_as_of: string;
  source: string;
  record_count: number;
  shard_count: number;
  makes: Record<string, ShardRef>;
  /** Cross-make index for date-range/state/injury-level queries (fleet
   *  #3285) — absent on a manifest built before this field existed, so
   *  callers must treat a missing `years` map as "no period data yet", not
   *  throw. */
  years?: Record<string, YearShardRef>;
}

type RegIndex = Record<string, { make: string; year: number | null }[]>;

interface NtsbCase {
  ev_id: string;
  aircraft_key: number;
  ntsb_number: string | null;
  event_date: string | null; // ISO yyyy-mm-dd
  city: string | null;
  state: string | null;
  country: string | null;
  injury_level: string | null; // meaning, e.g. "Serious"
  injury_code: string | null; // raw code, e.g. "SERS"
  registration: string | null;
  make: string | null;
  model: string | null;
  series: string | null;
  damage: string | null;
  occurrence: string | null;
  probable_cause: string | null;
  findings: { factor: 'cause' | 'factor' | 'unknown'; description: string }[];
}

function r2FromArgs(args: Record<string, unknown>): R2Like | undefined {
  return args._r2 as R2Like | undefined;
}

/**
 * A missing `_r2` binding (a standalone `npm install` of this pack, or a
 * local harness with no gateway/no Cloudflare credential) is NOT the
 * "transport or parse failure" the loud-error rule targets — it is the same
 * "runs only inside the gateway" case mcps/indiana-code's in_code_search
 * already handles by returning `search_unavailable` rather than throwing.
 * Once a binding IS present, a failed read or corrupt payload is a real
 * infra problem and throws loud instead (see readJson below).
 */
const DATASET_UNAVAILABLE = {
  found: false,
  reason: 'dataset_unavailable',
  message:
    'ntsb-investigations requires the Pipeworx gateway, which injects the shared dataset ' +
    'bucket (R2) this pack reads from. There is no live fallback because the upstream ' +
    '(data.ntsb.gov/avdata) ships only bulk MDB files, not a callable search API.',
} as const;

async function readJson<T>(r2: R2Like, key: string): Promise<T> {
  let obj: { text(): Promise<string> } | null;
  try {
    obj = await r2.get(key);
  } catch (e) {
    throw new Error(`ntsb-investigations: R2 read of ${key} failed: ${(e as Error).message}`);
  }
  if (!obj) {
    throw new Error(
      `ntsb-investigations: ${key} does not exist in the dataset bucket — the pack has not ` +
        'been loaded yet (run scripts/refresh.mjs in mcps/ntsb-investigations).',
    );
  }
  try {
    return JSON.parse(await obj.text()) as T;
  } catch (e) {
    throw new Error(`ntsb-investigations: ${key} is not valid JSON: ${(e as Error).message}`);
  }
}

async function loadManifest(r2: R2Like): Promise<Manifest> {
  const m = await readJson<Manifest>(r2, MANIFEST_KEY);
  if (!m || typeof m.makes !== 'object' || m.makes === null) {
    throw new Error(`ntsb-investigations: ${MANIFEST_KEY} is missing its "makes" map — corrupt or wrong-shaped object.`);
  }
  return m;
}

async function loadRegIndex(r2: R2Like): Promise<RegIndex> {
  const idx = await readJson<RegIndex>(r2, REG_INDEX_KEY);
  if (!idx || typeof idx !== 'object') {
    throw new Error(`ntsb-investigations: ${REG_INDEX_KEY} is not an object — corrupt or wrong-shaped.`);
  }
  return idx;
}

async function loadShard(r2: R2Like, key: string): Promise<NtsbCase[]> {
  const arr = await readJson<NtsbCase[]>(r2, key);
  if (!Array.isArray(arr)) {
    throw new Error(`ntsb-investigations: shard ${key} is not an array — corrupt or wrong-shaped.`);
  }
  return arr;
}

function normalize(s: string | null | undefined): string {
  return (s ?? '').trim().toUpperCase();
}

function normalizeReg(s: string | null | undefined): string {
  return normalize(s).replace(/[\s-]/g, '');
}

function shardKey(ref: ShardRef): string {
  if (ref.type === 'flat') return `ntsb/by-make/${ref.slug}.json`;
  if (ref.type === 'bucket') return `ntsb/by-make/_other/${ref.bucket}.json`;
  throw new Error('shardKey: by_year refs need a year — use yearShardKey');
}

function yearShardKey(ref: { slug: string }, year: string): string {
  return `ntsb/by-make/${ref.slug}/${year}.json`;
}

function byYearShardKey(year: string): string {
  return `ntsb/by-year/${year}.json`;
}

function byYearMonthShardKey(year: string, month: string): string {
  return `ntsb/by-year/${year}/${month}.json`;
}

/** Normalize a date-range endpoint to a full "YYYY-MM-DD" bound. Accepts
 *  "YYYY", "YYYY-MM", or "YYYY-MM-DD" and widens to the given edge of the
 *  period ("start" -> Jan 1 / day 01, "end" -> Dec 31 / day 31). The day-31
 *  upper bound is safe even for shorter months — it is only ever used in a
 *  lexicographic string comparison against real ISO event dates, none of
 *  which is an invalid calendar date, so "2024-02-15" <= "2024-02-31" still
 *  resolves correctly without any calendar-aware day-count logic. */
function widenDateBound(input: string, edge: 'start' | 'end'): string | null {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(input.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  if (d) return `${y}-${mo}-${d}`;
  if (mo) return `${y}-${mo}-${edge === 'start' ? '01' : '31'}`;
  return `${y}-${edge === 'start' ? '01-01' : '12-31'}`;
}

function yearsInRange(startBound: string, endBound: string): string[] {
  const startY = Number(startBound.slice(0, 4));
  const endY = Number(endBound.slice(0, 4));
  const years: string[] = [];
  for (let y = startY; y <= endY; y++) years.push(String(y));
  return years;
}

/** Resolve ONE registration-index entry (which already pins an exact
 *  make + year, or null year for "event date unknown" — refresh.mjs's
 *  'unknown' bucket) to exactly one shard key. Unlike shardsForMake, this
 *  never fans out: an index entry is never ambiguous about which shard it
 *  lives in, because it was written FROM that shard's own contents. */
function shardForIndexEntry(manifest: Manifest, make: string, entryYear: number | null): string | null {
  const ref = manifest.makes[make];
  if (!ref) return null;
  if (ref.type !== 'by_year') return shardKey(ref);
  const y = entryYear == null ? 'unknown' : String(entryYear);
  return ref.years.includes(y) ? yearShardKey(ref, y) : null;
}

/** Exact match on the manifest's make keys first (the common case — a real
 *  make string, normalised); falls back to a ONE-DIRECTIONAL substring scan
 *  of the manifest's own key list (a few thousand short strings, already in
 *  memory — not a data scan) for a near-miss like "Eurocopter" matching the
 *  real "EUROCOPTER FRANCE". Capped at MAX_MAKE_CANDIDATES distinct real
 *  makes so a too-broad fragment is refused rather than silently expanded.
 *
 *  Deliberately one-directional: only `known.includes(norm)` (the caller's
 *  input is a substring of a REAL manufacturer string), never
 *  `norm.includes(known)` (a real manufacturer string happens to be a
 *  substring of the caller's input). The second direction was tried and
 *  pulled live, after it produced two false positives against the real
 *  sharded data: `"anything".includes("")` is true in JS, so the blank
 *  `acft_make` ("") that some real source rows carry matched EVERY query —
 *  and separately, `make: "ZZZNONEXISTENTAIRCRAFT"` matched the real,
 *  unrelated 3-letter manufacturer "RAF" purely because "aircRAFt" contains
 *  it. Real manufacturer codes can be this short (RAF, BAE, ...), so no
 *  length floor fixes that direction — only dropping it does. The
 *  known.includes(norm) direction has no equivalent failure: a real
 *  manufacturer string can't coincidentally CONTAIN an arbitrary caller
 *  input the way an arbitrary caller input can coincidentally contain a
 *  short real one. */
function resolveMakeCandidates(manifest: Manifest, makeInput: string): string[] | 'too_broad' {
  const norm = normalize(makeInput);
  if (manifest.makes[norm]) return [norm];
  if (norm.length < 2) return [];
  const hits: string[] = [];
  for (const known of Object.keys(manifest.makes)) {
    if (known.length < 2) continue; // skip the blank-acft_make ("") entry
    if (known.includes(norm)) {
      hits.push(known);
      if (hits.length > MAX_MAKE_CANDIDATES) return 'too_broad';
    }
  }
  return hits;
}

/** For one resolved make, the shard key(s) to read given an optional year.
 *  Returns [] when the manifest can already tell us there is nothing to
 *  read (e.g. a year with no data for that make) — a real answer, not a
 *  failure. Returns 'needs_narrowing' when a bare make with no year would
 *  fan out past MAX_YEAR_SHARD_FANOUT objects. */
function shardsForMake(manifest: Manifest, make: string, year: number | undefined): string[] | 'needs_narrowing' {
  const ref = manifest.makes[make];
  if (!ref) return [];
  if (ref.type !== 'by_year') return [shardKey(ref)];
  if (year != null) {
    const y = String(year);
    return ref.years.includes(y) ? [yearShardKey(ref, y)] : [];
  }
  if (ref.years.length > MAX_YEAR_SHARD_FANOUT) return 'needs_narrowing';
  return ref.years.map((y) => yearShardKey(ref, y));
}

function toResult(c: NtsbCase) {
  return {
    ntsb_number: c.ntsb_number,
    event_date: c.event_date,
    location: { city: c.city, state: c.state, country: c.country },
    registration: c.registration,
    aircraft: { make: c.make, model: c.model, series: c.series },
    damage: c.damage,
    injury_level: c.injury_level,
    occurrence: c.occurrence,
    probable_cause: c.probable_cause,
    findings: c.findings,
    docket_url: c.ntsb_number ? DOCKET_URL(c.ntsb_number) : null,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ntsb_search_investigations',
    description:
      'NTSB aviation accident/incident investigations — plane crashes — by aircraft ' +
      'registration (tail) number or by make/model, optionally filtered by `state`, `year`, ' +
      'or `injury_level` (fatal, serious, minor, none). Returns NTSB number, event date, ' +
      'location, injury level, phase/occurrence, probable cause, findings, and the NTSB docket ' +
      'link for each match. Registration numbers (N-numbers) are reused over time by different ' +
      'aircraft; pass `year` to narrow a registration match to one incarnation when more than ' +
      'one comes back. A broad make with no `model` or `year` may be asked to narrow — this ' +
      'reads a small sharded dataset, never a full scan. For a date-range or cross-make query ' +
      'with no make/registration (e.g. "fatal accidents in Alaska in 2025"), use ' +
      '`ntsb_accidents_by_period` instead. Sourced from the NTSB\'s own eADMS aviation accident ' +
      'database (data.ntsb.gov/avdata).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        registration: { type: 'string', description: 'Aircraft registration / tail number, e.g. "N512SP" (dashes/spacing ignored).' },
        make: { type: 'string', description: 'Aircraft manufacturer, e.g. "Cessna", "Piper", "Boeing".' },
        model: { type: 'string', description: 'Aircraft model, e.g. "172" (matches "172", "172S", "172N", ...). Requires `make`.' },
        year: { type: 'integer', description: 'Limit to events in this calendar year. Required for a common make (e.g. Cessna, Piper) unless `model` is also given.' },
        state: { type: 'string', description: 'US state postal abbreviation of the event location, e.g. "CA".' },
        injury_level: {
          type: 'string',
          enum: ['fatal', 'serious', 'minor', 'none'],
          description: 'Highest injury level reported for the event: fatal, serious, minor, or none.',
        },
        limit: { type: 'integer', description: 'Max results to return (default 25, max 100).' },
      },
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        found: { type: 'boolean' },
        data_as_of: { type: 'string' },
        source: { type: 'string' },
        count: { type: 'integer' },
        query: { type: 'object' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ntsb_number: { type: ['string', 'null'] },
              event_date: { type: ['string', 'null'] },
              location: { type: 'object' },
              registration: { type: ['string', 'null'] },
              aircraft: { type: 'object' },
              damage: { type: ['string', 'null'] },
              injury_level: { type: ['string', 'null'] },
              occurrence: { type: ['string', 'null'] },
              probable_cause: { type: ['string', 'null'] },
              findings: { type: 'array' },
              docket_url: { type: ['string', 'null'] },
            },
          },
        },
      },
      required: ['found', 'data_as_of', 'source'],
    },
  },
  {
    name: 'ntsb_accidents_by_period',
    description:
      'NTSB aviation accidents and incidents — plane crashes — in a date range, across every ' +
      'aircraft make, grouped by US state with counts. Answers questions like "fatal aviation ' +
      'accidents in Alaska in 2025", "plane crashes by state in May 2024", or "how many fatal ' +
      'crashes in California last year" in one call. Filter by `injury_level` (fatal, serious, ' +
      'minor, none) and/or `state`; `from`/`to` accept "YYYY", "YYYY-MM", or "YYYY-MM-DD" and ' +
      'are both inclusive (`to` defaults to the end of `from`\'s own year/month). Returns ' +
      'per-state counts (`by_state`) for every match plus up to 200 individual records — NTSB ' +
      'number, event date, location, injury level, phase, probable cause, docket link. Sourced ' +
      'from the NTSB\'s own eADMS aviation accident database (data.ntsb.gov/avdata); a range ' +
      'spanning more than 8 calendar years is refused — narrow it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Start of the date range, inclusive. "YYYY", "YYYY-MM", or "YYYY-MM-DD", e.g. "2024-05" or "2025-01-01".' },
        to: { type: 'string', description: 'End of the date range, inclusive, same formats as `from`. Omit to default to the end of `from`\'s own year/month.' },
        state: { type: 'string', description: 'US state postal abbreviation of the event location, e.g. "AK".' },
        injury_level: {
          type: 'string',
          enum: ['fatal', 'serious', 'minor', 'none'],
          description: 'Highest injury level reported for the event: fatal, serious, minor, or none.',
        },
        limit: { type: 'integer', description: 'Max individual records to return (default 50, max 200). `by_state` counts cover every match regardless of this cap.' },
      },
      required: ['from'],
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        found: { type: 'boolean' },
        data_as_of: { type: 'string' },
        source: { type: 'string' },
        count: { type: 'integer' },
        truncated: { type: 'boolean' },
        query: { type: 'object' },
        by_state: {
          type: 'array',
          items: {
            type: 'object',
            properties: { state: { type: ['string', 'null'] }, count: { type: 'integer' } },
          },
        },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ntsb_number: { type: ['string', 'null'] },
              event_date: { type: ['string', 'null'] },
              location: { type: 'object' },
              registration: { type: ['string', 'null'] },
              aircraft: { type: 'object' },
              damage: { type: ['string', 'null'] },
              injury_level: { type: ['string', 'null'] },
              occurrence: { type: ['string', 'null'] },
              probable_cause: { type: ['string', 'null'] },
              findings: { type: 'array' },
              docket_url: { type: ['string', 'null'] },
            },
          },
        },
      },
      required: ['found', 'data_as_of', 'source'],
    },
  },
];

async function searchByRegistration(
  r2: R2Like,
  manifest: Manifest,
  regInput: string,
  year: number | undefined,
  filterRest: (c: NtsbCase) => boolean,
): Promise<NtsbCase[] | 'needs_narrowing'> {
  const regNorm = normalizeReg(regInput);
  const index = await loadRegIndex(r2);
  let entries = index[regNorm] ?? [];
  if (year != null) entries = entries.filter((e) => e.year === year);
  if (entries.length === 0) return [];

  const keysNeeded = new Set<string>();
  for (const e of entries) {
    const k = shardForIndexEntry(manifest, e.make, e.year);
    if (k) keysNeeded.add(k);
  }
  if (keysNeeded.size > MAX_REG_SHARDS) return 'needs_narrowing';

  const shardArrays = await Promise.all([...keysNeeded].map((k) => loadShard(r2, k)));
  const all = shardArrays.flat();
  return all.filter((c) => normalizeReg(c.registration) === regNorm && filterRest(c));
}

async function searchByMake(
  r2: R2Like,
  manifest: Manifest,
  makeInput: string,
  year: number | undefined,
  filterRest: (c: NtsbCase) => boolean,
): Promise<NtsbCase[] | 'needs_narrowing' | 'too_broad'> {
  const candidates = resolveMakeCandidates(manifest, makeInput);
  if (candidates === 'too_broad') return 'too_broad';
  if (candidates.length === 0) return [];

  const keysNeeded = new Set<string>();
  for (const make of candidates) {
    const keys = shardsForMake(manifest, make, year);
    if (keys === 'needs_narrowing') return 'needs_narrowing';
    for (const k of keys) keysNeeded.add(k);
  }

  const shardArrays = await Promise.all([...keysNeeded].map((k) => loadShard(r2, k)));
  const makeNormSet = new Set(candidates);
  return shardArrays.flat().filter((c) => makeNormSet.has(normalize(c.make)) && filterRest(c));
}

/**
 * Read every by-year shard needed to cover [startBound, endBound] and
 * return the flattened, filtered cases. A `years` entry split `by_month`
 * (defensive headroom only — see refresh.mjs's shardByYear) is read in full
 * rather than month-by-month: still bounded (at most 12 extra reads for
 * that one year), just not as tight as the common `flat` case.
 */
async function searchByPeriod(
  r2: R2Like,
  manifest: Manifest,
  startBound: string,
  endBound: string,
  filterRest: (c: NtsbCase) => boolean,
): Promise<NtsbCase[] | 'needs_narrowing'> {
  const years = yearsInRange(startBound, endBound);
  if (years.length > MAX_PERIOD_YEAR_FANOUT) return 'needs_narrowing';

  const yearManifest = manifest.years ?? {};
  const keysNeeded = new Set<string>();
  for (const y of years) {
    const ref = yearManifest[y];
    if (!ref) continue; // no data for this year — a real (empty) answer, not a failure
    if (ref.type === 'flat') {
      keysNeeded.add(byYearShardKey(y));
    } else {
      for (const m of ref.months) keysNeeded.add(byYearMonthShardKey(y, m));
    }
  }
  if (keysNeeded.size === 0) return [];

  const shardArrays = await Promise.all([...keysNeeded].map((k) => loadShard(r2, k)));
  return shardArrays
    .flat()
    .filter((c) => c.event_date != null && c.event_date >= startBound && c.event_date <= endBound && filterRest(c));
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ntsb_search_investigations': {
      const registration = typeof args.registration === 'string' ? args.registration : undefined;
      const make = typeof args.make === 'string' ? args.make : undefined;
      const model = typeof args.model === 'string' ? args.model : undefined;
      const year = typeof args.year === 'number' ? args.year : undefined;
      const state = typeof args.state === 'string' ? args.state : undefined;
      const injuryLevel = typeof args.injury_level === 'string' ? args.injury_level : undefined;
      const limit = Math.min(Math.max(1, typeof args.limit === 'number' ? args.limit : 25), 100);

      if (!registration && !make) {
        throw new Error('ntsb_search_investigations requires `registration` or `make`.');
      }

      const r2 = r2FromArgs(args);
      if (!r2) return DATASET_UNAVAILABLE;

      const manifest = await loadManifest(r2);
      const modelNorm = model ? normalize(model) : null;
      const stateNorm = state ? normalize(state) : null;
      const injuryNorm = injuryLevel ? normalize(injuryLevel) : null;
      const filterRest = (c: NtsbCase) => {
        if (modelNorm && !normalize(c.model).startsWith(modelNorm)) return false;
        if (stateNorm && normalize(c.state) !== stateNorm) return false;
        if (injuryNorm && normalize(c.injury_level) !== injuryNorm) return false;
        if (year && c.event_date && !c.event_date.startsWith(String(year))) return false;
        return true;
      };

      const query = { registration, make, model, year, state, injury_level: injuryLevel };

      const matches = registration
        ? await searchByRegistration(r2, manifest, registration, year, filterRest)
        : await searchByMake(r2, manifest, make as string, year, filterRest);

      if (matches === 'too_broad') {
        throw new Error(
          `ntsb_search_investigations: "${make}" matches more than ${MAX_MAKE_CANDIDATES} distinct ` +
            'manufacturers in the dataset — narrow it (a fuller manufacturer name, or add `model`).',
        );
      }
      if (matches === 'needs_narrowing') {
        throw new Error(
          'ntsb_search_investigations: this make has too many years of data to read in one call — ' +
            'pass `year` (or `model`, which narrows the answer even though it does not reduce which ' +
            'year-shards are read) rather than scanning every year.',
        );
      }

      if (matches.length === 0) {
        return { found: false, data_as_of: manifest.data_as_of, source: SOURCE_URL, query };
      }

      matches.sort((a, b) => (b.event_date ?? '').localeCompare(a.event_date ?? ''));
      const page = matches.slice(0, limit);
      return {
        found: true,
        data_as_of: manifest.data_as_of,
        source: SOURCE_URL,
        count: matches.length,
        query,
        results: page.map(toResult),
      };
    }
    case 'ntsb_accidents_by_period': {
      const from = typeof args.from === 'string' ? args.from : undefined;
      const to = typeof args.to === 'string' ? args.to : undefined;
      const state = typeof args.state === 'string' ? args.state : undefined;
      const injuryLevel = typeof args.injury_level === 'string' ? args.injury_level : undefined;
      const limit = Math.min(Math.max(1, typeof args.limit === 'number' ? args.limit : 50), MAX_PERIOD_RESULTS);

      if (!from) throw new Error('ntsb_accidents_by_period requires `from`.');

      const startBound = widenDateBound(from, 'start');
      if (!startBound) {
        throw new Error(`ntsb_accidents_by_period: \`from\` ("${from}") is not "YYYY", "YYYY-MM", or "YYYY-MM-DD".`);
      }
      const endBound = widenDateBound(to ?? from, 'end');
      if (!endBound) {
        throw new Error(`ntsb_accidents_by_period: \`to\` ("${to}") is not "YYYY", "YYYY-MM", or "YYYY-MM-DD".`);
      }
      if (endBound < startBound) {
        throw new Error('ntsb_accidents_by_period: `to` is before `from`.');
      }

      const r2 = r2FromArgs(args);
      if (!r2) return DATASET_UNAVAILABLE;

      const manifest = await loadManifest(r2);
      if (!manifest.years) {
        throw new Error(
          'ntsb_accidents_by_period: this dataset build has no by-year index yet — run ' +
            'scripts/refresh.mjs in mcps/ntsb-investigations.',
        );
      }
      const stateNorm = state ? normalize(state) : null;
      const injuryNorm = injuryLevel ? normalize(injuryLevel) : null;
      const filterRest = (c: NtsbCase) => {
        if (stateNorm && normalize(c.state) !== stateNorm) return false;
        if (injuryNorm && normalize(c.injury_level) !== injuryNorm) return false;
        return true;
      };

      const query = { from, to, state, injury_level: injuryLevel };

      const matches = await searchByPeriod(r2, manifest, startBound, endBound, filterRest);
      if (matches === 'needs_narrowing') {
        throw new Error(
          `ntsb_accidents_by_period: this range spans more than ${MAX_PERIOD_YEAR_FANOUT} calendar ` +
            'years — narrow `from`/`to` to a tighter range.',
        );
      }

      if (matches.length === 0) {
        return { found: false, data_as_of: manifest.data_as_of, source: SOURCE_URL, query, count: 0, by_state: [], results: [] };
      }

      const byStateCounts = new Map<string, number>();
      for (const c of matches) {
        const st = c.state ?? 'UNKNOWN';
        byStateCounts.set(st, (byStateCounts.get(st) ?? 0) + 1);
      }
      const by_state = [...byStateCounts.entries()]
        .map(([st, count]) => ({ state: st, count }))
        .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state));

      matches.sort((a, b) => (b.event_date ?? '').localeCompare(a.event_date ?? ''));
      const page = matches.slice(0, limit);
      return {
        found: true,
        data_as_of: manifest.data_as_of,
        source: SOURCE_URL,
        count: matches.length,
        truncated: matches.length > page.length,
        query,
        by_state,
        results: page.map(toResult),
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
