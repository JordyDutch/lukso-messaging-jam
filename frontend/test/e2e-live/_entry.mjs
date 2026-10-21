// _entry.mjs — esbuild bundle entry. Re-exports the REAL frontend lib surface
// the driver drives. esbuild transpiles the .ts imports; nothing is mocked.
export { REGISTRY_ADDRESS, REGISTRY_V3_DEPLOYED, CHAIN_ID } from '../../src/lib/config.ts';
export { threadIdFor, conversationKey } from '../../src/lib/crypto.ts';
export { buildSealedOffer, openSealedOffer } from '../../src/lib/offer.ts';
export { publishSession, fetchAndOpenSession, watchInbound } from '../../src/lib/signaling.ts';
export { MemoryBlobStore } from '../../src/lib/blobStore.ts';
export { announceConvPub, convPubOf, SESSION_KIND } from '../../src/lib/registry.ts';
