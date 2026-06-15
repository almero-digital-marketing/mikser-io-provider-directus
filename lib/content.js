// `read(entity)` implementation for directus://.
//
// Two cases by collection family:
//
//   1. Regular collection items (articles, products, team_members, …):
//      content is populated at sync time. If the collection config sets
//      `contentField: 'body'`, that field's text becomes entity.content
//      during entityFromItem() — readEntityContent's fast-path returns
//      it without ever calling this provider. We still handle the case
//      where content is missing (e.g. an external mutation never went
//      through our sync) by re-fetching the item from the API.
//
//   2. Directus files (directus_files collection or any collection
//      flagged `isFiles: true`): the entity's "content" is binary — the
//      file's bytes available via `/assets/<id>`. We stream them to
//      the local cache and return `{ contentSkipped, cachedAt }` so
//      downstream plugins (assets, post-pdf, image processors) read
//      them as a regular local file.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'

// Parse <collection>/<id> out of `directus://collection/id`.
function parseDirectusUri(uri) {
    const m = /^directus:\/\/([^/]+)\/([^/]+)$/i.exec(uri ?? '')
    if (!m) return null
    return { collection: decodeURIComponent(m[1]), itemId: decodeURIComponent(m[2]) }
}

export async function readDirectusEntity(entity, { client, collectionsByName, cacheFolder, logger }) {
    if (!client) {
        return { contentError: 'directus: provider not initialized. Did you forget providerDirectus() in plugins[]?' }
    }
    const parsed = parseDirectusUri(entity.uri)
    if (!parsed) {
        return { contentError: `directus: cannot parse collection/id from "${entity.uri}"` }
    }
    const { collection, itemId } = parsed

    // Files: stream to cache and return contentSkipped.
    if (isFilesCollection(collection, collectionsByName)) {
        return await mirrorAsset({
            client, itemId, entity, cacheFolder, logger,
        })
    }

    // Regular items: refetch and rebuild (fast-path already handled by
    // engine when entity.content was set at sync time).
    try {
        const res = await client.request(`/items/${encodeURIComponent(collection)}/${encodeURIComponent(itemId)}`)
        const item = res?.data
        if (!item) {
            return { contentError: `directus: item ${collection}/${itemId} not found` }
        }
        const cc = collectionsByName.get(collection)
        if (cc?.contentField && typeof item[cc.contentField] === 'string') {
            return { content: item[cc.contentField] }
        }
        // No contentField configured — surface the item as JSON. Downstream
        // renderers / consumers can decide what to do with structured data.
        return { content: JSON.stringify(item, null, 2) }
    } catch (err) {
        return { contentError: `directus: fetch failed for ${collection}/${itemId} — ${err.message}` }
    }
}

function isFilesCollection(collection, collectionsByName) {
    if (collection === 'directus_files') return true
    const cc = collectionsByName.get(collection)
    return cc?.isFiles === true
}

async function mirrorAsset({ client, itemId, entity, cacheFolder, logger }) {
    if (!cacheFolder) {
        return { contentError: 'directus: cacheFolder not configured — set cacheFolder option or rely on runtime.options.runtimeFolder default' }
    }
    await mkdir(cacheFolder, { recursive: true })

    // Filename is the directus file uuid + extension from the entity's
    // meta (Directus stores extension in `filename_download`). Fall back
    // to `.bin` when unknown.
    const ext = pickFileExtension(entity)
    const cachePath = path.join(cacheFolder, `${itemId}${ext}`)
    const dateUpdated = entity.meta?.date_updated

    // Cache validity marker: a sidecar file with the date_updated
    // string. Same shape the github provider uses with blob sha.
    const sidecar = `${cachePath}.modified`
    if (existsSync(cachePath) && dateUpdated) {
        try {
            const { readFile } = await import('node:fs/promises')
            const cached = (await readFile(sidecar, 'utf8')).trim()
            if (cached === dateUpdated) {
                return {
                    contentSkipped: `directus: file mirrored at ${cachePath}. Read directly via that path or set entity.uri to it for filesystem dispatch.`,
                    cachedAt: cachePath,
                }
            }
        } catch { /* fall through and re-fetch */ }
    }

    let bytes
    try {
        const res = await client.rawStream(`/assets/${encodeURIComponent(itemId)}`)
        const ab = await res.arrayBuffer()
        bytes = Buffer.from(ab)
    } catch (err) {
        return { contentError: `directus: asset fetch failed for ${itemId} — ${err.message}` }
    }

    await writeFile(cachePath, bytes)
    if (dateUpdated) {
        await writeFile(sidecar, dateUpdated)
    }
    logger.debug('directus: cached asset %s (%d bytes) → %s', itemId, bytes.length, cachePath)
    return {
        contentSkipped: `directus: file mirrored at ${cachePath}. Read directly via that path or set entity.uri to it for filesystem dispatch.`,
        cachedAt: cachePath,
    }
}

function pickFileExtension(entity) {
    const download = entity.meta?.filename_download
    if (typeof download === 'string') {
        const dot = download.lastIndexOf('.')
        if (dot >= 0) return download.slice(dot).toLowerCase()
    }
    const mime = entity.meta?.type
    if (mime === 'application/pdf') return '.pdf'
    if (typeof mime === 'string') {
        if (mime.startsWith('image/')) return '.' + mime.split('/')[1]
        if (mime.startsWith('video/')) return '.' + mime.split('/')[1]
        if (mime.startsWith('audio/')) return '.' + mime.split('/')[1]
    }
    return '.bin'
}
