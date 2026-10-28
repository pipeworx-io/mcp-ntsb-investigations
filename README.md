# @pipeworx/ntsb-investigations

NTSB aviation accident/incident investigations — plane crashes — searchable
by aircraft registration (tail number), make/model, or by date range/state/
injury level across every make. Returns NTSB number, event date, location,
injury level, phase/occurrence, probable cause, findings, and the NTSB docket
link for each match.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1877+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ntsb_search_investigations({ registration?, make?, model?, year?, state?, injury_level?, limit? })`
  — requires `registration` or `make`. `model` narrows within a make (matches
  "172", "172S", "172N", ... by prefix). `year` filters by event year, and is
  also how a registration match is narrowed when an N-number has been
  reassigned to a different aircraft over time (see below). `injury_level`
  (`fatal`, `serious`, `minor`, `none`) filters by the event's highest
  reported injury. Returns `{ found, data_as_of, source, count, query,
  results[] }`, or `{ found: false, data_as_of, source, query }` with no
  matches.
- `ntsb_accidents_by_period({ from, to?, state?, injury_level?, limit? })` —
  aviation accidents/incidents in a date range, ACROSS every aircraft make
  (no `make`/`registration` needed). Answers "fatal aviation accidents in
  Alaska in 2025", "plane crashes by state in May 2024", etc. in one call.
  `from`/`to` accept `"YYYY"`, `"YYYY-MM"`, or `"YYYY-MM-DD"` and are both
  inclusive; `to` defaults to the end of `from`'s own year/month when
  omitted. A range spanning more than 8 calendar years is refused — narrow
  it. Returns `{ found, data_as_of, source, count, truncated, query,
  by_state: [{ state, count }], results[] }` — `by_state` covers every
  match regardless of the `limit` on `results`.

## Auth

Keyless. No upstream account, no API key.

## Data sources

- <https://data.ntsb.gov/avdata> — the NTSB's own eADMS aviation accident
  database (`avall.zip`, a Microsoft Access `.mdb` bulk file, confirmed live
  2026-10-07 at ~96 MB zipped / ~561 MB unzipped). This is the full,
  current dataset — the SAME data CAROL's aviation search queries, published
  as the bulk file NTSB itself ships for exactly this use.
- <https://data.ntsb.gov/Docket/?NTSBNumber=NNN> — the NTSB docket page for
  a given `ntsb_number`, where the final report and supporting documents are
  published. Confirmed live (HTTP 200) for a real case pulled from this same
  dataset.

### Why not CAROL's own search, or the newer developer API

CAROL (`data.ntsb.gov/carol-main-public`), NTSB's modern search UI, was
probed first. Its JSON endpoints (`api/Query/Main`, `api/Query/FileExport`)
are undocumented, and every `QueryGroups`/`QueryRules` request shape
reverse-engineered from a public third-party CAROL proxy and from NTSB's own
CAROL-Guide.pdf returned HTTP 500 ("An unknown exception occured." / "An
error has occurred.") — the frontend ships no devtools-free schema and the
server gives no hint why the shape it wants differs from what a real browser
session sends (likely a server-side session/anti-forgery requirement CAROL's
own JS sets up before the first query).

NTSB also runs a newer REST API at `developer.ntsb.gov` (Aviation / Safety
Recommendations / Data Dictionary APIs, via an Azure API Management gateway).
That portal requires signing up for a developer account and a subscription
key before any call succeeds — an authentication wall, which per this repo's
standing rule is never a free pass to build around without a separate key
decision, unlike the plain public bulk file this pack actually reads.

### Refreshing the data

`node mcps/ntsb-investigations/scripts/refresh.mjs [--local-mdb <path>] [--dry-run] [--r2-mode auto|api|wrangler] [--shard-max-bytes <n>]`

Downloads `avall.zip`, unzips it, runs `mdb-export` (mdbtools — `brew install
mdbtools` / `apt install mdbtools`) on five tables (`aircraft`, `events`,
`narratives`, `Findings`, `Events_Sequence`, `eADMSPUB_DataDictionary`), joins
them into one flat case-per-aircraft list, then **shards** it into the shared
`pipeworx-datasets` R2 bucket (same bucket as `mcps/indiana-code`,
`mcps/illinois-code`, `mcps/crs-reports` — see `scripts/lib/statute-store.mjs`)
rather than writing one object:

- `ntsb/by-make/<slug>.json` — one array per manufacturer. A make whose flat
  shard would exceed ~4 MB (only CESSNA, at this pull) is split further into
  `ntsb/by-make/<slug>/<year>.json`.
- Manufacturers with under 5 rows (most of the ~4,174 distinct raw `acft_make`
  strings — OCR/data-entry variants, not real distinct makers) are pooled into
  16 `ntsb/by-make/_other/<bucket>.json` shards by a stable hash, rather than
  one tiny file each.
- `ntsb/by-registration.json` — normalised registration -> the `(make, year)`
  pairs it appears under, so a registration query knows which shard(s) to
  read without a full scan.
- `ntsb/by-year/<YYYY>.json` — one array per event year, ACROSS every make.
  The by-make shards above are keyed on make first, so a cross-make question
  ("fatal accidents in Alaska in 2025") would need every make's shard to
  answer from them; this orthogonal index answers it with one read per year
  in the requested range instead. Split further into
  `ntsb/by-year/<YYYY>/<MM>.json` only if a single year's shard ever exceeds
  the same ~4 MB threshold (not observed at this pull — years are well under
  2 MB each).
- `ntsb/manifest.json` — `data_as_of`, `source`, `record_count`, and for every
  make the exact shard shape (`flat` / `by_year` + its years / `bucket`), plus
  a parallel `years` map for the by-year shards, so the read path never has
  to probe R2 to find out which key lives where.

This replaced an earlier single-object design (`ntsb/aviation-cases.json`,
~27 MB) that re-fetched and parsed the whole dataset on every call with no
cache — two concurrent calls held two full parses in one isolate at once.
`src/index.ts` now reads the manifest plus exactly the shard(s) one query
needs (one, for a make/model query; the few a reused registration's distinct
`(make, year)` pairs resolve to, for a registration query) and never reads
the old monolith, which this script deletes from the bucket once the shards
are up. No module-scope cache, on purpose — see the header comment in
`src/index.ts`. No Supabase migration; storage is R2 only. `--local-mdb`
re-uses an already-downloaded `avall.mdb` instead of re-pulling 96 MB.
`data_as_of` in every response is the date the refresh last ran, not a
per-record field from the upstream.

### Registration (N-number) reuse

Tail numbers are reassigned by the FAA to different aircraft over time.
`ntsb_search_investigations({ registration })` does not silently collapse
this: every historical match for that tail number comes back, each with its
own `event_date`, `make`, and `model`. Pass `year` to narrow to one
incarnation when more than one comes back for the same registration.

### A broad make may ask you to narrow it

A handful of common manufacturers (CESSNA, at this pull) have enough rows
that their data is split into one shard per year. A query for one of those
makes with neither `model` nor `year` would have to read every one of that
make's year-shards to answer — not a full dataset scan, but not the one or
two small objects every other query costs either. Past a small fixed number
of year-shards, the tool refuses with a message asking for `year` (or
`model`, which does not change which shards get read but narrows the point
of asking) instead of silently doing the larger read. A make/model/year
combination, or an uncommon make on its own, is unaffected.

### Date-range / cross-make queries

`ntsb_search_investigations` is keyed on make/registration, so there is no
bounded way to answer "accidents in Alaska in 2025" or "fatal crashes in May
2024" from it without naming a make first. `ntsb_accidents_by_period` reads
the orthogonal `by-year` index instead: one shard read per calendar year the
`from`/`to` range touches (at most 8), then filters in memory by `state` and
`injury_level` and groups the result by state. A range spanning more than 8
calendar years is refused — narrow it to answer in a bounded number of
reads.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ntsb-investigations": {
      "url": "https://gateway.pipeworx.io/ntsb-investigations/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ntsb-investigations/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1877+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ntsb_search_investigations \
  -H 'Content-Type: application/json' \
  -d '{"make":"Cessna","model":"172","year":2024,"limit":10}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ntsb_search_investigations`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ntsb-investigations": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ntsb-investigations"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ntsb-investigations
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ntsb Investigations data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
