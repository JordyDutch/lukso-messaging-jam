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
 * RegistryV2 address.
 *
 * `0xA5Be…2fcC` is the E2E-lab registry proven on mainnet (announce + invite).
 * It does NOT yet carry the SDP/ICE WebRTC fields this frontend needs — see
 * `frontend/contracts/RegistryV3.sol` and the README "needs on-chain deploy"
 * section. Once RegistryV3 is deployed, set VITE_REGISTRY_ADDRESS to its
 * address; until then the WebRTC signaling calls target this placeholder and
 * will revert against the lab contract (the app surfaces that honestly).
 */
export const REGISTRY_ADDRESS: string =
  (import.meta.env?.VITE_REGISTRY_ADDRESS as string | undefined) ??
  '0xA5Beb9FF6F1977F0FF62ac13b074548dF7012fcC';

/**
 * True once a RegistryV3 (with SDP/ICE fields) address has been wired in via
 * env. When false the UI shows a "signaling contract not yet deployed" banner
 * instead of pretending the on-chain call paths are live.
 */
export const REGISTRY_V3_DEPLOYED: boolean = Boolean(
  import.meta.env?.VITE_REGISTRY_ADDRESS,
);

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
export const EXPLORER = 'https://explorer.execution.mainnet.lukso.network';
