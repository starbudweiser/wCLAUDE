// Outils communs des fenêtres (À propos, Réglages, mise à jour, Trousseau).
import { startBrandHighlight } from '../socle/brand_highlight.js';

export const { t, send, invoke, on, ready } = window.wclaude;
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Couleur du « w » de wCLAUDE, relevée sur le logo (5,4:1 sur le fond sombre). wCLAUDE est toujours en thème sombre.
export const BRAND = () => '#d97757';

let stopBrand = null;
export function brand() {
  if (stopBrand) stopBrand();
  stopBrand = startBrandHighlight({ names: ['wCLAUDE'], color: BRAND() });
}

/** Ajuste la hauteur de la fenêtre au contenu (deux passes, puis à chaque changement de taille du contenu). */
export function fit() {
  const measure = () => ready(document.documentElement.scrollHeight);
  requestAnimationFrame(() => requestAnimationFrame(measure));
}
new ResizeObserver(() => fit()).observe(document.documentElement);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') send('panel:close');
});

export function checkbox(el, checked, onChange) {
  el.setAttribute('role', 'checkbox');
  el.setAttribute('aria-label', el.querySelector('.sc-option__label')?.textContent || '');
  el.tabIndex = 0;
  const set = (v) => {
    el.classList.toggle('is-selected', v);
    el.setAttribute('aria-checked', String(v));
    el.querySelector('.sc-choice').innerHTML = v ? '✓' : '';
  };
  set(checked);
  const toggle = () => { const v = el.getAttribute('aria-checked') !== 'true'; set(v); onChange(v); };
  el.onclick = toggle;
  el.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } };
}
