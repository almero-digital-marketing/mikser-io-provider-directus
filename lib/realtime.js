// Realtime subscriptions via Directus WebSocket.
//
// Outbound connection from mikser to `ws(s)://<host>/websocket`. The
// direction matters — Directus doesn't need to reach mikser; mikser
// reaches Directus. Works through any firewall / NAT / private
// network. This is the structural advantage over webhook-based
// providers (github, gdrive push, stripe, twilio) that need
// runtime.options.url to be publicly resolvable.
//
// Lifecycle:
//
//   1. Connect WS. Handshake.
//   2. Send `{type:'auth', access_token:'...'}`. Wait for ack.
//   3. For each configured collection: send `{type:'subscribe',
//      collection: '...', query: {...}}`. Subscriptions are
//      independent — one collection failing doesn't tear the others
//      down.
//   4. Dispatch incoming `{type:'subscription', event:'create' |
//      'update' | 'delete', data: {...}}` messages to mikser's
//      createEntity / updateEntity / deleteEntity.
//   5. Periodic ping (Directus closes idle connections at ~30s by
//      default). Server PONGs the same JSON shape.
//   6. On close/error: exponential backoff reconnect. After N
//      consecutive failures, surrender to polling — the caller
//      handles that by checking realtime_active state.
//
// State coupling: every dispatched event also calls
// rememberItem/forgetItem so a later transition to polling has a
// consistent per-item index.

import WebSocket from 'ws'
import {
    collectionKey,
    setRealtimeActive,
    rememberItem, forgetItem, recordedItem,
} from './state.js'
import { entityFromItem } from './sync.js'

const PING_INTERVAL_MS  = 20_000   // server kills after ~30s idle
const BACKOFF_INITIAL_MS = 1_000
const BACKOFF_MAX_MS     = 60_000
const MAX_CONSECUTIVE_FAILURES = 5  // fall back to polling after this

export function openRealtimeSubscriptions({
    client, collections,
    createEntity, updateEntity, deleteEntity,
    logger,
    onPermanentFailure,
}) {
    const wsUrl = client.urlFor('/websocket').replace(/^http/i, 'ws')
    let backoffMs = BACKOFF_INITIAL_MS
    let consecutiveFailures = 0
    let cancelled = false
    let ws = null
    let pingTimer = null

    function connect() {
        if (cancelled) return
        ws = new WebSocket(wsUrl)

        ws.on('open', () => {
            logger.info('directus: realtime WS open → %s', wsUrl)
            // Auth first; subscriptions land after the auth ack
            // (Directus subscriptions API doesn't enforce strict
            // ordering, but auth-then-subscribe is the canonical flow).
            ws.send(JSON.stringify({ type: 'auth', access_token: client.token }))
        })

        ws.on('message', async (raw) => {
            let msg
            try { msg = JSON.parse(raw.toString()) }
            catch { return }

            if (msg.type === 'auth' && msg.status === 'ok') {
                // Subscribe to each configured collection. Independent
                // try/catch so one failure (e.g. permission denied on
                // one collection) doesn't tear down the others.
                for (const cc of collections) {
                    try {
                        ws.send(JSON.stringify({
                            type:       'subscribe',
                            collection: cc.collection,
                            query:      buildSubscriptionQuery(cc),
                            uid:        cc.collection,
                        }))
                    } catch (err) {
                        logger.warn('directus: subscribe to %s failed — %s', cc.collection, err.message)
                    }
                }
                consecutiveFailures = 0
                backoffMs = BACKOFF_INITIAL_MS
                for (const cc of collections) setRealtimeActive(collectionKey(cc), true)
                return
            }

            if (msg.type === 'auth' && msg.status !== 'ok') {
                logger.error('directus: realtime auth failed — %s', msg.error?.message ?? '(no detail)')
                ws.close()
                return
            }

            if (msg.type === 'subscription' && msg.uid) {
                await handleSubscriptionEvent({
                    msg, collections,
                    createEntity, updateEntity, deleteEntity,
                    logger,
                })
                return
            }

            if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }))
                return
            }
        })

        ws.on('error', (err) => {
            logger.warn('directus: realtime WS error — %s', err.message)
        })

        ws.on('close', (code, reason) => {
            clearInterval(pingTimer)
            pingTimer = null
            for (const cc of collections) setRealtimeActive(collectionKey(cc), false)
            if (cancelled) return

            consecutiveFailures++
            logger.warn(
                'directus: realtime WS closed (code=%d, reason=%s, failure %d/%d)',
                code, String(reason || '').slice(0, 80),
                consecutiveFailures, MAX_CONSECUTIVE_FAILURES,
            )
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                logger.warn('directus: too many WS failures — falling back to polling')
                cancelled = true
                if (typeof onPermanentFailure === 'function') onPermanentFailure()
                return
            }

            const wait = Math.min(backoffMs, BACKOFF_MAX_MS)
            backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
            setTimeout(connect, wait)
        })

        // Heartbeat ping. Directus server closes connections idle for
        // ~30s; sending a no-op `ping` from the client side keeps it
        // alive. Server-initiated pings also arrive and we PONG above.
        pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }))
            }
        }, PING_INTERVAL_MS)
        pingTimer.unref?.()
    }

    connect()

    return {
        close() {
            cancelled = true
            clearInterval(pingTimer)
            try { ws?.close() } catch { /* best-effort */ }
        },
    }
}

function buildSubscriptionQuery(cc) {
    const q = { fields: cc.fields ?? ['*'] }
    if (cc.filter) q.filter = cc.filter
    return q
}

async function handleSubscriptionEvent({
    msg, collections,
    createEntity, updateEntity, deleteEntity,
    logger,
}) {
    const cc = collections.find(c => c.collection === msg.uid)
    if (!cc) return   // received an event for a collection we don't track (unlikely)

    if (msg.event === 'create' || msg.event === 'update') {
        const items = Array.isArray(msg.data) ? msg.data : [msg.data]
        for (const item of items) {
            try {
                const entity = entityFromItem(item, cc)
                const known = recordedItem({
                    collection: cc.collection,
                    itemId:     entity.meta.directusId,
                })
                if (known || msg.event === 'update') await updateEntity(entity)
                else                                  await createEntity(entity)
                rememberItem({
                    collection:  cc.collection,
                    itemId:      entity.meta.directusId,
                    entityId:    entity.id,
                    dateUpdated: item.date_updated,
                })
            } catch (err) {
                logger.error('directus: realtime %s dispatch failed — %s', msg.event, err.message)
            }
        }
        return
    }

    if (msg.event === 'delete') {
        const ids = Array.isArray(msg.data) ? msg.data : [msg.data]
        for (const idRaw of ids) {
            const itemId = String(typeof idRaw === 'object' ? idRaw.id : idRaw)
            const entityId = forgetItem({ collection: cc.collection, itemId })
            if (entityId) {
                await deleteEntity({ id: entityId, collection: cc.mikserCollection || cc.collection })
            }
        }
        return
    }

    if (msg.event === 'init') {
        // Directus sends an initial state burst for some subscription
        // shapes. We ignore it: the cold scan / first poll has already
        // populated the catalog. Acting on the init payload would
        // double-emit on every reconnect.
        return
    }
}
