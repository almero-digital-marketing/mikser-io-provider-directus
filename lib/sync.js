// Cold scan + incremental polling, via the @directus/sdk's
// readItems() query builder.
//
// Compared to a hand-rolled URLSearchParams build: the SDK handles
// JSON-encoding the filter object, applies the standard Directus
// query shape, and gives back parsed objects directly. We just describe
// the query.
//
// Both phases share entityFromItem() — the conversion from a Directus
// row to a mikser entity. contentField lifts a body field into
// entity.content; everything else stays on entity.meta.

import path from 'node:path'
import { readItems } from '@directus/sdk'
import {
    collectionKey,
    getLastSyncIso, setLastSyncIso,
    rememberItem, forgetItem, recordedItem,
    itemsNotSeenSince,
} from './state.js'

const PAGE_SIZE = 100

// Build the Directus query object for a collection config. Optionally
// AND in a date_updated filter for the incremental path.
function buildQuery(collectionConfig, since) {
    const baseFilter = collectionConfig.filter
    const filter = since
        ? (baseFilter ? { _and: [baseFilter, { date_updated: { _gte: since } }] }
                      : { date_updated: { _gte: since } })
        : baseFilter
    return {
        filter,
        fields: collectionConfig.fields ?? ['*'],
        sort: ['date_updated', 'id'],   // stable order for pagination
        limit: PAGE_SIZE,
    }
}

// Build a mikser entity from a Directus item. `contentField` (if set
// on the collection config) gets lifted out of meta into entity.content;
// everything else is meta. `id` resolution: numeric, uuid, slug, _id —
// stringify whichever shows up first.
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

// Cold scan: paginate everything in this collection, emit createEntity
// per item. The cursor lands at the latest date_updated seen, so the
// first incremental tick won't re-process anything.
export async function coldScan({ client, collectionConfig, createEntity, logger }) {
    const key = collectionKey(collectionConfig)
    const { collection } = collectionConfig
    let offset = 0
    let emitted = 0
    let latestSince = null
    while (true) {
        const query = { ...buildQuery(collectionConfig), offset }
        let items
        try {
            items = await client.request(readItems(collection, query))
        } catch (err) {
            logger.error('Directus: cold scan failed for %s — %s', collection, err.message)
            break
        }
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
    logger.info('Directus: cold-scanned %s — %d items emitted', collection, emitted)
    return emitted
}

// Incremental poll: items changed since the cursor + a deletion sweep.
export async function pollChanges({ client, collectionConfig, createEntity, updateEntity, deleteEntity, logger }) {
    const key = collectionKey(collectionConfig)
    const { collection } = collectionConfig
    const since = getLastSyncIso(key)
    if (!since) {
        logger.warn('Directus: no cursor for %s — running cold scan', collection)
        return await coldScan({ client, collectionConfig, createEntity, logger })
    }
    const cycleStartedAt = Date.now()

    let offset = 0
    let processed = 0
    let latestSince = since
    while (true) {
        const query = { ...buildQuery(collectionConfig, since), offset }
        let items
        try {
            items = await client.request(readItems(collection, query))
        } catch (err) {
            logger.error('Directus: poll failed for %s — %s', collection, err.message)
            return processed
        }
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
        logger.info('Directus: polled %s — %d items changed', collection, processed)
    }
    return processed
}
