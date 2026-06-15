// Directus client — thin wrapper around the official @directus/sdk.
//
// The SDK is a composable client: createDirectus(url) gives you a base
// instance, then `.with(<composable>)` layers on capabilities. We use:
//
//   - staticToken(token)  → bearer-token auth (admin-generated tokens)
//   - rest()              → REST-shaped request() that takes typed
//                           query builders like readItems(), readMe(),
//                           readAssetRaw()
//   - realtime()          → subscribe() / connect() / disconnect() for
//                           the WebSocket subscriptions path
//
// v1 supports static tokens only. The SDK also offers `authentication`
// composable for email/password + refresh-token rotation; that lands
// in a v2 if anyone needs interactive per-user identity.
//
// On init we run a cheap `readMe` to verify the token works against the
// configured URL — surfaces auth / URL / network errors immediately
// instead of at the first sync attempt.

import {
    createDirectus, staticToken, rest, realtime, readMe,
} from '@directus/sdk'

export async function createDirectusClient({ url, token } = {}) {
    if (!url)   throw new Error('Directus: `url` is required (e.g. https://cms.example.com)')
    if (!token) throw new Error('Directus: `token` is required. Generate one in the Directus admin under User → Token.')

    const baseUrl = url.replace(/\/+$/, '')

    const client = createDirectus(baseUrl)
        .with(staticToken(token))
        .with(rest())
        .with(realtime({ authMode: 'handshake' }))

    let identity
    try {
        const me = await client.request(readMe({ fields: ['id', 'email'] }))
        identity = me.email ?? me.id ?? '<unknown>'
    } catch (err) {
        throw new Error(
            `Directus: token validation failed (${err.message}). ` +
            `Check that the URL is reachable, the token is valid, and the role has read access ` +
            `to /users/me (and to the configured collections).`
        )
    }

    return { client, baseUrl, identity }
}
