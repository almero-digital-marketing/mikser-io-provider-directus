// Persistent state for the directus provider.
//
// Two tables:
//
//   - state: per (directus_collection @ mikser_collection) key. Tracks
//     the `date_updated` cursor for the polling path and a small
//     observability flag for whether the realtime WS subscription is
//     currently live. Driving the cursor off date_updated rather than a
//     wall-clock timestamp means clock skew between mikser and the
//     Directus host doesn't drop changes.
//
//   - items: per (collection, item_id) row. Used by the polling path to
//     detect items that vanished between cycles (cold scan recorded
//     them, current scan didn't return them → DELETE). The realtime
//     path drives delete events from explicit `delete` subscription
//     messages but still updates this table so a fallback-to-polling
//     transition can reconcile cleanly.
//
// Table prefix `mikser_provider_directus_` follows the cross-plugin
// naming rule: strip `mikser-io-` from the package, replace `-` with
// `_`, prepend `mikser_`.

import { registerSchema, useDatabase } from 'mikser-io'

registerSchema('provider_directus', `
    CREATE TABLE IF NOT EXISTS mikser_provider_directus_state (
        collection_key   TEXT PRIMARY KEY,
        last_sync_iso    TEXT,
        realtime_active  INTEGER DEFAULT 0,
        last_synced_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS mikser_provider_directus_items (
        item_key         TEXT PRIMARY KEY,
        collection       TEXT NOT NULL,
        item_id          TEXT NOT NULL,
        entity_id        TEXT NOT NULL,
        date_updated     TEXT,
        last_seen_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mikser_provider_directus_items_collection
        ON mikser_provider_directus_items(collection);
    CREATE INDEX IF NOT EXISTS idx_mikser_provider_directus_items_entity
        ON mikser_provider_directus_items(entity_id);
`)

export function collectionKey({ collection, mikserCollection }) {
    return `${collection}@${mikserCollection || collection}`
}
export function itemKey({ collection, itemId }) {
    return `${collection}:${itemId}`
}

export function getLastSyncIso(key) {
    const db = useDatabase()
    if (!db?.isOpen) return null
    return db.handle.prepare(
        `SELECT last_sync_iso FROM mikser_provider_directus_state WHERE collection_key = ?`
    ).get(key)?.last_sync_iso ?? null
}

export function setLastSyncIso(key, iso) {
    useDatabase().handle.prepare(`
        INSERT INTO mikser_provider_directus_state (collection_key, last_sync_iso, last_synced_at)
        VALUES (?, ?, ?)
        ON CONFLICT(collection_key) DO UPDATE SET
            last_sync_iso  = excluded.last_sync_iso,
            last_synced_at = excluded.last_synced_at
    `).run(key, iso, Date.now())
}

export function setRealtimeActive(key, active) {
    useDatabase().handle.prepare(`
        INSERT INTO mikser_provider_directus_state (collection_key, realtime_active, last_synced_at)
        VALUES (?, ?, ?)
        ON CONFLICT(collection_key) DO UPDATE SET
            realtime_active = excluded.realtime_active,
            last_synced_at  = excluded.last_synced_at
    `).run(key, active ? 1 : 0, Date.now())
}

export function rememberItem({ collection, itemId, entityId, dateUpdated }) {
    useDatabase().handle.prepare(`
        INSERT INTO mikser_provider_directus_items
            (item_key, collection, item_id, entity_id, date_updated, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_key) DO UPDATE SET
            entity_id    = excluded.entity_id,
            date_updated = excluded.date_updated,
            last_seen_at = excluded.last_seen_at
    `).run(itemKey({ collection, itemId }), collection, String(itemId), entityId, dateUpdated ?? null, Date.now())
}

export function forgetItem({ collection, itemId }) {
    const key = itemKey({ collection, itemId })
    const row = useDatabase().handle.prepare(
        `SELECT entity_id FROM mikser_provider_directus_items WHERE item_key = ?`
    ).get(key)
    if (row) {
        useDatabase().handle.prepare(
            `DELETE FROM mikser_provider_directus_items WHERE item_key = ?`
        ).run(key)
    }
    return row?.entity_id ?? null
}

export function recordedItem({ collection, itemId }) {
    return useDatabase().handle.prepare(
        `SELECT * FROM mikser_provider_directus_items WHERE item_key = ?`
    ).get(itemKey({ collection, itemId })) ?? null
}

// Used by the polling path's reconcile step: find all items in this
// collection NOT seen since the given timestamp (i.e. likely deleted
// or filtered out by the configured Directus query).
export function itemsNotSeenSince(collection, sinceMs) {
    return useDatabase().handle.prepare(
        `SELECT item_id, entity_id FROM mikser_provider_directus_items
         WHERE collection = ? AND last_seen_at < ?`
    ).all(collection, sinceMs)
}
