import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
// Tektur: квадратный технический гротеск с кириллицей и осью ширины — близок к шрифту меню игры
import '@fontsource-variable/tektur/standard.css';
import './styles.css';
import App from './App';
import { getLang, translate } from './i18n';

/** Ошибка отрисовки не оставляет пустой экран: понятное сообщение и перезагрузка. */
class Crash extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    console.error(e);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const lang = getLang();
    return (
      <div className="crash" role="alert">
        <h1>{translate(lang, 'crash.title')}</h1>
        <p>{translate(lang, 'crash.text')}</p>
        <button type="button" className="btn primary" onClick={() => location.reload()}>
          {translate(lang, 'crash.reload')}
        </button>
      </div>
    );
  }
}

/**
 * Защита от встраивания в чужую страницу (clickjacking): GitHub Pages не отдаёт заголовков,
 * а frame-ancestors в meta-CSP браузеры игнорируют. Во фрейме страница уходит наверх, а если
 * чужой сайт этого не даёт (sandbox), интерфейс не показывается вовсе.
 */
function framed(): boolean {
  if (!import.meta.env.PROD || window.top === window.self) return false;
  try {
    window.top!.location.href = window.self.location.href;
  } catch {
    /* переход наверх запрещён — просто не показываем интерфейс */
  }
  document.documentElement.style.display = 'none';
  return true;
}

if (!framed()) createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Crash>
      <App />
    </Crash>
  </StrictMode>,
);
