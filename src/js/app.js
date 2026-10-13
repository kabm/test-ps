// Central application state shared by all modules.

import { Emitter } from './util.js';

class App extends Emitter {
  constructor() {
    super();
    this.docs = [];
    this.doc = null;
    this.module = 'library'; // 'library' | 'develop' | 'edit'
    this.toolId = 'move';
    this.tools = {};
    this.fg = '#000000';
    this.bg = '#ffffff';
    this.brush = { size: 40, hardness: 0.75, opacity: 1, flow: 1, pressure: true };
    this.previews = new Map(); // layer -> { canvas?, develop? }
    this.before = false;
    this.view = null;
    this.catalog = null;
    this.prefs = { userPresets: [], recent: [], filmstrip: true };
    this.clipboardDevelop = null;
    this.internalClipboard = null;
  }

  get tool() {
    return this.tools[this.toolId];
  }

  // Something visible in the current document changed.
  render() {
    if (this.view) this.view.invalidate();
  }

  status(msg, ms = 3500) {
    this.emit('status', msg, ms);
  }
}

export const app = new App();
if (typeof window !== 'undefined') window.__lumenApp = app;
