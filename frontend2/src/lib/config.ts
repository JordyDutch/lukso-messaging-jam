// config.ts — all network / chain / endpoint constants in one place.
//
// Everything that may need to change for a prod deploy lives here and is
// documented. Nothing here is a secret.

/** LUKSO mainnet. */
export const CHAIN_ID = 42;

/**
 * RPC endpoints, tried in order (first that answers chainId 42 wins).
 * Per FRONTEND-PLAN.md: thirdweb primary, lukso.network fallback.
 */
export const RPCS = [
  'https://42.rpc.thirdweb.com',
  'https://rpc.mainnet.lukso.network',
] as const;

/**
 * RegistryV3 address — LIVE on LUKSO mainnet.
 *
 * Deployed 2026-10-21 at 0x01AC…088c (tx 0xf571567b…59cd5). Superset of the
 * E2E-lab RegistryV2 `0xA5Be…2fcC` (announce + invite) plus the WebRTC
 * SDP/ICE session-signaling fields this frontend needs (see
 * `frontend/contracts/RegistryV3.sol`). Override via VITE_REGISTRY_ADDRESS
 * for a different deploy (e.g. testnet).
 */
export const REGISTRY_ADDRESS: string =
  (import.meta.env?.VITE_REGISTRY_ADDRESS as string | undefined) ??
  '0x01AC2FE086C2D69923F199d47C85688aB2FA088c';

/**
 * True once a RegistryV3 (with SDP/ICE fields) is wired in. The default
 * address above IS a live RegistryV3, so this is true by default; it only
 * goes false if someone overrides VITE_REGISTRY_ADDRESS with a non-V3
 * contract AND sets VITE_REGISTRY_IS_V2=1 to say so.
 */
export const REGISTRY_V3_DEPLOYED: boolean =
  (import.meta.env?.VITE_REGISTRY_IS_V2 as string | undefined) !== '1';

/** Public STUN servers for ICE discovery. STUN carries no media, only reflexive-address discovery. */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * Envio mainnet indexer (GraphQL) for @name → UP address resolution.
 * Uses the `search_profiles_v2` field per FRONTEND-PLAN.md.
 */
export const ENVIO_GRAPHQL =
  'https://envio.lukso-mainnet.universal.tech/v1/graphql';

/** LUKSO explorer for linking out to a UP / tx. */
export const EXPLORER = 'https://explorer.lukso.network';

/**
 * Wall contract — LIVE on LUKSO mainnet (deployed 2026-10-21).
 * Stores public plaintext posts and encrypted DM ciphertext fully on-chain.
 * Override via VITE_WALL_ADDRESS for a different deploy.
 */
export const WALL_ADDRESS: string =
  (import.meta.env?.VITE_WALL_ADDRESS as string | undefined) ??
  '0xd3a767c7fE981524810aF7bdE05FA6537B96f58E';

/** Known lab peers you can DM out of the box. */
export const KNOWN_PEERS: { name: string; address: string }[] = [
  { name: 'alice', address: '0xA02B2b0cB13a87824B0e42C951de3B1a20ECbA5C' },
  { name: 'bob', address: '0xf380f128b69c5EC2dffafC7Dd3f80DFDed0f509C' },
];
