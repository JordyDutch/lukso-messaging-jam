/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REGISTRY_ADDRESS?: string;
  readonly VITE_IPFS_PUT_URL?: string;
  readonly VITE_IPFS_GATEWAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
