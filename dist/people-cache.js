"use strict";
/**
 * In-process cache for Webex person details.
 *
 * Webex webhook payloads + message bodies carry personId and personEmail
 * but not displayName — resolving the name requires a separate call to
 * GET /v1/people/{id}. For a busy bot that would be one extra round-trip
 * per inbound message, so this module caches resolved entries.
 *
 * - Simple TTL eviction (24h by default).
 * - LRU-style bound on total size — drops oldest entries at `maxEntries`.
 * - Never throws: any lookup failure falls back to undefined, and the
 *   caller can continue with email/id.
 *
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPeopleCache = createPeopleCache;
const node_fetch_1 = __importDefault(require("node-fetch"));
const DEFAULT_API_BASE_URL = "https://webexapis.com/v1";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_ENTRIES = 1000;
function createPeopleCache(opts = {}) {
    const apiBaseUrl = opts.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const doFetch = opts.fetchImpl ?? node_fetch_1.default;
    const warn = opts.onWarn ??
        ((msg) => {
            console.warn(`[webex:people-cache] ${msg}`);
        });
    // Map preserves insertion order → cheap LRU by reinserting on hit.
    const cache = new Map();
    // Coalesce concurrent lookups for the same id.
    const inflight = new Map();
    const evictIfFull = () => {
        while (cache.size > maxEntries) {
            const firstKey = cache.keys().next().value;
            if (firstKey === undefined)
                return;
            cache.delete(firstKey);
        }
    };
    const getFromCache = (personId) => {
        const hit = cache.get(personId);
        if (!hit)
            return undefined;
        if (Date.now() - hit.insertedAt > ttlMs) {
            cache.delete(personId);
            return undefined;
        }
        // Reinsert to bump LRU ordering.
        cache.delete(personId);
        cache.set(personId, hit);
        return hit.details;
    };
    const fetchFromApi = async (personId, token) => {
        try {
            const res = await doFetch(`${apiBaseUrl}/people/${personId}`, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
            });
            if (!res.ok) {
                warn(`lookup ${personId} failed: ${res.status} ${res.statusText}`);
                return undefined;
            }
            const body = (await res.json());
            if (!body || typeof body !== "object" || !body.id)
                return undefined;
            return {
                id: body.id,
                displayName: body.displayName,
                emails: body.emails,
            };
        }
        catch (err) {
            warn(`lookup ${personId} errored: ${err instanceof Error ? err.message : err}`);
            return undefined;
        }
    };
    return {
        async getDisplayName(personId, token) {
            if (!personId)
                return undefined;
            const hit = getFromCache(personId);
            if (hit)
                return hit.displayName;
            const existing = inflight.get(personId);
            if (existing)
                return (await existing)?.displayName;
            const promise = fetchFromApi(personId, token);
            inflight.set(personId, promise);
            try {
                const details = await promise;
                if (details) {
                    cache.set(personId, { details, insertedAt: Date.now() });
                    evictIfFull();
                }
                return details?.displayName;
            }
            finally {
                inflight.delete(personId);
            }
        },
        clear() {
            cache.clear();
            inflight.clear();
        },
    };
}
//# sourceMappingURL=people-cache.js.map