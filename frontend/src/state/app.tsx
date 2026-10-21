// app.tsx — minimal app-wide state (UP session + current screen + active call).
// Deliberately a single React context + useReducer; no external state lib.

import { createContext, useContext, useReducer, type ReactNode, type Dispatch } from 'react';
import { type UpSession } from '../lib/up';
import { type BlobStore, makeBlobStore } from '../lib/blobStore';

export type Screen = 'connect' | 'announce' | 'lobby' | 'call';

export interface CallPeer {
  address: string;
  name: string | null;
  convPub: string; // bytes32 hex
}

export interface AppState {
  up: UpSession | null;
  announced: boolean;
  screen: Screen;
  peer: CallPeer | null;
  blobStore: BlobStore;
  error: string | null;
}

type Action =
  | { type: 'connected'; up: UpSession }
  | { type: 'announced' }
  | { type: 'goto'; screen: Screen }
  | { type: 'startCall'; peer: CallPeer }
  | { type: 'endCall' }
  | { type: 'error'; message: string | null }
  | { type: 'disconnect' };

const initial: AppState = {
  up: null,
  announced: false,
  screen: 'connect',
  peer: null,
  blobStore: makeBlobStore(),
  error: null,
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'connected':
      return { ...state, up: action.up, screen: 'announce', error: null };
    case 'announced':
      return { ...state, announced: true, screen: 'lobby' };
    case 'goto':
      return { ...state, screen: action.screen };
    case 'startCall':
      return { ...state, peer: action.peer, screen: 'call' };
    case 'endCall':
      return { ...state, peer: null, screen: 'lobby' };
    case 'error':
      return { ...state, error: action.message };
    case 'disconnect':
      return { ...initial, blobStore: state.blobStore };
    default:
      return state;
  }
}

const Ctx = createContext<{ state: AppState; dispatch: Dispatch<Action> } | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  return <Ctx.Provider value={{ state, dispatch }}>{children}</Ctx.Provider>;
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}
