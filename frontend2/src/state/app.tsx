// app.tsx — minimal app state: which screen, the connected UP session, and
// whether we've announced our conv key.
import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';
import type { UpSession } from '../lib/up';

export type Screen = 'connect' | 'announce' | 'wall';

export interface AppState {
  screen: Screen;
  up: UpSession | null;
  announced: boolean;
}

type Action =
  | { type: 'connected'; up: UpSession }
  | { type: 'needAnnounce' }
  | { type: 'announced' }
  | { type: 'goWall' }
  | { type: 'disconnect' };

const initial: AppState = { screen: 'connect', up: null, announced: false };

function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'connected':
      return { ...s, up: a.up, screen: 'announce' };
    case 'needAnnounce':
      return { ...s, screen: 'announce' };
    case 'announced':
      return { ...s, announced: true, screen: 'wall' };
    case 'goWall':
      return { ...s, screen: 'wall' };
    case 'disconnect':
      return initial;
    default:
      return s;
  }
}

const Ctx = createContext<{ state: AppState; dispatch: (a: Action) => void } | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}
