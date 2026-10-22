import { useApp } from './state/app';
import { Connect } from './screens/Connect';
import { Announce } from './screens/Announce';
import { Wall } from './screens/Wall';

export default function App() {
  const { state } = useApp();
  // The wall is a full-bleed messenger; other screens keep the narrow card column.
  const isWall = state.screen === 'wall';
  return (
    <main className={isWall ? 'app app-wall' : 'app'}>
      {state.screen === 'connect' && <Connect />}
      {state.screen === 'announce' && <Announce />}
      {state.screen === 'wall' && <Wall />}
      {!isWall && (
        <footer className="foot hint">
          UP Dawg · public posts + encrypted DMs · fully on-chain (LUKSO mainnet 42)
        </footer>
      )}
    </main>
  );
}
