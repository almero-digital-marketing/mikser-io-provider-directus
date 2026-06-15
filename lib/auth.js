// Directus client — thin wrapper around fetch() with bearer-token auth.
//
// v1 supports static tokens only (the same token Directus generates in
// the admin UI under User → Token, or the API equivalent at
// `/users/me?fields=token`). Email/password flows with refresh
// management are deferred to v2 — static tokens cover headless / CI /
// production deployments and are the simpler primary case.
//
// The client exposes only what the sync/realtime/content paths need:
//   - request(path, init?)   — JSON-parsing fetch
//   - rawStream(path)        — for asset streaming (binaries)
//   - urlFor(path)           — for ws:// upgrade and shareable links
//
// Identity check on init catches bad tokens / wrong URLs at startup
// rather than at first sync attempt.

const DEFAULT_HEADERS = {
    'content-type': 'application/json',
    'accept':       'application/json',
}

export async function createDirectusClient({ url, token } = {}) {
    if (!url)   throw new Error('directus: `url` is required (e.g. https://cms.example.com)')
    if (!token) throw new Error('directus: `token` is required. Generate one in the Directus admin under User → Token.')

    const baseUrl = url.replace(/\/+$/, '')   // strip trailing slash

    const request = async (path, init = {}) => {
        const fullUrl = path.startsWith('http') ? path : `${baseUrl}${path}`
        const res = await fetch(fullUrl, {
            ...init,
            headers: {
                ...DEFAULT_HEADERS,
                ...(init.headers ?? {}),
                authorization: `Bearer ${token}`,
            },
        })
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            const err = new Error(`directus ${init.method ?? 'GET'} ${path} → HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`)
            err.status = res.status
            throw err
        }
        const ct = res.headers.get('content-type') ?? ''
        if (ct.includes('application/json')) return await res.json()
        return res
    }

    const rawStream = async (path) => {
        const fullUrl = path.startsWith('http') ? path : `${baseUrl}${path}`
        const res = await fetch(fullUrl, {
            headers: { authorization: `Bearer ${token}` },
        })
        if (!res.ok) {
            throw new Error(`directus raw ${path} → HTTP ${res.status} ${res.statusText}`)
        }
        return res
    }

    const urlFor = (path) => `${baseUrl}${path}`

    // Identity check.
    let identity
    try {
        const me = await request('/users/me?fields=id,email,first_name,last_name,role')
        identity = me.data.email ?? me.data.id ?? '<unknown>'
    } catch (err) {
        throw new Error(
            `directus: token validation failed (${err.message}). ` +
            `Check that the URL is reachable, the token is valid, and the user/role has read access ` +
            `to the configured collections.`
        )
    }

    return { request, rawStream, urlFor, baseUrl, token, identity }
}
