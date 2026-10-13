// Custom application menubar.

import { app } from '../app.js';
import { el } from '../util.js';
import { ACTIONS, runAction, filterMenu } from '../actions.js';

const A = (id) => ({ action: id });
const SEP = { sep: true };

function menuModel(filterItems) {
  return [
    { label: 'File', items: [A('newDoc'), A('open'), SEP, A('importPhotos'), A('importFolder'), SEP, A('save'), A('saveAs'), SEP, A('export'), A('quickExport'), SEP, A('close'), A('quit')] },
    { label: 'Edit', items: [A('undo'), A('redo'), SEP, A('cut'), A('copy'), A('copyMerged'), A('paste'), SEP, A('fill'), A('fillBg'), A('clear'), SEP, A('transform'), SEP, A('copySettings'), A('pasteSettings'), A('resetDevelop')] },
    {
      label: 'Image',
      items: [
        { label: 'Adjustments', submenu: [A('autoTone'), A('autoWB'), SEP, A('brightness'), A('levels'), A('huesat'), SEP, A('invert'), A('desaturate'), A('sepia')] },
        SEP, A('imageSize'), A('canvasSize'), SEP,
        { label: 'Rotate & Flip', submenu: [A('rotateCW'), A('rotateCCW'), A('rotate180'), SEP, A('flipH'), A('flipV')] },
        SEP, A('cropToSel'), A('trim'),
      ],
    },
    {
      label: 'Layer',
      items: [A('newLayer'), A('newText'), A('duplicate'), A('viaCut'), A('deleteLayer'), SEP,
        { label: 'Layer Mask', submenu: [A('addMask'), A('applyMask'), A('deleteMask'), A('invertMask')] },
        A('rasterize'), SEP, A('layerUp'), A('layerDown'), SEP, A('mergeDown'), A('mergeVisible'), A('flatten')],
    },
    { label: 'Select', items: [A('selectAll'), A('deselect'), A('reselect'), A('inverse'), SEP, A('selectLayer'), SEP, A('feather'), A('expand'), A('contract')] },
    { label: 'Filter', items: [A('lastFilter'), SEP, ...filterItems] },
    { label: 'View', items: [A('library'), A('develop'), A('edit'), SEP, A('zoomIn'), A('zoomOut'), A('fit'), A('actual'), SEP, A('before'), A('filmstrip'), A('panels'), A('fullscreen')] },
    { label: 'Help', items: [A('shortcuts'), SEP, A('about')] },
  ];
}

function buildItems(items, close) {
  const pop = el('div', { class: 'menu-pop' });
  for (const it of items) {
    if (it.sep) { pop.appendChild(el('div', { class: 'menu-sep' })); continue; }
    const def = it.action ? ACTIONS[it.action] : it;
    const label = def.label;
    const row = el('div', { class: 'menu-item' + (it.submenu ? ' has-sub' : '') }, el('span', {}, label));
    if (def.keys) row.appendChild(el('span', { class: 'kbd' }, def.keys));
    if (it.submenu) {
      row.appendChild(buildItems(it.submenu, close));
    } else {
      row._enabled = def.enabled;
      row._checked = def.checked;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
        if (it.action) runAction(it.action);
        else if (def.run && (!def.enabled || def.enabled())) def.run();
      });
    }
    pop.appendChild(row);
  }
  return pop;
}

function refreshStates(pop) {
  for (const row of pop.querySelectorAll('.menu-item')) {
    if (row._enabled) row.classList.toggle('disabled', !row._enabled());
    const old = row.querySelector(':scope > .check');
    if (old) old.remove();
    if (row._checked && row._checked()) row.insertBefore(el('span', { class: 'check' }, '✓'), row.firstChild);
  }
}

export async function buildMenubar(container) {
  const filterItems = await filterMenu();
  const model = menuModel(filterItems);
  let openRoot = null;
  const close = () => {
    if (openRoot) openRoot.classList.remove('open');
    openRoot = null;
  };
  for (const m of model) {
    const btn = el('button', {}, m.label);
    const root = el('div', { class: 'menu-root' }, btn);
    const pop = buildItems(m.items, close);
    root.appendChild(pop);
    const open = () => {
      if (openRoot && openRoot !== root) openRoot.classList.remove('open');
      refreshStates(pop);
      root.classList.add('open');
      openRoot = root;
    };
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (openRoot === root) close(); else open();
    });
    btn.addEventListener('mouseenter', () => { if (openRoot && openRoot !== root) open(); });
    container.appendChild(root);
  }
  document.addEventListener('mousedown', (e) => {
    if (openRoot && !openRoot.contains(e.target)) close();
  });
  window.addEventListener('blur', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openRoot) { close(); e.stopPropagation(); } }, true);
  app.closeMenus = close;
}
