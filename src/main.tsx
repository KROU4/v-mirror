import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Tektur: квадратный технический гротеск с кириллицей и осью ширины — близок к шрифту меню игры
import '@fontsource-variable/tektur/standard.css';
import './styles.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
