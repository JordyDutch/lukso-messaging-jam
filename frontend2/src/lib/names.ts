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

const QUERY = `
  query Search($q: String!) {
    search_profiles_v2(args: { search: $q }, limit: 8) {
      id
      name
      profileImages(limit: 1) { url }
    }
  }
`;

interface EnvioRow {
  id: string;
  name: string | null;
  profileImages?: { url: string | null }[];
}

const BY_ID = `
  query ById($id: String!) {
    LSP3ProfileMetadata_by_pk: search_profiles_v2(args: { search: $id }, limit: 1) {
      id
      name
    }
  }
`;

const nameCache = new Map<string, string | null>();

/**
 * Reverse-resolve a UP address to its @name (LSP3), cached per session.
 * Returns null if the profile has no name or the indexer can't be reached — the
 * UI falls back to a short address in that case.
 */
export async function nameOf(address: string): Promise<string | null> {
  if (!ethers.isAddress(address)) return null;
  const key = ethers.getAddress(address);
  const cached = nameCache.get(key);
  if (cached !== undefined) return cached;
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
    const name = hit?.name ?? null;
    nameCache.set(key, name);
    return name;
  } catch {
    nameCache.set(key, null);
    return null;
  }
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
    .map((r) => ({
      address: ethers.getAddress(r.id),
      name: r.name,
      avatar: r.profileImages?.[0]?.url ?? null,
    }));
}
