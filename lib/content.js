// `read(entity)` implementation — uses the SDK's readItems / readAssetRaw
// query builders instead of hand-rolled fetch.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { readItem, readAssetRaw } from '@directus/sdk'

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

    if (isFilesCollection(collection, collectionsByName)) {
        return await mirrorAsset({ client, itemId, entity, cacheFolder, logger })
    }

    try {
        const item = await client.request(readItem(collection, itemId))
        if (!item) {
            return { contentError: `directus: item ${collection}/${itemId} not found` }
        }
        const cc = collectionsByName.get(collection)
        if (cc?.contentField && typeof item[cc.contentField] === 'string') {
            return { content: item[cc.contentField] }
        }
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

    const ext = pickFileExtension(entity)
    const cachePath = path.join(cacheFolder, `${itemId}${ext}`)
    const dateUpdated = entity.meta?.date_updated
    const sidecar = `${cachePath}.modified`

    if (existsSync(cachePath) && dateUpdated && existsSync(sidecar)) {
        try {
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
        // SDK's readAssetRaw returns a ReadableStream the SDK already
        // consumed into a Response-like; we coerce to a Buffer.
        const stream = await client.request(readAssetRaw(itemId))
        // The SDK returns a Web ReadableStream; readAllChunks() merges it.
        bytes = await readAllChunks(stream)
    } catch (err) {
        return { contentError: `directus: asset fetch failed for ${itemId} — ${err.message}` }
    }

    await writeFile(cachePath, bytes)
    if (dateUpdated) {
        await writeFile(sidecar, dateUpdated)
    }
    logger.debug('Directus: cached asset %s (%d bytes) → %s', itemId, bytes.length, cachePath)
    return {
        contentSkipped: `directus: file mirrored at ${cachePath}. Read directly via that path or set entity.uri to it for filesystem dispatch.`,
        cachedAt: cachePath,
    }
}

async function readAllChunks(stream) {
    if (Buffer.isBuffer(stream)) return stream
    if (stream instanceof ArrayBuffer) return Buffer.from(stream)
    if (stream && typeof stream.getReader === 'function') {
        const reader = stream.getReader()
        const chunks = []
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            chunks.push(value)
        }
        return Buffer.concat(chunks.map(c => Buffer.from(c)))
    }
    // Node-style readable: collect via for await
    const chunks = []
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
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
