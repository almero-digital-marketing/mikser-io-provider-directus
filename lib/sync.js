// Cold scan + incremental polling against Directus REST.
//
// Cold path (first run, or after --clear):
//   Paginate GET /items/<collection> using ?limit=N&offset=M until the
//   server returns fewer than N. Filter and field-projection from the
//   collection config get serialized into the query string. For each
//   item: build the entity, emit createEntity, persist the per-item
//   row. The current ISO timestamp becomes the date_updated cursor for
//   the first incremental tick.
//
// Incremental polling path (used when realtime is off, or after the
// WS subscription has failed enough times to fall back):
//   GET /items/<collection>?filter[date_updated][_gte]=<lastSync>.
//   Items returned get UPDATE (if known) or CREATE (if new). After the
//   page is processed, sweep `mikser_provider_directus_items` for rows
//   not seen this cycle — those are deletions or items filtered out
//   by the user's `filter`. Either case → DELETE on the catalog.
//   Persist the new cursor.

import path from 'node:path'
import {
    collectionKey,
    getLastSyncIso, setLastSyncIso,
    rememberItem, forgetItem, recordedItem,
    itemsNotSeenSince,
} from './state.js'

const PAGE_SIZE = 100

// Build a query string for /items endpoints from the collection config.
// Directus accepts JSON-encoded filter/fields/sort.
function buildItemsQuery({ filter, fields, since } = {}) {
    const qs = new URLSearchParams()
    qs.set('limit', String(PAGE_SIZE))
    if (fields) qs.set('fields', Array.isArray(fields) ? fields.join(',') : String(fields))
    const combinedFilter = since
        ? mergeFilter(filter, { date_updated: { _gte: since } })
        : filter
    if (combinedFilter) qs.set('filter', JSON.stringify(combinedFilter))
    qs.set('sort', 'date_updated,id')   // stable order for pagination
    return qs
}

function mergeFilter(a, b) {
    if (!a && !b) return undefined
    if (!a) return b
    if (!b) return a
    return { _and: [a, b] }
}

// Build a mikser entity from a Directus item. `contentField` (if set
// on the collection config) gets lifted out of meta into entity.content;
// everything else is meta. `id` resolution: numeric ids are common
// but uuids and slugs work too; we always stringify for the catalog id.
export function entityFromItem(item, collectionConfig) {
    const idValue = String(item.id ?? item.uuid ?? item.slug ?? item._id ?? '')
    if (!idValue) throw new Error(`directus item has no id field — collection "${collectionConfig.collection}"`)
    const mikserColl = collectionConfig.mikserCollection || collectionConfig.collection
    const prefix     = collectionConfig.prefix || `/${mikserColl}/directus/${collectionConfig.collection}/`
    const id         = path.posix.join(prefix, idValue)

    const meta = { ...item }
    let content
    if (collectionConfig.contentField && typeof meta[collectionConfig.contentField] === 'string') {
        content = meta[collectionConfig.contentField]
        delete meta[collectionConfig.contentField]
    }
    meta.directusCollection = collectionConfig.collection
    meta.directusId         = idValue

    return {
        id,
        uri: `directus://${collectionConfig.collection}/${idValue}`,
        collection: mikserColl,
        type: collectionToType(mikserColl),
        name: idValue,
        format: collectionConfig.format ?? 'json',
        meta,
        ...(content !== undefined ? { content } : {}),
        time: item.date_updated ? Date.parse(item.date_updated) : Date.now(),
    }
}

function collectionToType(c) {
    if (c === 'documents') return 'document'
    if (c === 'files')     return 'file'
    if (c === 'assets')    return 'asset'
    return c
}

// Cold scan one collection: paginate everything, emit createEntity per
// item. Sets the cursor to the latest date_updated seen (or now() if
// the collection lacks that field).
export async function coldScan({ client, collectionConfig, createEntity, logger }) {
    const key = collectionKey(collectionConfig)
    const { collection } = collectionConfig

    let offset = 0
    let emitted = 0
    let latestSince = null
    while (true) {
        const qs = buildItemsQuery({
            filter: collectionConfig.filter,
            fields: collectionConfig.fields ?? ['*'],
        })
        qs.set('offset', String(offset))
        let res
        try {
            res = await client.request(`/items/${encodeURIComponent(collection)}?${qs}`)
        } catch (err) {
            logger.error('directus: cold scan failed for %s — %s', collection, err.message)
            break
        }
        const items = res?.data ?? []
        for (const item of items) {
            const entity = entityFromItem(item, collectionConfig)
            await createEntity(entity)
            rememberItem({
                collection,
                itemId: entity.meta.directusId,
                entityId: entity.id,
                dateUpdated: item.date_updated,
            })
            if (item.date_updated && (!latestSince || item.date_updated > latestSince)) {
                latestSince = item.date_updated
            }
            emitted++
        }
        if (items.length < PAGE_SIZE) break
        offset += PAGE_SIZE
    }

    setLastSyncIso(key, latestSince ?? new Date().toISOString())
    logger.info('directus: cold-scanned %s — %d items emitted', collection, emitted)
    return emitted
}

// Incremental poll: pull items changed since the cursor, sweep deletions.
export async function pollChanges({ client, collectionConfig, createEntity, updateEntity, deleteEntity, logger }) {
    const key = collectionKey(collectionConfig)
    const { collection } = collectionConfig
    const since = getLastSyncIso(key)
    if (!since) {
        logger.warn('directus: no cursor for %s — running cold scan', collection)
        return await coldScan({ client, collectionConfig, createEntity, logger })
    }
    const cycleStartedAt = Date.now()

    let offset = 0
    let processed = 0
    let latestSince = since
    while (true) {
        const qs = buildItemsQuery({
            filter: collectionConfig.filter,
            fields: collectionConfig.fields ?? ['*'],
            since,
        })
        qs.set('offset', String(offset))
        let res
        try {
            res = await client.request(`/items/${encodeURIComponent(collection)}?${qs}`)
        } catch (err) {
            logger.error('directus: poll failed for %s — %s', collection, err.message)
            return processed
        }
        const items = res?.data ?? []
        for (const item of items) {
            const entity = entityFromItem(item, collectionConfig)
            const known = recordedItem({ collection, itemId: entity.meta.directusId })
            if (known) await updateEntity(entity)
            else       await createEntity(entity)
            rememberItem({
                collection,
                itemId: entity.meta.directusId,
                entityId: entity.id,
                dateUpdated: item.date_updated,
            })
            if (item.date_updated && item.date_updated > latestSince) {
                latestSince = item.date_updated
            }
            processed++
        }
        if (items.length < PAGE_SIZE) break
        offset += PAGE_SIZE
    }

    // Deletion sweep: any item NOT touched this cycle is gone (deleted in
    // Directus, or excluded by an updated filter rule).
    const stale = itemsNotSeenSince(collection, cycleStartedAt)
    for (const row of stale) {
        const entityId = forgetItem({ collection, itemId: row.item_id })
        if (entityId) {
            await deleteEntity({ id: entityId, collection: collectionConfig.mikserCollection || collection })
            processed++
        }
    }

    setLastSyncIso(key, latestSince)
    if (processed > 0) {
        logger.info('directus: polled %s — %d items changed', collection, processed)
    }
    return processed
}
