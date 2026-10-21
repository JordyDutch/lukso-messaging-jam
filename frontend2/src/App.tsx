import { useApp } from './state/app';
import { Connect } from './screens/Connect';
import { Announce } from './screens/Announce';
import { Wall } from './screens/Wall';

export default function App() {
  const { state } = useApp();
  return (
    <main className="app">
      {state.screen === 'connect' && <Connect />}
      {state.screen === 'announce' && <Announce />}
      {state.screen === 'wall' && <Wall />}
      <footer className="foot hint">
        UP Wall · public posts + encrypted DMs · fully on-chain (LUKSO mainnet 42)
      </footer>
    </main>
  );
}
