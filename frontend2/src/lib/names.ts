// names.ts — @name -> UP address via the Envio mainnet indexer.
//
// Uses search_profiles_v2 per FRONTEND-PLAN.md. No ENS. Accepts either a raw
// 0x address (returned as-is after checksum) or an @name / bare name to search.

import { ethers } from 'ethers';
import { ENVIO_GRAPHQL } from './config';

export interface ProfileHit {
  address: string;
  name: string | null;
  avatar: string | null;
}

/**
 * The 4-char address suffix LUKSO shows after a profile name to disambiguate
 * duplicate names (e.g. `alice#0F41`). It is the first four hex characters of
 * the address AFTER `0x`, uppercased — the exact convention used by
 * universalprofile.cloud and the UP Browser Extension. Deterministic and
 * collision-cheap, so it doubles as a stable key for display AND indexing.
 */
export function upHash(address: string): string {
  return ethers.getAddress(address).slice(2, 6).toUpperCase();
}

/**
 * Human-readable UP identity: `name#HASH` when the profile has an LSP3 name,
 * else `0xabcd…1234#HASH` (short address + the same suffix) so there is always
 * a stable, indexable handle. Pure/synchronous given a resolved name — pass the
 * `nameOf()` result (or null) in.
 */
export function upLabel(address: string, name: string | null): string {
  const addr = ethers.getAddress(address);
  const hash = upHash(addr);
  if (name && name.trim()) return `${name.trim()}#${hash}`;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}#${hash}`;
}

/** Resolve the LSP3 name (cached) and return the full `name#HASH` label. */
export async function labelOf(address: string): Promise<string> {
  const name = await nameOf(address);
  return upLabel(address, name);
}

// NOTE: search_profiles_v2 takes `search_query` / `limit_count` (NOT `search` /
// `limit`) and `limit` is NOT a top-level field arg either — the old names made
// every query fail GRAPHQL_VALIDATION, so names never resolved and the UI fell
// back to hashes everywhere. Verified against live introspection 2026-10-22.
// NOTE: on `search_profiles_v2` the result type is `search_profiles_result`,
// which has NO top-level `profileImages` — that lives under the nested `profile`
// relation (`profile { profileImages }`). Querying it at the top level fails
// GRAPHQL_VALIDATION ("Did you mean profile?"), which threw in resolveName and
// made profile SEARCH return nothing (names still resolved because nameOf's
// BY_ID query never asked for images). Verified against live schema 2026-10-22.
const QUERY = `
  query Search($q: String!) {
    search_profiles_v2(args: { search_query: $q, limit_count: 8 }) {
      id
      name
      profile { profileImages(limit: 1) { url } }
    }
  }
`;

interface EnvioRow {
  id: string;
  name: string | null;
  profile?: { profileImages?: { url: string | null }[] } | null;
}

// BY_ID also pulls the first profile image (same nested `profile` relation as
// QUERY — a top-level `profileImages` fails GRAPHQL_VALIDATION). One round-trip
// resolves BOTH the @name and the avatar, so the feed can show real pictures
// everywhere (not just in search results) off a single per-address cache.
const BY_ID = `
  query ById($id: String!) {
    LSP3ProfileMetadata_by_pk: search_profiles_v2(args: { search_query: $id, limit_count: 1 }) {
      id
      name
      profile { profileImages(limit: 1) { url } }
    }
  }
`;

export interface ProfileInfo {
  name: string | null;
  avatar: string | null;
}

const profileCache = new Map<string, ProfileInfo>();
const inflight = new Map<string, Promise<ProfileInfo>>();

/**
 * Reverse-resolve a UP address to its LSP3 name + avatar URL, cached per session
 * and de-duplicated across concurrent callers (the feed renders many cards for
 * the same author). Returns `{name:null,avatar:null}` if the profile has no
 * metadata or the indexer can't be reached — the UI falls back to a short
 * address and a generated monogram in that case.
 */
export async function profileOf(address: string): Promise<ProfileInfo> {
  const empty: ProfileInfo = { name: null, avatar: null };
  if (!ethers.isAddress(address)) return empty;
  const key = ethers.getAddress(address);
  const cached = profileCache.get(key);
  if (cached !== undefined) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async (): Promise<ProfileInfo> => {
    try {
      const res = await fetch(ENVIO_GRAPHQL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: BY_ID, variables: { id: key } }),
      });
      if (!res.ok) throw new Error(`envio ${res.status}`);
      const json = (await res.json()) as {
        data?: { LSP3ProfileMetadata_by_pk?: EnvioRow[] };
      };
      const rows = json.data?.LSP3ProfileMetadata_by_pk ?? [];
      const hit = rows.find((r) => ethers.isAddress(r.id) && ethers.getAddress(r.id) === key);
      const info: ProfileInfo = {
        name: hit?.name ?? null,
        avatar: hit?.profile?.profileImages?.[0]?.url ?? null,
      };
      profileCache.set(key, info);
      return info;
    } catch {
      profileCache.set(key, empty);
      return empty;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

/**
 * Reverse-resolve a UP address to its @name (LSP3), cached per session.
 * Returns null if the profile has no name or the indexer can't be reached — the
 * UI falls back to a short address in that case.
 */
export async function nameOf(address: string): Promise<string | null> {
  return (await profileOf(address)).name;
}

export async function resolveName(input: string): Promise<ProfileHit[]> {
  const trimmed: string = input.trim();
  if (!trimmed) return [];

  // Direct address paste — no indexer round-trip needed.
  if (ethers.isAddress(trimmed)) {
    return [{ address: ethers.getAddress(trimmed), name: null, avatar: null }];
  }

  const q: string = (trimmed as string).replace(/^@/, '');
  const res = await fetch(ENVIO_GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { q } }),
  });
  if (!res.ok) throw new Error(`envio ${res.status}`);
  const json = (await res.json()) as {
    data?: { search_profiles_v2?: EnvioRow[] };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(json.errors[0].message);

  const rows = json.data?.search_profiles_v2 ?? [];
  return rows
    .filter((r) => ethers.isAddress(r.id))
    .map((r) => {
      const hit: ProfileHit = {
        address: ethers.getAddress(r.id),
        name: r.name,
        avatar: r.profile?.profileImages?.[0]?.url ?? null,
      };
      // Warm the per-address cache so the feed reuses the avatar we just fetched
      // instead of firing a second BY_ID round-trip for the same profile.
      profileCache.set(hit.address, { name: hit.name, avatar: hit.avatar });
      return hit;
    });
}
