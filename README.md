# mikser-io-provider-directus

[Directus](https://directus.io) as a content source for [mikser-io](https://github.com/almero-digital-marketing/mikser-io). Configured collections (and the `directus_files` store) become mikser entities; the `read(entity)` named export wires into the engine's scheme-dispatched content fetch so refs, manifest, layouts, renderers, vector indexing, MCP queries — every downstream subsystem — works as if the data lived in a local folder.

Two surfaces, one package — same v9 provider convention as [`mikser-io-provider-gdrive`](https://github.com/almero-digital-marketing/mikser-io-provider-gdrive) and [`mikser-io-provider-github`](https://github.com/almero-digital-marketing/mikser-io-provider-github):

- **Lifecycle plugin** (`providerDirectus`) — sits in `plugins[]`, authenticates, runs the cold scan, opens realtime subscriptions or starts the polling loop.
- **`read(entity)` named export** — what mikser's engine dispatches into when an entity's `uri` is `directus://...`. You don't import it directly; the engine does the dynamic import by package-name convention.

```
Directus instance
   │
   ├── /items/articles → emit entities at /cms/articles/<id>
   ├── /items/team_members → emit entities at /cms/team/<id>
   ├── /assets/<uuid> → mirror binaries to runtime/directus-cache/
   │
   ▼
catalog (mikser-io entities) — refs, manifest, lifecycle, render all work normally
   │
   ▼
readEntityContent(entity) → dispatches into THIS package's `read(entity)`
                          → item content already populated at sync (contentField mapping)
                          → file binaries fetched + cached on first read
```

## Why Directus is structurally different

This is the **first provider** in the family where realtime is the default and works without any public-URL ceremony:

- **Outbound WebSocket** from mikser to Directus's `/websocket` endpoint. Mikser dials out; events come back over the same socket. No `runtime.options.url` needed. No webhook registration. Works through any firewall, NAT, corporate VPN, or air-gapped network.
- **Schema is known to the source.** Directus publishes collection schemas via `/collections/<name>` and `/fields/<name>`. v1 doesn't yet auto-sync these as zod schemas (requires a programmatic API on `mikser-io-schemas`), but the path is reserved.
- **Server-side filtering + field projection.** No glob layer to maintain; the standard Directus filter language handles `status=published`, date ranges, relation expansion.

## Install

```bash
npm install mikser-io-provider-directus
```

Peer dep on `mikser-io ^9`. Hard deps on `ws` (WebSocket client). No native modules; works on any Node 20+ runtime.

## Get a Directus API token (~1 minute)

In your Directus admin:

1. Click your avatar (top right) → **User Settings**.
2. Scroll to **Token** → click the regenerate / show button.
3. Copy the token (Directus shows it once).
4. Drop it in `.env`:

```bash
DIRECTUS_URL=https://cms.example.com
DIRECTUS_TOKEN=...
```

The token inherits whatever role the user has. For mikser sync, a role with **read** access to the configured collections (and `directus_files` if you sync assets) is enough. If you're paranoid: create a dedicated `mikser-sync` user, assign a minimal role, take that user's token.

## Configure

```js
// mikser.config.js
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts }          from 'mikser-io-layouts'
import { providerDirectus } from 'mikser-io-provider-directus'

export default {
    plugins: [
        documents(),
        frontMatter(),
        yaml(),
        layouts({ autoLayouts: true }),
        renderHbs(),

        providerDirectus({
            url:  process.env.DIRECTUS_URL,
            auth: { token: process.env.DIRECTUS_TOKEN },

            // Realtime preferred. Falls back to polling automatically if
            // the WS connection fails 5 times in a row. Set false to
            // disable WS entirely and use polling from the start.
            realtime: true,
            pollIntervalMs: 30_000,

            collections: [
                {
                    collection:       'articles',
                    mikserCollection: 'documents',
                    prefix:           '/cms/articles/',
                    // Directus filter — only published items reach mikser.
                    filter:           { status: { _eq: 'published' } },
                    // Field projection. Use the standard Directus shape;
                    // relations expand via {foo: ['fields']} syntax.
                    fields:           ['*', { author: ['name', 'email'] }],
                    // The `body` field becomes entity.content; everything
                    // else lands on entity.meta. Renderers + vector +
                    // schemas work against entity.content / meta as if
                    // the document were a local .md file.
                    contentField:     'body',
                },
                {
                    collection:       'team_members',
                    mikserCollection: 'documents',
                    prefix:           '/cms/team/',
                    fields:           ['*'],
                },
                {
                    collection:       'directus_files',
                    mikserCollection: 'files',
                    prefix:           '/cms/files/',
                    isFiles:          true,        // mirror binaries to cache via /assets/<id>
                },
            ],
        }),
    ],
}
```

Run mikser:

```bash
export DIRECTUS_URL=https://cms.example.com
export DIRECTUS_TOKEN=...
mikser --watch --server 3001
```

Expect:

```
Directus: authenticated as you@example.com @ https://cms.example.com
Directus: realtime WS open → wss://cms.example.com/websocket
directus: cold-scanned articles — 47 items emitted
directus: cold-scanned team_members — 6 items emitted
directus: cold-scanned directus_files — 3 items emitted
Server listening: http://localhost:3001
```

Edit an article in Directus admin → save → within ~100ms:

```
Directus: realtime update articles/42
```

The catalog updates, refs invalidate, affected pages re-render. No webhook, no polling lag.

## URI scheme

Every entity emitted by this plugin has:

```js
entity.uri = 'directus://<collection>/<id>'
entity.meta = {
    directusCollection: 'articles',
    directusId:         '42',
    // ...every field returned by Directus, minus the contentField if set
}
```

The engine dispatches `readEntityContent(entity)` by scheme — `directus` → dynamic import `mikser-io-provider-directus` → its `read(entity)`. Same shape as the gdrive / github providers.

## Realtime vs polling

| | Realtime (default) | Polling (fallback) |
|---|---|---|
| Latency from Directus edit → mikser update | sub-second | up to `pollIntervalMs` |
| Network requirement | outbound WS to Directus | outbound HTTPS to Directus |
| Public URL required | no | no |
| Quota cost | ~1 connection per mikser instance | 1 request per collection per tick |
| Drops on: | network blip, server restart, idle timeout (handled by auto-reconnect) | nothing — stateless |
| Reconnect strategy | exponential backoff 1s → 60s | n/a |
| Fallback trigger | 5 consecutive WS failures | n/a |

In production: realtime is the right default. When `pollIntervalMs: 60_000` is more frequent than your editorial cadence, the catalog feels like it's being edited directly. If for some reason your Directus instance doesn't speak WebSocket (very old version, reverse proxy strips upgrades), set `realtime: false` and the polling path takes over.

## Content mapping

| Collection family | What `read(entity)` returns |
|---|---|
| Regular item with `contentField:` set | `{ content: <string from that field> }` — set at sync; engine's fast-path returns it without re-fetching |
| Regular item without `contentField:` | `{ content: <JSON dump of the item> }` — useful when downstream renderers want the full record as structured data |
| `directus_files` / `isFiles: true` | `{ contentSkipped, cachedAt: <path> }` — binary streamed from `/assets/<uuid>` to `runtime/directus-cache/<uuid>.<ext>`, sha-style cache validation via `date_updated` sidecar |

Files reuse the cache when Directus's `date_updated` hasn't changed since last fetch. A re-publish triggers re-download on the next read.

## State persistence

```sql
mikser_provider_directus_state (
    collection_key      TEXT PRIMARY KEY,     -- "<directus_collection>@<mikser_collection>"
    last_sync_iso       TEXT,                 -- date_updated cursor for polling
    realtime_active     INTEGER DEFAULT 0,    -- 1 when WS subscription is live
    last_synced_at      INTEGER
);
mikser_provider_directus_items (
    item_key            TEXT PRIMARY KEY,     -- "<collection>:<id>"
    collection          TEXT NOT NULL,
    item_id             TEXT NOT NULL,
    entity_id           TEXT NOT NULL,
    date_updated        TEXT,
    last_seen_at        INTEGER
);
```

Lives in mikser's main sqlite database (`runtime/mikser.sqlite`) via `registerSchema`. `--clear` wipes it; next run does a fresh cold scan.

## What v1 does NOT do

- **Write-back (mikser → Directus mutations).** Read-only. Plugins that need to push back to Directus would compose against a separate mutation surface.
- **Schema auto-sync.** v2 — needs `mikser-io-schemas` to grow a programmatic `registerSchema(name, zodSchema)` API. The plan is to derive zod schemas from `/collections/<name>` + `/fields/<name>` at plugin init, register them with mikser-io-schemas, and let the SDK pick up the generated `.d.ts` for typed access in Vue/React/Svelte.
- **Email/password auth + refresh tokens.** Static token only. Covers headless / CI / production. Email/password with refresh-token persistence would land in v2 if someone needs interactive per-user identity.
- **Relation expansion beyond first level.** `fields: ['*', { author: ['name'] }]` works (Directus does the join server-side); deeper recursion is a Directus query feature, not something this plugin builds on top of.
- **Cross-collection refs in mikser's `$`-ref sense.** Items reference each other via Directus relations; mikser refs are a separate layer. You can wire them together by post-processing entities (an onProcess hook in your own plugin that rewrites `entity.meta.author` from a Directus uuid to a `$author: '/authors/...'` mikser ref).
- **Permission-aware fallback per collection.** If the token can't read one collection, that collection's subscription / poll silently produces zero items — there's no per-collection "you don't have access" surfaced as a clear warning yet.

## Composing with the rest of mikser

Directus entities live in the same catalog as local files, gdrive entities, github entities. Same render pipeline, same refs system, same vector indexing, same MCP queries. The catalog doesn't care where they came from — they all flow through the same lifecycle:

```js
// Local YAML
documents/welcome.md       → /documents/welcome.md
                              meta: {title, layout, author}
                              content: <markdown>

// gdrive
documents/proposal.gdoc    → /drive/team/proposal-abc123.md
                              meta: {driveId, driveMimeType, ...}
                              content: <markdown from export>

// directus
articles/42                → /cms/articles/42
                              meta: {directusCollection, status, ...}
                              content: <body field>
```

A post can `$author: /authors/jane` — the ref resolves whether `jane` is a local YAML file, a Directus team_members row, or a CSV row. `mikser-io-vector` indexes all of them together. `mikser-io-mcp`'s `mikser_query_entities` returns them in one stream. The substrate is content-source-agnostic.

## Troubleshooting

### `directus: token validation failed (HTTP 401)`

Token is invalid, expired, or the user account is deactivated. Regenerate from User Settings.

### `directus: token validation failed (HTTP 403)`

Token works but the user's role doesn't have read access to `/users/me`. Either grant the role permission to read its own user, or use the App Access (Public) role's token if you only need public read access.

### `directus: realtime WS error — Unexpected server response: 404`

Either the Directus version is too old for the WebSocket API (added in Directus 10.x), or a reverse proxy is stripping the WS upgrade. Test with `curl -i -H 'Upgrade: websocket' -H 'Connection: Upgrade' https://cms.example.com/websocket`. Set `realtime: false` to fall back to polling.

### `directus: realtime auth failed`

Token doesn't have access to the subscribed collections. Verify the role permissions in Directus admin.

### Items stop appearing after a Directus filter change

The cursor (`last_sync_iso`) keeps moving forward but items hidden by the new filter never come back into view. Run `mikser --clear` to reset state and re-scan from scratch.

### Cold scan emits 0 items

Check the `filter` config — `{ status: { _eq: 'published' } }` will emit nothing if every item is still in draft. Also verify the collection name is the **API key** (lowercase, snake_case), not the display name from the Directus UI.

## License

MIT
