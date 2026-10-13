// Reusable form widgets.

import { el, clamp } from '../util.js';
import { icon } from './icons.js';

// Lightroom-style slider row: label, value, track. Double-click to reset.
export function slider({ label, min, max, step = 1, value = 0, def = 0, onInput, onCommit, format, gradient, title }) {
  const fmt = format || ((v) => {
    const s = step < 1 ? v.toFixed(step < 0.1 ? 2 : 1) : String(Math.round(v));
    return v > 0 && min < 0 ? '+' + s : s;
  });
  const input = el('input', { type: 'range', min, max, step, value });
  const valueEl = el('input', { class: 'slider-value', type: 'text', value: fmt(value), spellcheck: false });
  const labelEl = el('span', { class: 'slider-label', title: title || 'Double-click to reset' }, label);
  const row = el('div', { class: 'slider-row' + (gradient ? ' has-gradient' : '') },
    el('div', { class: 'slider-head' }, labelEl, valueEl),
    input);
  if (gradient) input.style.setProperty('--track', gradient);
  let startValue = value;
  const setFill = () => {
    const v = parseFloat(input.value);
    const zero = clamp((Math.max(min, Math.min(max, 0)) - min) / (max - min), 0, 1);
    const pos = (v - min) / (max - min);
    input.style.setProperty('--a', Math.min(zero, pos) * 100 + '%');
    input.style.setProperty('--b', Math.max(zero, pos) * 100 + '%');
  };
  setFill();
  input.addEventListener('pointerdown', () => { startValue = parseFloat(input.value); });
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    valueEl.value = fmt(v);
    setFill();
    onInput && onInput(v);
  });
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (v !== startValue) onCommit && onCommit(v);
    startValue = v;
  });
  const reset = () => {
    row.set(def);
    onInput && onInput(def);
    onCommit && onCommit(def);
  };
  labelEl.addEventListener('dblclick', reset);
  input.addEventListener('dblclick', reset);
  valueEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') valueEl.blur();
    if (e.key === 'Escape') { valueEl.value = fmt(parseFloat(input.value)); valueEl.blur(); }
  });
  valueEl.addEventListener('focus', () => valueEl.select());
  valueEl.addEventListener('change', () => {
    let v = parseFloat(valueEl.value.replace(/[^\d.+-]/g, ''));
    if (Number.isNaN(v)) v = parseFloat(input.value);
    v = clamp(v, min, max);
    row.set(v);
    onInput && onInput(v);
    onCommit && onCommit(v);
  });
  row.set = (v) => {
    input.value = v;
    valueEl.value = fmt(parseFloat(input.value));
    setFill();
  };
  row.get = () => parseFloat(input.value);
  row.input = input;
  return row;
}

export function numField({ label, value, min, max, step = 1, onChange, width = 56, suffix, title }) {
  const input = el('input', { type: 'number', value, min, max, step, style: { width: width + 'px' }, title });
  input.addEventListener('keydown', (e) => e.stopPropagation());
  input.addEventListener('change', () => {
    let v = parseFloat(input.value);
    if (Number.isNaN(v)) return;
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    input.value = v;
    onChange && onChange(v);
  });
  const wrap = el('label', { class: 'field' }, label ? el('span', { class: 'field-label' }, label) : null, input, suffix ? el('span', { class: 'field-suffix' }, suffix) : null);
  wrap.set = (v) => { input.value = v; };
  wrap.input = input;
  return wrap;
}

export function selectField({ label, options, value, onChange, title }) {
  const sel = el('select', { title });
  for (const o of options) {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    const opt = el('option', { value: v }, l);
    if (String(v) === String(value)) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange && onChange(sel.value));
  sel.addEventListener('keydown', (e) => e.stopPropagation());
  const wrap = el('label', { class: 'field' }, label ? el('span', { class: 'field-label' }, label) : null, sel);
  wrap.set = (v) => { sel.value = v; };
  wrap.select = sel;
  return wrap;
}

export function checkField({ label, value, onChange, title }) {
  const input = el('input', { type: 'checkbox', checked: !!value });
  input.addEventListener('change', () => onChange && onChange(input.checked));
  const wrap = el('label', { class: 'field check', title }, input, el('span', {}, label));
  wrap.set = (v) => { input.checked = !!v; };
  return wrap;
}

export function button({ label, iconName, title, onClick, cls = '', disabled }) {
  const b = el('button', { class: 'btn ' + cls, title: title || label || '', disabled },
    iconName ? icon(iconName, 16) : null, label ? el('span', {}, label) : null);
  b.addEventListener('click', (e) => onClick && onClick(e));
  return b;
}

export function iconButton(name, title, onClick, cls = '') {
  const b = el('button', { class: 'icon-btn ' + cls, title });
  b.appendChild(icon(name, 16));
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick && onClick(e); });
  return b;
}

export function segmented({ options, value, onChange, cls = '' }) {
  const wrap = el('div', { class: 'segmented ' + cls });
  const buttons = options.map(([v, l, t]) => {
    const b = el('button', { class: v === value ? 'active' : '', title: t || '' }, l);
    b.addEventListener('click', () => {
      buttons.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      onChange && onChange(v);
    });
    b.dataset.value = v;
    return b;
  });
  buttons.forEach((b) => wrap.appendChild(b));
  wrap.set = (v) => buttons.forEach((b) => b.classList.toggle('active', b.dataset.value === String(v)));
  return wrap;
}

// Collapsible panel section
export function section(title, body, { open = true, actions = null, id } = {}) {
  const key = id ? 'lumen-sec-' + id : null;
  if (key) {
    try {
      const saved = localStorage.getItem(key);
      if (saved != null) open = saved === '1';
    } catch { /* ignore */ }
  }
  const head = el('div', { class: 'section-head' },
    icon('chevronDown', 14),
    el('span', { class: 'section-title' }, title),
    actions ? el('div', { class: 'section-actions', onclick: (e) => e.stopPropagation() }, actions) : null);
  const content = el('div', { class: 'section-body' }, body);
  const sec = el('div', { class: 'section' + (open ? ' open' : '') }, head, content);
  head.addEventListener('click', () => {
    sec.classList.toggle('open');
    if (key) {
      try { localStorage.setItem(key, sec.classList.contains('open') ? '1' : '0'); } catch { /* ignore */ }
    }
  });
  sec.body = content;
  return sec;
}

export function colorSwatch({ value, onChange, title }) {
  const input = el('input', { type: 'color', value, title });
  input.addEventListener('input', () => onChange && onChange(input.value));
  input.set = (v) => { input.value = v; };
  return input;
}
