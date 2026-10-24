import { icon } from './util.js';

document.querySelectorAll('[data-ic]').forEach((s) => { s.innerHTML = icon(s.dataset.ic, 16); });
document.getElementById('btn-sidebar').innerHTML = icon('PanelLeft', 17);
document.getElementById('btn-close').innerHTML = `${icon('X', 15)}<span>Close</span>`;
const themeBtn = document.getElementById('btn-theme');
themeBtn.innerHTML = `<span class="when-light">${icon('Moon', 17)}</span><span class="when-dark">${icon('Sun', 17)}</span>`;
