// Left toolbar (Edit module) with tool buttons and color swatches.

import { app } from '../app.js';
import { el } from '../util.js';
import { icon } from './icons.js';

export const EDIT_TOOL_ORDER = [
  'move', 'marquee', 'ellipse', 'lasso', 'wand', '|',
  'crop', 'transform', '|',
  'brush', 'eraser', 'clone', 'heal', 'gradient', 'bucket', '|',
  'text', 'eyedropper', '|',
  'hand', 'zoom',
];

export function buildToolbar(container) {
  const bar = el('div', { class: 'toolbar' });
  const buttons = new Map();
  for (const id of EDIT_TOOL_ORDER) {
    if (id === '|') { bar.appendChild(el('div', { class: 'tool-sep' })); continue; }
    const t = app.tools[id];
    if (!t) continue;
    const key = id === 'transform' ? 'Ctrl+T' : t.key;
    const b = el('button', { class: 'tool-btn', title: `${t.name}${key ? ` (${key})` : ''}` }, icon(t.icon, 19));
    b.addEventListener('click', () => app.setTool(id));
    buttons.set(id, b);
    bar.appendChild(b);
  }

  // colors
  const fgInput = el('input', { type: 'color', value: app.fg });
  const bgInput = el('input', { type: 'color', value: app.bg });
  const fg = el('div', { class: 'sw fg', title: 'Foreground color (click to change)' });
  const bg = el('div', { class: 'sw bg', title: 'Background color (click to change)' });
  const swap = el('button', { class: 'swap', title: 'Swap colors (X)' }, icon('swap', 12));
  const reset = el('div', { class: 'reset', title: 'Default colors (D)' });
  const widget = el('div', { class: 'colors-widget' }, bg, fg, swap, reset, fgInput, bgInput);
  fg.addEventListener('click', () => fgInput.click());
  bg.addEventListener('click', () => bgInput.click());
  fgInput.addEventListener('input', () => { app.fg = fgInput.value; app.emit('colors'); });
  bgInput.addEventListener('input', () => { app.bg = bgInput.value; app.emit('colors'); });
  swap.addEventListener('click', () => swapColors());
  reset.addEventListener('click', () => resetColors());
  bar.appendChild(widget);

  const refreshColors = () => {
    fg.style.background = app.fg;
    bg.style.background = app.bg;
    fgInput.value = app.fg;
    bgInput.value = app.bg;
  };
  app.on('colors', refreshColors);
  refreshColors();
  app.on('tool', () => {
    for (const [id, b] of buttons) b.classList.toggle('active', id === app.toolId);
  });
  container.appendChild(bar);
  return bar;
}

export function swapColors() {
  [app.fg, app.bg] = [app.bg, app.fg];
  app.emit('colors');
}

export function resetColors() {
  app.fg = '#000000';
  app.bg = '#ffffff';
  app.emit('colors');
}
