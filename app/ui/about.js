import { t, $, invoke, brand, fit } from './panel.js';
const info = await invoke('about:info');
$('version').textContent = t('about.version', info);
$('desc').textContent = t('app.description');
$('license').textContent = t('about.license');
$('disclaimer').textContent = t('about.disclaimer');
$('origin').textContent = t('about.origin');
brand();
fit();
