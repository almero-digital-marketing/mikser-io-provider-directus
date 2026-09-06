// The keys this provider stores its sync state under.
//
// They are the whole of its incremental behaviour: a collection's last-sync
// timestamp and every item's identity are looked up by these strings, so a
// change to either silently orphans everything recorded under the old shape —
// the provider re-imports the world, or worse, stops noticing deletions.
//
// This file exists because the package's test script matched zero files and
// exited 0, which reads exactly like a passing suite. A green tick for no
// tests is worse than no tick.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { collectionKey, itemKey } from '../lib/state.js'

describe('collectionKey', () => {
    it('pairs the directus collection with the mikser one it feeds', () => {
        assert.equal(collectionKey({ collection: 'articles', mikserCollection: 'documents' }),
            'articles@documents')
    })

    it('falls back to the directus name when no mikser collection is given', () => {
        // Not `articles@undefined`, which would key state under a string that
        // changes meaning the moment a mikserCollection is configured.
        assert.equal(collectionKey({ collection: 'articles' }), 'articles@articles')
        assert.equal(collectionKey({ collection: 'articles', mikserCollection: '' }), 'articles@articles')
    })

    it('keeps two directus collections feeding one mikser collection apart', () => {
        // The case the pairing exists for: both write into `documents`, and a
        // shared key would make each one's sync clock overwrite the other's.
        assert.notEqual(
            collectionKey({ collection: 'articles', mikserCollection: 'documents' }),
            collectionKey({ collection: 'pages', mikserCollection: 'documents' }))
    })
})

describe('itemKey', () => {
    it('scopes an item id to its collection', () => {
        assert.equal(itemKey({ collection: 'articles', itemId: 42 }), 'articles:42')
    })

    it('keeps the same id in two collections apart', () => {
        // Directus ids are per-collection, so an unscoped key would make
        // articles/1 and pages/1 the same row.
        assert.notEqual(itemKey({ collection: 'articles', itemId: 1 }),
                        itemKey({ collection: 'pages', itemId: 1 }))
    })

    it('renders a uuid id the same way as a numeric one', () => {
        const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
        assert.equal(itemKey({ collection: 'articles', itemId: uuid }), `articles:${uuid}`)
    })
})
