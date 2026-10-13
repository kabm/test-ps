// Central registry of user commands used by menus and keyboard shortcuts.

import { app } from './app.js';
import * as ops from './ops.js';
import {
  openDialog, closeDoc, saveProject, quickExport,
} from './commands.js';
import {
  newDocDialog, imageSizeDialog, canvasSizeDialog, exportDialog, featherDialog, growDialog, filterDialog,
  repeatLastFilter, aboutDialog, shortcutsDialog, batchExportDialog,
} from './ui/dialogs.js';
import { importPhotos, importFolder, selectedEntries } from './ui/library.js';
import { toggleBefore, copySettings, pasteSettings } from './ui/developPanel.js';
import { swapColors, resetColors } from './ui/toolbar.js';
import { toggleFullscreen } from './platform.js';

const hasDoc = () => !!app.doc;
const hasSel = () => !!(app.doc && app.doc.selection);
const hasLayer = () => !!(app.doc && app.doc.active);

function fillDialog() {
  ops.fillWith(app.fg);
}

export const ACTIONS = {
  // File
  newDoc: { label: 'New…', keys: 'Ctrl+N', run: () => newDocDialog() },
  open: { label: 'Open…', keys: 'Ctrl+O', run: () => openDialog() },
  importPhotos: { label: 'Import Photos…', keys: 'Ctrl+Shift+O', run: () => importPhotos() },
  importFolder: { label: 'Import Folder…', run: () => importFolder() },
  save: { label: 'Save Project', keys: 'Ctrl+S', run: () => saveProject(app.doc), enabled: hasDoc },
  saveAs: { label: 'Save Project As…', keys: 'Ctrl+Shift+S', run: () => saveProject(app.doc, true), enabled: hasDoc },
  export: {
    label: 'Export…', keys: 'Ctrl+Shift+E',
    run: () => (app.module === 'library' ? batchExportDialog(selectedEntries()) : exportDialog()),
    enabled: () => hasDoc() || app.module === 'library',
  },
  quickExport: { label: 'Quick Export as JPEG…', keys: 'Ctrl+Alt+E', run: () => quickExport(), enabled: hasDoc },
  close: { label: 'Close', keys: 'Ctrl+W', run: () => closeDoc(), enabled: hasDoc },
  quit: { label: 'Exit', run: () => window.close() },

  // Edit
  undo: { label: 'Undo', keys: 'Ctrl+Z', run: () => app.doc && app.doc.undo(), enabled: () => !!(app.doc && app.doc.canUndo()) },
  redo: { label: 'Redo', keys: 'Ctrl+Y', alt: ['Ctrl+Shift+Z'], run: () => app.doc && app.doc.redo(), enabled: () => !!(app.doc && app.doc.canRedo()) },
  cut: { label: 'Cut', keys: 'Ctrl+X', run: () => ops.cut(), enabled: hasLayer },
  copy: { label: 'Copy', keys: 'Ctrl+C', run: () => ops.copy(false), enabled: hasLayer },
  copyMerged: { label: 'Copy Merged', run: () => ops.copy(true), enabled: hasDoc },
  paste: { label: 'Paste', keys: 'Ctrl+V', run: () => ops.paste() },
  fill: { label: 'Fill with Foreground Color', keys: 'Alt+Backspace', run: fillDialog, enabled: hasLayer },
  fillBg: { label: 'Fill with Background Color', keys: 'Ctrl+Backspace', run: () => ops.fillWith(app.bg), enabled: hasLayer },
  clear: { label: 'Clear', keys: 'Delete', run: () => ops.clearSelection(), enabled: hasSel },
  transform: { label: 'Free Transform', keys: 'Ctrl+T', run: () => app.setTool('transform'), enabled: hasLayer },
  shortcuts: { label: 'Keyboard Shortcuts', keys: 'Ctrl+/', run: () => shortcutsDialog() },

  // Image
  autoTone: { label: 'Auto Tone', keys: 'Ctrl+U', run: () => ops.autoTone(), enabled: hasDoc },
  autoWB: { label: 'Auto White Balance', keys: 'Ctrl+Shift+U', run: () => ops.autoWB(), enabled: hasDoc },
  brightness: { label: 'Brightness/Contrast…', run: () => filterDialog('brightness'), enabled: hasLayer },
  levels: { label: 'Levels…', keys: 'Ctrl+L', run: () => filterDialog('levels'), enabled: hasLayer },
  huesat: { label: 'Hue/Saturation…', run: () => filterDialog('huesat'), enabled: hasLayer },
  sepia: { label: 'Sepia Tone…', run: () => filterDialog('sepia'), enabled: hasLayer },
  invert: { label: 'Invert', keys: 'Ctrl+I', run: () => filterDialog('invert'), enabled: hasLayer },
  desaturate: { label: 'Desaturate', run: () => filterDialog('desaturate'), enabled: hasLayer },
  imageSize: { label: 'Image Size…', keys: 'Ctrl+Alt+I', run: () => imageSizeDialog(), enabled: hasDoc },
  canvasSize: { label: 'Canvas Size…', keys: 'Ctrl+Alt+C', run: () => canvasSizeDialog(), enabled: hasDoc },
  rotateCW: { label: 'Rotate 90° Clockwise', run: () => ops.rotate(90), enabled: hasDoc },
  rotateCCW: { label: 'Rotate 90° Counter-clockwise', run: () => ops.rotate(-90), enabled: hasDoc },
  rotate180: { label: 'Rotate 180°', run: () => ops.rotate(180), enabled: hasDoc },
  flipH: { label: 'Flip Horizontal', run: () => ops.flip(true), enabled: hasDoc },
  flipV: { label: 'Flip Vertical', run: () => ops.flip(false), enabled: hasDoc },
  cropToSel: { label: 'Crop to Selection', run: () => ops.cropToSelection(), enabled: hasSel },
  trim: { label: 'Trim Transparent Pixels', run: () => ops.trimTransparent(), enabled: hasDoc },

  // Layer
  newLayer: { label: 'New Layer', keys: 'Ctrl+Shift+N', run: () => ops.newLayer(), enabled: hasDoc },
  newText: { label: 'New Text Layer', run: () => app.setTool('text'), enabled: hasDoc },
  duplicate: { label: 'Duplicate Layer / Layer via Copy', keys: 'Ctrl+J', run: () => ops.layerViaCopy(false), enabled: hasLayer },
  viaCut: { label: 'Layer via Cut', keys: 'Ctrl+Shift+J', run: () => ops.layerViaCopy(true), enabled: hasSel },
  deleteLayer: { label: 'Delete Layer', run: () => ops.deleteLayer(), enabled: hasLayer },
  addMask: { label: 'Add Layer Mask', run: () => ops.addMask(true), enabled: hasLayer },
  applyMask: { label: 'Apply Layer Mask', run: () => ops.deleteMask(true), enabled: () => !!(app.doc && app.doc.active && app.doc.active.mask) },
  deleteMask: { label: 'Delete Layer Mask', run: () => ops.deleteMask(false), enabled: () => !!(app.doc && app.doc.active && app.doc.active.mask) },
  invertMask: { label: 'Invert Layer Mask', run: () => ops.invertMask(), enabled: () => !!(app.doc && app.doc.active && app.doc.active.mask) },
  rasterize: { label: 'Rasterize Type', run: () => ops.rasterizeLayer(), enabled: () => !!(app.doc && app.doc.active && app.doc.active.type === 'text') },
  layerUp: { label: 'Bring Forward', keys: 'Ctrl+]', run: () => ops.moveLayer(1), enabled: hasLayer },
  layerDown: { label: 'Send Backward', keys: 'Ctrl+[', run: () => ops.moveLayer(-1), enabled: hasLayer },
  mergeDown: { label: 'Merge Down', keys: 'Ctrl+E', run: () => ops.mergeDown(), enabled: hasLayer },
  mergeVisible: { label: 'Merge Visible to New Layer', keys: 'Ctrl+Alt+Shift+E', run: () => ops.mergeVisible(), enabled: hasDoc },
  flatten: { label: 'Flatten Image', run: () => ops.flattenImage(), enabled: hasDoc },

  // Select
  selectAll: { label: 'All', keys: 'Ctrl+A', run: () => ops.selectAll(), enabled: hasDoc },
  deselect: { label: 'Deselect', keys: 'Ctrl+D', run: () => ops.deselect(), enabled: hasSel },
  reselect: { label: 'Reselect', keys: 'Ctrl+Shift+D', run: () => ops.reselect(), enabled: () => !!(app.doc && app.doc.lastSelection) },
  inverse: { label: 'Inverse', keys: 'Ctrl+Shift+I', run: () => ops.inverseSelection(), enabled: hasDoc },
  selectLayer: { label: 'Select Layer Pixels', run: () => ops.selectLayerPixels(), enabled: hasLayer },
  feather: { label: 'Feather…', keys: 'Shift+F6', run: () => featherDialog(), enabled: hasSel },
  expand: { label: 'Expand…', run: () => growDialog(1), enabled: hasSel },
  contract: { label: 'Contract…', run: () => growDialog(-1), enabled: hasSel },

  // Filter
  lastFilter: { label: 'Repeat Last Filter', keys: 'Ctrl+F', run: () => repeatLastFilter(), enabled: () => !!app.lastFilter && hasLayer() },

  // View
  zoomIn: { label: 'Zoom In', keys: 'Ctrl+=', alt: ['Ctrl++'], run: () => app.view.zoomBy(2), enabled: hasDoc },
  zoomOut: { label: 'Zoom Out', keys: 'Ctrl+-', run: () => app.view.zoomBy(0.5), enabled: hasDoc },
  fit: { label: 'Fit on Screen', keys: 'Ctrl+0', run: () => app.view.fit(), enabled: hasDoc },
  actual: { label: 'Actual Pixels (100%)', keys: 'Ctrl+1', run: () => app.view.setZoom(1), enabled: hasDoc },
  before: { label: 'Show Before', keys: '\\', run: () => toggleBefore(), enabled: hasDoc, checked: () => app.before },
  filmstrip: { label: 'Show Filmstrip', run: () => app.toggleFilmstrip(), checked: () => app.prefs.filmstrip !== false },
  panels: { label: 'Show Panels', keys: 'Tab', run: () => app.togglePanels(), checked: () => !app.panelsHidden },
  fullscreen: { label: 'Full Screen', keys: 'F11', run: () => toggleFullscreen() },
  library: { label: 'Library', keys: 'Ctrl+Alt+1', run: () => app.setModule('library') },
  develop: { label: 'Develop', keys: 'Ctrl+Alt+2', run: () => app.setModule('develop') },
  edit: { label: 'Edit', keys: 'Ctrl+Alt+3', run: () => app.setModule('edit') },

  // Develop
  copySettings: { label: 'Copy Develop Settings', keys: 'Ctrl+Shift+C', run: () => copySettings(), enabled: hasDoc },
  pasteSettings: { label: 'Paste Develop Settings', keys: 'Ctrl+Shift+V', run: () => pasteSettings(), enabled: hasDoc },
  resetDevelop: { label: 'Reset Develop Settings', run: () => ops.resetDevelop(), enabled: hasDoc },

  // Colors
  swapColors: { label: 'Swap Colors', keys: 'X', run: swapColors },
  resetColors: { label: 'Default Colors', keys: 'D', run: resetColors },

  // Help
  about: { label: 'About Lumen Studio', run: () => aboutDialog() },
};

export function runAction(id) {
  const a = ACTIONS[id];
  if (!a) return;
  if (a.enabled && !a.enabled()) return;
  try {
    const r = a.run();
    if (r && r.catch) r.catch((e) => { console.error(e); app.status('Error: ' + e.message); });
  } catch (e) {
    console.error(e);
    app.status('Error: ' + e.message);
  }
}

export function filterMenu() {
  const groups = {};
  const order = ['Blur', 'Sharpen', 'Noise', 'Stylize'];
  return import('./filters.js').then(({ FILTERS }) => {
    for (const [id, f] of Object.entries(FILTERS)) {
      if (f.menu === 'Adjust') continue;
      (groups[f.menu] = groups[f.menu] || []).push({ label: f.name + (f.params.length ? '…' : ''), run: () => filterDialog(id), enabled: hasLayer });
    }
    return order.filter((g) => groups[g]).map((g) => ({ label: g, submenu: groups[g] }));
  });
}
