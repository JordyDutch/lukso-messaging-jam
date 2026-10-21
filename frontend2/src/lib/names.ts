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
