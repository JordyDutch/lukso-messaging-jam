import { useApp } from './state/app';
import { Connect } from './screens/Connect';
import { Announce } from './screens/Announce';
import { Lobby } from './screens/Lobby';
import { Call } from './screens/Call';

export default function App() {
  const { state } = useApp();
  return (
    <main className="app">
      {state.screen === 'connect' && <Connect />}
      {state.screen === 'announce' && <Announce />}
      {state.screen === 'lobby' && <Lobby />}
      {state.screen === 'call' && <Call />}
      <footer className="foot hint">
        UP-gated P2P · WebRTC transport · on-chain signaling (LUKSO mainnet 42)
      </footer>
    </main>
  );
}
