// Filmstrip of library photos shown under the canvas in Develop & Edit.

import { app } from '../app.js';
import { el } from '../util.js';
import { visibleEntries } from './library.js';
import { openCatalogEntry } from '../commands.js';

export function buildFilmstrip(container) {
  const cells = new Map();
  const io = new IntersectionObserver((items) => {
    for (const it of items) {
      if (!it.isIntersecting) continue;
      io.unobserve(it.target);
      const e = app.catalog.get(it.target.dataset.id);
      if (!e) continue;
      app.catalog.thumb(e).then((url) => {
        if (url) { it.target.innerHTML = ''; it.target.appendChild(el('img', { src: url, draggable: false })); }
      });
    }
  }, { root: container, rootMargin: '300px' });

  function render() {
    container.innerHTML = '';
    cells.clear();
    const list = visibleEntries();
    for (const e of list) {
      const cell = el('div', { class: 'film-cell', 'data-id': e.id, title: e.name }, e._thumbUrl ? el('img', { src: e._thumbUrl, draggable: false }) : null);
      cell.addEventListener('click', () => openCatalogEntry(e));
      cells.set(e.id, cell);
      container.appendChild(cell);
      if (!e._thumbUrl) io.observe(cell);
    }
    mark();
  }

  function mark() {
    const open = new Set(app.docs.map((d) => d.catalogId).filter(Boolean));
    const cur = app.doc && app.doc.catalogId;
    for (const [id, cell] of cells) {
      cell.classList.toggle('open', open.has(id));
      cell.classList.toggle('active', id === cur);
    }
    const a = cur && cells.get(cur);
    if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  app.catalog.on('change', render);
  app.on('library-filter', render);
  app.catalog.on('thumb', (e) => {
    const cell = cells.get(e.id);
    if (cell) { cell.innerHTML = ''; cell.appendChild(el('img', { src: e._thumbUrl, draggable: false })); }
  });
  app.on('doc', mark);
  app.on('docs', mark);
  container.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      container.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
  render();
}
