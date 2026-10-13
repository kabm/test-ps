// An oriented (rotatable) box with handles, shared by the Crop and Transform tools.

const HANDLES = {
  nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0],
};

export class OBox {
  constructor(cx, cy, w, h, angle = 0) {
    this.cx = cx;
    this.cy = cy;
    this.w = w;
    this.h = h;
    this.angle = angle; // degrees
  }

  clone() {
    return new OBox(this.cx, this.cy, this.w, this.h, this.angle);
  }

  get rad() {
    return (this.angle * Math.PI) / 180;
  }

  toLocal(p) {
    const a = -this.rad;
    const dx = p.x - this.cx;
    const dy = p.y - this.cy;
    return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
  }

  toDoc(l) {
    const a = this.rad;
    return { x: this.cx + l.x * Math.cos(a) - l.y * Math.sin(a), y: this.cy + l.x * Math.sin(a) + l.y * Math.cos(a) };
  }

  corners() {
    const hw = this.w / 2;
    const hh = this.h / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => this.toDoc({ x, y }));
  }

  handlePoints() {
    const out = {};
    for (const [k, [sx, sy]] of Object.entries(HANDLES)) out[k] = this.toDoc({ x: (sx * this.w) / 2, y: (sy * this.h) / 2 });
    return out;
  }

  // Returns 'move' | 'rotate' | handle key | null
  hitTest(p, view) {
    const tol = 9 / view.view.zoom;
    const hp = this.handlePoints();
    for (const [k, q] of Object.entries(hp)) {
      if (Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol) return k;
    }
    const l = this.toLocal(p);
    if (Math.abs(l.x) <= this.w / 2 && Math.abs(l.y) <= this.h / 2) return 'move';
    return 'rotate';
  }

  static cursorFor(hit, angle = 0) {
    if (hit === 'move') return 'move';
    if (hit === 'rotate') return 'alias';
    const dirs = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
    const cursors = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
    const i = dirs.indexOf(hit);
    if (i < 0) return 'default';
    const steps = Math.round(angle / 45);
    return cursors[(((i + steps) % 8) + 8) % 4];
  }

  // Begin a drag. Returns a function(p, mods) that updates the box.
  beginDrag(hit, p0, { aspect = 0, minSize = 2, constrainAngle = 45 } = {}) {
    const start = this.clone();
    if (hit === 'move') {
      return (p) => {
        this.cx = start.cx + (p.x - p0.x);
        this.cy = start.cy + (p.y - p0.y);
      };
    }
    if (hit === 'rotate') {
      const a0 = Math.atan2(p0.y - start.cy, p0.x - start.cx);
      return (p, mods = {}) => {
        const a1 = Math.atan2(p.y - start.cy, p.x - start.cx);
        let ang = start.angle + ((a1 - a0) * 180) / Math.PI;
        if (mods.shift) ang = Math.round(ang / 15) * 15;
        if (constrainAngle) ang = Math.max(-constrainAngle, Math.min(constrainAngle, ang));
        this.angle = ang;
      };
    }
    const [hx, hy] = HANDLES[hit];
    // the opposite side stays fixed
    const ax = (-hx * start.w) / 2;
    const ay = (-hy * start.h) / 2;
    return (p, mods = {}) => {
      const l = start.toLocal(p);
      let w = hx ? Math.abs(l.x - ax) : start.w;
      let h = hy ? Math.abs(l.y - ay) : start.h;
      const ratio = aspect || (mods.shift ? start.w / start.h : 0);
      if (ratio) {
        if (hx && hy) {
          if (w / h > ratio) h = w / ratio; else w = h * ratio;
        } else if (hx) h = w / ratio;
        else w = h * ratio;
      }
      w = Math.max(minSize, w);
      h = Math.max(minSize, h);
      const c = start.toDoc({ x: hx ? ax + (hx * w) / 2 : 0, y: hy ? ay + (hy * h) / 2 : 0 });
      this.cx = c.x;
      this.cy = c.y;
      this.w = w;
      this.h = h;
      this.angle = start.angle;
    };
  }

  draw(g, view, { handles = true, color = '#fff' } = {}) {
    const pts = this.corners().map((p) => view.docToScreen(p.x, p.y));
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.lineWidth = 1;
    g.strokeStyle = color;
    g.stroke();
    if (!handles) return;
    const hp = this.handlePoints();
    for (const q of Object.values(hp)) {
      const s = view.docToScreen(q.x, q.y);
      g.fillStyle = '#fff';
      g.strokeStyle = '#000';
      g.fillRect(s.x - 4, s.y - 4, 8, 8);
      g.strokeRect(s.x - 4 + 0.5, s.y - 4 + 0.5, 7, 7);
    }
  }
}
