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
import fetch from "node-fetch";
export interface PersonDetails {
    id: string;
    displayName?: string;
    emails?: string[];
}
export interface PeopleCacheOptions {
    apiBaseUrl?: string;
    ttlMs?: number;
    maxEntries?: number;
    /** Injected for tests */
    fetchImpl?: typeof fetch;
    /** Logger for lookup failures; defaults to console.warn. */
    onWarn?: (message: string) => void;
}
export interface PeopleCache {
    getDisplayName(personId: string, token: string): Promise<string | undefined>;
    /** Email addresses for a person — used for allowlist checks on card actions. */
    getEmails(personId: string, token: string): Promise<string[] | undefined>;
    /** Clear all cached entries. Exposed for tests / `/reload`. */
    clear(): void;
}
export declare function createPeopleCache(opts?: PeopleCacheOptions): PeopleCache;
