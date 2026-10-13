// Keyboard handling: action shortcuts, tool keys and module-specific keys.

import { app } from './app.js';
import { ACTIONS, runAction } from './actions.js';
import { isTyping } from './viewport.js';
import { isModalOpen } from './ui/dialogs.js';
import { libraryKey } from './ui/library.js';
import { commit } from './ops.js';

function comboOf(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  if (k.length === 1) k = k.toUpperCase();
  // with shift, symbols change; normalise common ones
  const codeMap = { BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Backslash: '\\', Slash: '/' };
  if (codeMap[e.code] && (e.ctrlKey || e.altKey)) k = codeMap[e.code];
  if (k === '+' ) k = '+';
  parts.push(k);
  return parts.join('+');
}

const keyMap = new Map();
function buildMap() {
  for (const [id, a] of Object.entries(ACTIONS)) {
    for (const k of [a.keys, ...(a.alt || [])]) if (k) keyMap.set(k, id);
  }
}

// keys that only apply in the Edit module (they would clash with Library keys)
const EDIT_ONLY = new Set(['Delete', 'X', 'D', 'Alt+Backspace', 'Ctrl+Backspace']);

const TOOL_KEYS = {
  edit: { V: 'move', M: ['marquee', 'ellipse'], L: 'lasso', W: 'wand', C: 'crop', B: 'brush', E: 'eraser', S: 'clone', J: 'heal', G: ['gradient', 'bucket'], T: 'text', I: 'eyedropper', H: 'hand', Z: 'zoom' },
  develop: { R: 'crop', C: 'crop', Q: 'heal', J: 'heal', W: 'wb', H: 'hand', Z: 'zoom' },
};

export function installShortcuts() {
  buildMap();
  window.addEventListener('keydown', (e) => {
    if (isModalOpen()) return;
    if (isTyping(e)) return;
    const combo = comboOf(e);

    // tool-specific keys first (Enter/Escape for crop, transform, ...)
    const tool = app.tool;
    if (app.module !== 'library' && tool && tool.onKey && (e.key === 'Enter' || e.key === 'Escape')) {
      if (tool.onKey(e)) { e.preventDefault(); return; }
    }

    if (combo === 'Tab') {
      e.preventDefault();
      runAction('panels');
      return;
    }

    if (app.module === 'library') {
      if (libraryKey(e)) { e.preventDefault(); return; }
    }

    const id = keyMap.get(combo);
    if (id && !(EDIT_ONLY.has(combo) && app.module !== 'edit')) {
      // Ctrl+A in library is handled above; undo etc work everywhere
      e.preventDefault();
      runAction(id);
      return;
    }

    if (app.module === 'library' || !app.doc) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // brush size / hardness
    if (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') {
      const b = app.brush;
      if (e.shiftKey || e.key === '{' || e.key === '}') {
        b.hardness = Math.max(0, Math.min(1, b.hardness + (e.key === ']' || e.key === '}' ? 0.1 : -0.1)));
      } else {
        const step = b.size < 10 ? 1 : b.size < 50 ? 5 : b.size < 200 ? 10 : 25;
        b.size = Math.max(1, Math.min(1000, b.size + (e.key === ']' ? step : -step)));
      }
      app.emit('brush');
      app.view.requestFrame();
      e.preventDefault();
      return;
    }

    // arrow keys nudge the active layer with the move tool
    if (app.module === 'edit' && app.toolId === 'move' && e.key.startsWith('Arrow')) {
      const l = app.doc.active;
      if (!l) return;
      const d = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') l.x -= d;
      if (e.key === 'ArrowRight') l.x += d;
      if (e.key === 'ArrowUp') l.y -= d;
      if (e.key === 'ArrowDown') l.y += d;
      clearTimeout(installShortcuts.nudgeTimer);
      installShortcuts.nudgeTimer = setTimeout(() => commit('Nudge'), 400);
      app.render();
      e.preventDefault();
      return;
    }

    // number keys set brush opacity in edit mode (1 = 10% ... 0 = 100%)
    if (app.module === 'edit' && /^[0-9]$/.test(e.key) && ['brush', 'eraser', 'clone'].includes(app.toolId)) {
      app.brush.opacity = e.key === '0' ? 1 : +e.key / 10;
      app.emit('brush');
      app.status(`Opacity ${Math.round(app.brush.opacity * 100)}%`);
      return;
    }

    const map = TOOL_KEYS[app.module];
    const k = e.key.toUpperCase();
    if (map && map[k] && !e.shiftKey) {
      let t = map[k];
      if (Array.isArray(t)) {
        const i = t.indexOf(app.toolId);
        t = i >= 0 ? t[(i + 1) % t.length] : t[0];
      }
      if (t === 'wb') app.tools.wb.returnTo = app.toolId !== 'wb' ? app.toolId : 'hand';
      app.setTool(t);
      e.preventDefault();
    }
  });
}
