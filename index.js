// mikser-io-provider-directus — Directus as a content source for mikser-io.
//
// Two surfaces in one package, same shape as the gdrive / github
// providers in this family:
//
//   1. `providerDirectus(options)` — lifecycle plugin. Sits in
//      mikser.config.js plugins[] for auth + collection config + the
//      sync orchestration (cold scan → realtime preferred, polling
//      fallback).
//
//   2. `read(entity)` — engine-dispatched content fetch when an
//      entity's uri starts with `directus://`. Items typically have
//      content already populated by the sync (contentField mapping);
//      files mirror to runtime/directus-cache/ on demand.
//
// What's distinctive about Directus among providers:
//
//   - Realtime subscriptions over an OUTBOUND WebSocket from mikser to
//     Directus. No public URL needed for sub-second push — the WS goes
//     out, the events come back. Works through any firewall.
//   - The schema is known to the source. v1 doesn't sync it (mikser-io-
//     schemas would need a programmatic registerSchema API), but the
//     hook is reserved for v2.
//   - Filtering and field-projection happen server-side via the
//     standard Directus filter + fields query language — no local
//     glob layer needed beyond what Directus itself enforces.

import path from 'node:path'
import './lib/state.js'                              // side-effect: registerSchema
import { createDirectusClient } from './lib/auth.js'
import { coldScan, pollChanges }      from './lib/sync.js'
import { openRealtimeSubscriptions }  from './lib/realtime.js'
import { readDirectusEntity }         from './lib/content.js'
import { collectionKey, getLastSyncIso } from './lib/state.js'

let client
let cacheFolder
let logger
let collectionsByName

export function providerDirectus(options = {}) {
    return ({
        runtime,
        onLoaded,
        onImport,
        useLogger,
        createEntity, updateEntity, deleteEntity,
    }) => {
        const collections = Array.isArray(options.collections) ? options.collections : []
        if (collections.length === 0) {
            onLoaded(() => {
                useLogger().warn(
                    'directus: no collections configured. Set providerDirectus({ collections: [{ collection, mikserCollection }] }).'
                )
            })
            return
        }

        // Lookup map used by read() and the realtime / polling paths to
        // resolve a collection-name back to its config.
        collectionsByName = new Map(collections.map(c => [c.collection, c]))

        onLoaded(async () => {
            logger = useLogger()
            cacheFolder = options.cacheFolder
                ?? path.join(runtime.options.runtimeFolder ?? path.join(runtime.options.workingFolder, 'runtime'), 'directus-cache')

            const token = options.auth?.token ?? process.env.DIRECTUS_TOKEN
            const url   = options.url        ?? process.env.DIRECTUS_URL
            const result = await createDirectusClient({ url, token })
            client = result.client
            logger.info('Directus: authenticated as %s @ %s', result.identity, result.baseUrl)

            // Decide which sync mode to start in.
            const wantRealtime = options.realtime !== false   // default on

            // Polling timer — always created in watch mode. It runs only
            // when realtime is OFF, or when realtime has fallen back due
            // to repeated WS failures. Cancelled if a future v2 wants
            // realtime-only with no fallback.
            let pollingActive = !wantRealtime
            let pollTimer
            const startPolling = () => {
                if (pollTimer) return
                pollingActive = true
                logger.info('Directus: polling every %dms', options.pollIntervalMs ?? 30_000)
                pollTimer = setInterval(async () => {
                    if (!pollingActive) return
                    for (const cc of collections) {
                        try {
                            await pollChanges({
                                client, collectionConfig: cc,
                                createEntity, updateEntity, deleteEntity,
                                logger,
                            })
                        } catch (err) {
                            logger.error('directus: poll tick failed for %s — %s', cc.collection, err.message)
                        }
                    }
                }, options.pollIntervalMs ?? 30_000)
                pollTimer.unref?.()
            }

            if (wantRealtime) {
                openRealtimeSubscriptions({
                    client, collections,
                    createEntity, updateEntity, deleteEntity,
                    logger,
                    onPermanentFailure: () => {
                        if (runtime.options.watch) startPolling()
                    },
                })
            } else if (runtime.options.watch) {
                startPolling()
            }
        })

        onImport(async () => {
            for (const cc of collections) {
                const haveBaseline = !!getLastSyncIso(collectionKey(cc))
                if (haveBaseline) {
                    await pollChanges({
                        client, collectionConfig: cc,
                        createEntity, updateEntity, deleteEntity,
                        logger,
                    })
                } else {
                    await coldScan({
                        client, collectionConfig: cc,
                        createEntity,
                        logger,
                    })
                }
            }
        })
    }
}

// Top-level named export — what the engine's readEntityContent
// dispatches into when an entity.uri starts with `directus://`. See
// mikser-io's src/utils.js for the dispatch shape.
export async function read(entity) {
    return readDirectusEntity(entity, {
        client,
        collectionsByName,
        cacheFolder,
        logger: logger ?? { debug() {}, info() {}, warn() {}, error() {} },
    })
}
