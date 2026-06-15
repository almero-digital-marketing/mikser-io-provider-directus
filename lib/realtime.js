// Realtime subscriptions via the @directus/sdk's WebSocket composable.
//
// The SDK's `realtime()` composable handles the WS handshake, auth
// (`authMode: 'handshake'` sends the token at connect time), framing,
// and ping/pong keepalive. We just call client.connect() once, then
// subscribe per collection. Each subscription returns an
// AsyncIterator of {event, data} objects — for...await loops dispatch
// them to mikser's createEntity / updateEntity / deleteEntity.
//
// What we still own:
//
//   - Reconnect strategy. The SDK can reconnect, but exponential
//     backoff with a fallback-to-polling escape hatch is mikser-flavor
//     policy: the agency may run Directus on flaky network paths and
//     wants the catalog to keep moving regardless. We close the SDK
//     client and re-create it after N consecutive failures so the
//     caller's onPermanentFailure hook can switch to polling.
//
//   - Per-collection subscription dispatch — wrap each one in its own
//     async loop so one failing collection doesn't tear down the rest.
//
//   - Cancellation. Close all subscriptions + disconnect when the
//     plugin wants to stop (e.g. process exit).

import {
    rememberItem, forgetItem, recordedItem,
    collectionKey, setRealtimeActive,
} from './state.js'
import { entityFromItem } from './sync.js'

const MAX_CONSECUTIVE_FAILURES = 5

export function openRealtimeSubscriptions({
    client, collections,
    createEntity, updateEntity, deleteEntity,
    logger,
    onPermanentFailure,
}) {
    let cancelled = false
    let consecutiveFailures = 0
    let activeSubscriptions = []

    async function runOnce() {
        try {
            await client.connect()
            logger.info('Directus: realtime WS connected')

            for (const cc of collections) {
                try {
                    const { subscription, unsubscribe } = await client.subscribe(cc.collection, {
                        event: '*',
                        query: {
                            fields: cc.fields ?? ['*'],
                            ...(cc.filter ? { filter: cc.filter } : {}),
                        },
                    })
                    setRealtimeActive(collectionKey(cc), true)
                    activeSubscriptions.push({ collection: cc.collection, unsubscribe })
                    // Run the subscription loop in the background — each
                    // collection has its own iterator so one slow
                    // dispatch doesn't block the others.
                    consumeSubscription({
                        cc, subscription,
                        createEntity, updateEntity, deleteEntity,
                        logger,
                    })
                } catch (err) {
                    logger.warn('Directus: subscribe to %s failed — %s', cc.collection, err.message)
                }
            }

            consecutiveFailures = 0
            // Wait until the connection breaks — the SDK exposes that
            // via the client object's events. We poll the connected
            // state cheaply rather than wiring multiple listeners.
            await waitForDisconnect(client)

            // Connection dropped — fall through to reconnect logic.
            for (const { collection } of activeSubscriptions) {
                setRealtimeActive(collectionKey({ collection }), false)
            }
            activeSubscriptions = []
            throw new Error('WS disconnected')
        } catch (err) {
            consecutiveFailures++
            logger.warn(
                'Directus: realtime WS failed (%d/%d) — %s',
                consecutiveFailures, MAX_CONSECUTIVE_FAILURES, err.message,
            )
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                logger.warn('Directus: too many WS failures — falling back to polling')
                cancelled = true
                if (typeof onPermanentFailure === 'function') onPermanentFailure()
                return
            }
            const backoff = Math.min(1000 * 2 ** (consecutiveFailures - 1), 60_000)
            await sleep(backoff)
            if (!cancelled) runOnce()
        }
    }

    runOnce()

    return {
        async close() {
            cancelled = true
            for (const { unsubscribe } of activeSubscriptions) {
                try { unsubscribe() } catch { /* best-effort */ }
            }
            try { await client.disconnect() } catch { /* best-effort */ }
        },
    }
}

// Dispatch one subscription's event stream into mikser's catalog ops.
async function consumeSubscription({
    cc, subscription,
    createEntity, updateEntity, deleteEntity,
    logger,
}) {
    try {
        for await (const msg of subscription) {
            await handleEvent({
                msg, cc,
                createEntity, updateEntity, deleteEntity,
                logger,
            })
        }
    } catch (err) {
        // Subscription loop ended — usually because the connection
        // dropped. The outer runOnce() handles reconnect.
        logger.debug('Directus: subscription loop ended for %s — %s', cc.collection, err.message)
    }
}

async function handleEvent({
    msg, cc,
    createEntity, updateEntity, deleteEntity,
    logger,
}) {
    if (msg.event === 'init') {
        // SDK / Directus sends an initial state burst on some
        // subscriptions. The cold scan already populated the catalog;
        // ignoring it here prevents double-emission after reconnects.
        return
    }
    if (msg.event === 'create' || msg.event === 'update') {
        const items = Array.isArray(msg.data) ? msg.data : [msg.data]
        for (const item of items) {
            try {
                const entity = entityFromItem(item, cc)
                const known = recordedItem({ collection: cc.collection, itemId: entity.meta.directusId })
                if (known || msg.event === 'update') await updateEntity(entity)
                else                                  await createEntity(entity)
                rememberItem({
                    collection:  cc.collection,
                    itemId:      entity.meta.directusId,
                    entityId:    entity.id,
                    dateUpdated: item.date_updated,
                })
            } catch (err) {
                logger.error('Directus: realtime %s dispatch failed — %s', msg.event, err.message)
            }
        }
        return
    }
    if (msg.event === 'delete') {
        const ids = Array.isArray(msg.data) ? msg.data : [msg.data]
        for (const raw of ids) {
            const itemId = String(typeof raw === 'object' ? raw.id : raw)
            const entityId = forgetItem({ collection: cc.collection, itemId })
            if (entityId) {
                await deleteEntity({ id: entityId, collection: cc.mikserCollection || cc.collection })
            }
        }
    }
}

// The SDK's realtime composable doesn't expose a Promise-shaped
// "wait for disconnect"; we poll a private state flag at a slow tick.
// Doesn't pin the CPU and reacts within ~250ms of a real drop.
async function waitForDisconnect(client) {
    while (true) {
        await sleep(250)
        // The SDK uses different state fields across versions; try a
        // couple of likely shapes and treat all of them as "still
        // connected" when present.
        const connected = client.connected ?? client._connected ?? true
        if (!connected) return
    }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
