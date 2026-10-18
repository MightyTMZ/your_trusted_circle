import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { OperatorConsole } from './ui/operator/OperatorConsole';
import { applyTheme, loadTheme } from './ui/theme';
import './styles.css';

applyTheme(loadTheme());

/** #operator (or #operator?call=<id>, a call to pick up) opens the simulated operator console; anything else is the app. */
function Root() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return hash === '#operator' || hash.startsWith('#operator?') ? <OperatorConsole /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
