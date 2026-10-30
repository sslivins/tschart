/*
 * tschart (web) - dependency-free time-series chart, the browser twin of the
 * LVGL widget in ../src. Same concepts and names: sources, panes, layers,
 * groups (chips), keys, spans, notes, a collapsible axis gutter, end tags,
 * a cursor card and pan with snap / spring-back. See ../docs/api.md.
 *
 * Usable as a plain <script> (global TsChart) or from node
 * (require('./tschart.js')) for the logic tests.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.TsChart = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ---------------------------------------------------------------- logic ----
// Ported from src/tschart_logic.cpp. Integer division truncates like C so
// both implementations produce identical pixels for the same input.

const idiv = (a, b) => Math.trunc(a / b) + 0;   // + 0 turns -0 into 0
const isNone = v => v === null || v === undefined || Number.isNaN(v);

function floorTo(v, step) {
    const q = idiv(v, step);
    return (v % step !== 0 && v < 0 ? q - 1 : q) * step;
}

function ceilTo(v, step) {
    const q = idiv(v, step);
    return (v % step !== 0 && v > 0 ? q + 1 : q) * step;
}

function niceAxis(lo, hi, maxSteps, minStep) {
    if (hi < lo) [lo, hi] = [hi, lo];
    if (!(maxSteps >= 1)) maxSteps = 1;
    if (!(minStep >= 1)) minStep = 1;
    let decade = minStep;
    let axis = { lo, hi, step: minStep };
    for (let guard = 0; guard < 30; guard++) {
        for (const m of [1, 2, 5]) {
            const step = decade * m;
            const a = floorTo(lo, step);
            let b = ceilTo(hi, step);
            if (a === b) b += step;
            axis = { lo: a, hi: b, step };
            if (idiv(b - a, step) <= maxSteps) return axis;
        }
        decade *= 10;
        if (decade > 2147483647 / 5) break;
    }
    return axis;
}

// cfg: {auto, hasMin, hasMax, min, max, minSpan, includeZero, padPermille,
// minPad, minStep}. No data when dataLo > dataHi.
function autoRange(cfg, dataLo, dataHi, maxSteps) {
    const c = Object.assign({ auto: true, min: 0, max: 0, minSpan: 0, padPermille: 0,
                              minPad: 0, minStep: 1 }, cfg);
    const haveData = dataLo <= dataHi;
    if (!c.auto) {
        const lo = c.hasMin ? c.min : (haveData ? dataLo : 0);
        let hi = c.hasMax ? c.max : (haveData ? dataHi : lo + 1);
        if (hi <= lo) hi = lo + 1;
        const s = niceAxis(lo, hi, maxSteps, c.minStep);
        return { lo: c.hasMin ? c.min : s.lo, hi: c.hasMax ? c.max : s.hi, step: s.step };
    }
    let lo, hi;
    if (haveData) {
        lo = dataLo;
        hi = dataHi;
    } else {
        lo = 0;
        hi = c.minSpan > 0 ? c.minSpan : (c.minStep > 0 ? c.minStep : 1);
    }
    if (c.includeZero) {
        if (lo > 0) lo = 0;
        if (hi < 0) hi = 0;
    }
    const padding = span => {
        const p = idiv(span * c.padPermille, 1000);
        return p < c.minPad ? c.minPad : p;
    };
    if (c.includeZero && (lo === 0 || hi === 0)) {
        const pad = padding(hi - lo);
        if (lo === 0) {
            hi += pad;
            if (hi < c.minSpan) hi = c.minSpan;
        } else {
            lo -= pad;
            if (lo > -c.minSpan) lo = -c.minSpan;
        }
    } else {
        if (hi - lo < c.minSpan) {
            const mid = idiv(lo + hi, 2);
            lo = mid - idiv(c.minSpan, 2);
            hi = lo + c.minSpan;
        }
        const pad = padding(hi - lo);
        lo -= pad;
        hi += pad;
    }
    if (c.hasMin && lo > c.min) lo = c.min;
    if (c.hasMax && hi < c.max) hi = c.max;
    return niceAxis(lo, hi, maxSteps, c.minStep);
}

function mapX(t, start, end, x1, x2) {
    if (end <= start || t <= start) return x1;
    if (t >= end) return x2;
    return x1 + Math.floor((t - start) * (x2 - x1) / (end - start));
}

function mapY(v, lo, hi, y1, y2) {
    if (hi <= lo) return y2;
    return y2 - idiv((v - lo) * (y2 - y1), hi - lo);
}

function timeAt(x, start, end, x1, x2) {
    if (x <= x1 || x2 <= x1 || end <= start) return start;
    if (x >= x2) return end;
    return start + Math.floor((x - x1) * (end - start) / (x2 - x1));
}

// Smooths whole-unit staircases: anchors at segment ends and plateau
// midpoints, linear in between. Unlike C the result is not truncated.
function interpolatePlateaus(t, v, gap) {
    const n = t.length;
    const out = new Array(n).fill(null);
    let a = 0;
    while (a < n) {
        if (isNone(v[a])) { a++; continue; }
        let b = a;
        while (b + 1 < n && !isNone(v[b + 1]) && t[b + 1] - t[b] <= gap) b++;
        let t0 = 2 * t[a], v0 = v[a], k = a;
        const emitTo = (t1, v1) => {
            while (k <= b && 2 * t[k] <= t1) {
                const tk = 2 * t[k];
                out[k] = t1 > t0 ? v0 + (v1 - v0) * (tk - t0) / (t1 - t0) : v1;
                k++;
            }
            t0 = t1;
            v0 = v1;
        };
        for (let i = a; i <= b;) {
            let j = i;
            while (j + 1 <= b && v[j + 1] === v[i]) j++;
            emitTo(t[i] + t[j], v[i]);
            i = j + 1;
        }
        emitTo(2 * t[b], v[b]);
        a = b + 1;
    }
    return out;
}

// Per pixel column keeps first/min/max/last. Returns [{x, v, brk}].
function decimate(xs, t, v, gap) {
    const n = t.length;
    const out = [];
    let inSeg = false;
    let i = 0;
    while (i < n) {
        if (isNone(v[i])) { inSeg = false; i++; continue; }
        if (inSeg && t[i] - t[i - 1] > gap) inSeg = false;
        const brk = !inSeg;
        let j = i + 1, lo = i, hi = i;
        while (j < n && xs[j] === xs[i] && !isNone(v[j]) && t[j] - t[j - 1] <= gap) {
            if (v[j] < v[lo]) lo = j;
            if (v[j] > v[hi]) hi = j;
            j++;
        }
        const pick = [i, Math.min(lo, hi), Math.max(lo, hi), j - 1];
        let prev = -1, first = true;
        for (const p of pick) {
            if (p === prev || (prev !== -1 && p < prev)) continue;
            out.push({ x: xs[p], v: v[p], brk: brk && first });
            first = false;
            prev = p;
        }
        inSeg = true;
        i = j;
    }
    return out;
}

// Inclusive slots [{y1, y2}]; hidden panes get y2 < y1.
function splitPanes(y1, y2, gap, weights, mins, visible) {
    const n = weights.length;
    const out = [];
    let k = 0;
    for (let i = 0; i < n; i++) {
        out.push({ y1, y2: y1 - 1 });
        if (visible[i]) k++;
    }
    if (k === 0) return out;
    const avail = (y2 - y1 + 1) - gap * (k - 1);
    if (avail <= 0) return out;
    const fixed = new Array(n).fill(false);
    const h = new Array(n).fill(0);
    const minH = i => (mins && mins[i]) || 0;
    for (let pass = 0; pass < 16; pass++) {
        let left = avail, wsum = 0;
        for (let i = 0; i < n; i++) {
            if (!visible[i]) continue;
            if (fixed[i]) left -= minH(i);
            else wsum += weights[i] || 1;
        }
        let changed = false;
        for (let i = 0; i < n; i++) {
            if (!visible[i] || fixed[i]) continue;
            h[i] = wsum ? Math.floor(Math.max(left, 0) * (weights[i] || 1) / wsum) : 0;
            if (h[i] < minH(i) && left > 0) {
                let fixedSum = 0;
                for (let j = 0; j < n; j++) {
                    if (visible[j] && (fixed[j] || j === i)) fixedSum += minH(j);
                }
                if (fixedSum <= avail) {
                    fixed[i] = true;
                    changed = true;
                }
            }
        }
        if (!changed) break;
    }
    let y = y1, seen = 0;
    for (let i = 0; i < n; i++) {
        if (!visible[i]) continue;
        seen++;
        let hi = fixed[i] ? minH(i) : h[i];
        if (seen === k) hi = y2 - y + 1;
        out[i] = { y1: y, y2: y + hi - 1 };
        y += hi + gap;
    }
    return out;
}

function ticksForHeight(height, maxTicks, minPx) {
    let t = maxTicks > 0 ? maxTicks : 1;
    if (minPx > 0 && idiv(height, minPx) < t) t = idiv(height, minPx);
    return t < 1 ? 1 : t;
}

// Moves label centres y[] (in place) so none overlap; returns the order
// from top to bottom.
function placeTags(y, h, gap, top, bottom) {
    const n = y.length;
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    for (let i = 1; i < n; i++) {
        const o = order[i];
        let j = i;
        while (j > 0 && y[order[j - 1]] > y[o]) {
            order[j] = order[j - 1];
            j--;
        }
        order[j] = o;
    }
    const pitch = h + gap;
    const ymin = top + idiv(h, 2);
    const ymax = bottom - (h - idiv(h, 2));
    const down = () => {
        for (let i = 0; i < n; i++) {
            const o = order[i];
            if (y[o] < ymin) y[o] = ymin;
            if (i > 0 && y[o] < y[order[i - 1]] + pitch) y[o] = y[order[i - 1]] + pitch;
        }
    };
    down();
    for (let i = n - 1; i >= 0; i--) {
        const o = order[i];
        if (y[o] > ymax) y[o] = ymax;
        if (i + 1 < n && y[o] > y[order[i + 1]] - pitch) y[o] = y[order[i + 1]] - pitch;
    }
    down();
    return order;
}

function panLimits(start, end, earliest, latest, width) {
    const w = end - start;
    if (w <= 0 || width <= 0) return { minDx: 0, maxDx: 0 };
    const fwd = latest > end ? latest - end : 0;
    const back = start > earliest ? start - earliest : 0;
    return { minDx: 0 - Math.floor(fwd * width / w), maxDx: Math.floor(back * width / w) };
}

function rubberBand(dx, lim) {
    if (dx > lim.maxDx) return lim.maxDx + idiv(dx - lim.maxDx, 3);
    if (dx < lim.minDx) return lim.minDx + idiv(dx - lim.minDx, 3);
    return dx;
}

// New window end for a release after dragging dx px, or null to spring back.
function panTarget(dx, start, end, earliest, latest, width, snap) {
    const w = end - start;
    if (w <= 0 || width <= 0) return null;
    const lim = panLimits(start, end, earliest, latest, width);
    if (dx < lim.minDx) dx = lim.minDx;
    if (dx > lim.maxDx) dx = lim.maxDx;
    if (dx === 0) return null;
    const secs = idiv(-dx * w, width);
    const s = snap > 0 ? snap : 1;
    const steps = idiv(secs >= 0 ? secs + idiv(s, 2) : secs - idiv(s, 2), s);
    if (steps === 0) return null;
    let e = end + steps * s;
    if (e > latest) e = latest;
    if (e < earliest + w) e = earliest + w;
    if (e < w) e = w;
    return e === end ? null : e;
}

// Where the not-yet-loaded part of a shifted window sits, in permille of
// the plot width (500 = centre).
function uncoveredPermille(fromStart, fromEnd, toStart, toEnd) {
    const span = toEnd - toStart;
    if (span <= 0 || fromEnd - fromStart !== span) return 500;
    const shift = toEnd - fromEnd;
    if (shift === 0 || shift >= span || -shift >= span) return 500;
    if (shift < 0) return idiv(-shift * 500, span);
    return 1000 - idiv(shift * 500, span);
}

const TICK_STEPS = [900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

function timeTickStep(window, maxIntervals) {
    if (!(maxIntervals >= 1)) maxIntervals = 1;
    for (const s of TICK_STEPS) {
        if (idiv(window, s) <= maxIntervals) return s;
    }
    return TICK_STEPS[TICK_STEPS.length - 1];
}

function firstTick(start, step, sinceMidnight) {
    if (!step) return start;
    return start + (step - sinceMidnight % step) % step;
}

function nearestX(xs, ok, px, maxDx) {
    let best = -1, bestDx = Infinity;
    for (let i = 0; i < xs.length; i++) {
        if (ok && !ok[i]) continue;
        const d = Math.abs(xs[i] - px);
        if (d < bestDx) {
            bestDx = d;
            best = i;
        }
    }
    return bestDx <= maxDx ? best : -1;
}

function nearestTime(t, at, maxDt) {
    const n = t.length;
    if (n === 0) return -1;
    let lo = 0, hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t[mid] < at) lo = mid + 1;
        else hi = mid;
    }
    let best = -1, bestDt = Infinity;
    if (lo < n) {
        best = lo;
        bestDt = t[lo] - at;
    }
    if (lo > 0 && at - t[lo - 1] <= bestDt) {
        best = lo - 1;
        bestDt = at - t[lo - 1];
    }
    return bestDt <= maxDt ? best : -1;
}

// group[i] = index of the first note in i's group.
function groupNotes(xs, labelW) {
    const group = new Array(xs.length);
    let count = 0, i = 0;
    while (i < xs.length) {
        let j = i + 1;
        while (j < xs.length && xs[j] < xs[i] + labelW) j++;
        for (let k = i; k < j; k++) group[k] = i;
        count++;
        i = j;
    }
    return { count, group };
}

const logic = {
    niceAxis, autoRange, mapX, mapY, timeAt, interpolatePlateaus, decimate,
    splitPanes, ticksForHeight, placeTags, panLimits, rubberBand, panTarget,
    uncoveredPermille, timeTickStep, firstTick, nearestX, nearestTime, groupNotes,
};

// --------------------------------------------------------------- widget ----

const SVGNS = 'http://www.w3.org/2000/svg';

// Pixel metrics; the device values scaled for a browser. Override per chart
// with options.metrics.
const METRICS = {
    sidePad: 8, topPad: 6, timeAxisH: 22, noteStripH: 22, paneGap: 8,
    gutterW: 52, panStartPx: 10, cursorSnapPx: 30, springMs: 180,
    doubleTapMs: 350, doubleTapAfterPanMs: 600, longPressMs: 450,
    noteLabelW: 70, cardMaxRows: 10, tickMinPx: 30, tagH: 18,
};

const CSS = `
.tschart{position:relative;display:flex;flex-direction:column;min-height:160px;
 font:12px/1.3 system-ui,sans-serif;color:var(--ts-text,#e6e6ef);user-select:none;
 -webkit-user-select:none}
.tschart-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:6px}
.tschart-head:empty{display:none}
.tschart-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;
 border-radius:999px;border:1px solid var(--ts-grid,#3a3a4a);background:transparent;
 color:inherit;font:inherit;cursor:pointer}
.tschart-chip[aria-pressed=true]{border-color:var(--ts-chip,currentColor)}
.tschart-chip[aria-pressed=false]{color:var(--ts-dim,#8a8a9a)}
.tschart-sw{display:inline-block;width:16px;height:4px;border-radius:2px}
.tschart-sw.fill{width:12px;height:12px;border-radius:3px}
.tschart-chip[aria-pressed=false] .tschart-sw{opacity:.3}
.tschart-spacer{flex:1}
.tschart-tagbtn{padding:4px 8px}
.tschart-key{display:inline-flex;align-items:center;gap:5px;color:var(--ts-dim,#8a8a9a)}
.tschart-key i{display:inline-block;width:10px;height:10px;border-radius:2px}
.tschart-body{position:relative;flex:1;min-height:0;touch-action:pan-y}
.tschart-body svg{position:absolute;inset:0;width:100%;height:100%;overflow:hidden}
.tschart-body text{fill:var(--ts-dim,#8a8a9a);font:11px system-ui,sans-serif}
.tschart-pill{position:absolute;padding:1px 7px;border-radius:999px;font:inherit;
 font-size:11px;background:var(--ts-panel,#1a1a2e);border:1px solid var(--ts-grid,#3a3a4a);
 cursor:pointer;z-index:2}
.tschart-tag{position:absolute;padding:0 5px;border-radius:4px;border:1px solid;
 background:var(--ts-panel,#1a1a2e);font-size:11px;line-height:16px;white-space:nowrap;
 transform:translateY(-50%);pointer-events:none;z-index:1}
.tschart-edge{position:absolute;padding:2px 8px;border-radius:6px;font-size:11px;
 background:var(--ts-panel,#1a1a2e);color:var(--ts-dim,#8a8a9a);white-space:nowrap;
 transform:translate(-50%,-50%);pointer-events:none}
.tschart-card{position:absolute;z-index:3;min-width:150px;padding:8px 10px;border-radius:10px;
 background:var(--ts-card,rgba(26,26,46,.92));box-shadow:0 4px 16px rgba(0,0,0,.35);
 pointer-events:none;font-size:12px}
.tschart-row{display:flex;align-items:center;gap:6px;min-height:20px}
.tschart-row .v{margin-left:auto;padding-left:12px;font-variant-numeric:tabular-nums}
.tschart-row.title,.tschart-row.text{color:var(--ts-dim,#8a8a9a)}
.tschart-row.warning{color:var(--ts-danger,#ff5c5c)}
.tschart-row .sw{display:inline-block;width:14px;height:3px;border-radius:2px}
.tschart-row.block .sw{width:10px;height:10px;border-radius:2px}
.tschart-status{position:absolute;transform:translate(-50%,-50%);color:var(--ts-dim,#8a8a9a);
 pointer-events:none;text-align:center}
.tschart-spin{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;
 border:3px solid var(--ts-grid,#3a3a4a);border-top-color:var(--ts-text,#e6e6ef);
 border-radius:50%;animation:tschart-spin .8s linear infinite;pointer-events:none}
@keyframes tschart-spin{to{transform:rotate(360deg)}}
.tschart.panning .tschart-body{cursor:grabbing}
.tschart-grid{stroke:var(--ts-grid,#2e2e3e);stroke-width:1}
.tschart-gutter{fill:var(--ts-panel,#1a1a2e);fill-opacity:.9}
.tschart-cursor{stroke:var(--ts-dim,#8a8a9a);stroke-dasharray:4 4}
.tschart-dot{stroke:var(--ts-panel,#1a1a2e);stroke-width:2}
.tschart-edge-line{stroke:var(--ts-dim,#8a8a9a);stroke-opacity:.6}
.tschart-ov{position:absolute;inset:0;pointer-events:none}
.tschart-ov .tschart-pill{pointer-events:auto}
`;

let cssInjected = false;
function injectCss() {
    if (cssInjected || typeof document === 'undefined') return;
    cssInjected = true;
    const st = document.createElement('style');
    st.id = 'tschart-css';
    st.textContent = CSS;
    document.head.appendChild(st);
}

function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function s(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function defaultTimeFormat(t, step) {
    const d = new Date(t * 1000);
    if (step >= 86400) return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function localSinceMidnight(t) {
    const d = new Date(t * 1000);
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

let chartSeq = 0;

class TsChart {
    /**
     * @param {HTMLElement} root  element the chart fills (give it a height)
     * @param {object} opts  {id, timeFormat(t, step), edgeText:{before, after},
     *   panSnap (s or fn(windowSeconds)), header:{chips, key, tagsButton},
     *   storageKey, metrics}
     */
    constructor(root, opts = {}) {
        injectCss();
        this.o = opts;
        this.m = Object.assign({}, METRICS, opts.metrics);
        this.uid = 'tsc' + (++chartSeq);
        this.sources = [];
        this.panes = [];
        this.layers = [];
        this.groups = [];
        this.keys = [];
        this.spans = [];
        this.notes = [];
        this.notePrefix = '';
        this.earliest = 0;
        this.latest = 0;
        this.win = null;            // committed {start, end}
        this.pending = null;        // requested {id, start, end}
        this.reqId = 0;
        this.data = null;           // {sources: Map id -> {t, samples, gap}}
        this.axisOpen = false;
        this.endTags = true;
        this.cursor = null;         // {x, index, time}
        this.status = { st: 'ok', text: '' };
        this.cardCb = null;
        this.dx = 0;                // live pan offset (px)
        this.gesture = null;
        this.deferred = null;
        this._restore();
        this._build(root);
    }

    // ---- configuration ----

    addSource(id) {
        const src = { id, index: this.sources.length };
        this.sources.push(src);
        return src;
    }

    /** cfg: {id, weight, minHeight, unit, color, range:{...autoRange cfg},
     *  maxTicks, fmt(v, ctx) with ctx 'axis' | 'tag' | 'cursor'} */
    addPane(cfg) {
        const p = Object.assign({ weight: 1, minHeight: 0, unit: '', color: 'currentColor',
                                  maxTicks: 5, range: { auto: true },
                                  fmt: v => String(Math.round(v)) }, cfg);
        p.layers = [];
        p.groups = [];
        p.index = this.panes.length;
        this.panes.push(p);
        this._dirty();
        return p;
    }

    /** cfg: {id, name, tag, source, value(sample) -> number|null,
     *  geom 'line'|'step', interp 'none'|'plateau', fill, fillOpacity, color,
     *  width, dash, inCursor, drivesRange} */
    addLayer(pane, cfg) {
        const l = Object.assign({ geom: 'line', interp: 'none', fill: false, fillOpacity: 0.3,
                                  width: 2, inCursor: true, drivesRange: true, tag: null }, cfg);
        l.pane = pane;
        l.groups = [];
        l.source = l.source || this.sources[0];
        pane.layers.push(l);
        this.layers.push(l);
        if (this.data) this._derive();
        this._dirty();
        return l;
    }

    /** cfg: {id, label, color, swatch 'line'|'fill', panes:[], layers:[]} */
    addGroup(cfg) {
        const g = Object.assign({ swatch: 'line', panes: [], layers: [] }, cfg);
        const saved = this.saved.groups && this.saved.groups[g.id];
        g.visible = saved !== undefined ? saved : (cfg.visible !== false);
        g.panes.forEach(p => p.groups.push(g));
        g.layers.forEach(l => l.groups.push(g));
        this.groups.push(g);
        this._header();
        this._dirty();
        return g;
    }

    setGroupVisible(id, on) {
        const g = this.groups.find(x => x.id === id);
        if (!g || g.visible === !!on) return;
        g.visible = !!on;
        this._save();
        this._header();
        this._dirty();
    }

    getGroupVisible(id) {
        const g = this.groups.find(x => x.id === id);
        return g ? g.visible : false;
    }

    /** style 'fill' | 'hatch' */
    addKey(id, label, color, style = 'fill') {
        this.keys.push({ id, label, color, style });
        this._header();
    }

    clearKeys() {
        this.keys = [];
        this._header();
    }

    setEdgeText(before, after) {
        this.o.edgeText = { before, after };
        this._overlay();
    }

    setBounds(earliest, latest) {
        this.earliest = earliest;
        this.latest = latest;
    }

    setAxisOpen(on) {
        this.axisOpen = !!on;
        this._save();
        this._overlay();
    }

    getAxisOpen() { return this.axisOpen; }

    setEndTags(on) {
        this.endTags = !!on;
        this._save();
        this._header();
        this._overlay();
    }

    getEndTags() { return this.endTags; }

    /** cb(info {time, index, source, sample}, card) adds rows with
     *  card.add(kind, label, value, color) and card.addLayers(). */
    setCard(cb) { this.cardCb = cb; }

    getWindow() { return this.win ? { ...this.win } : null; }

    getTargetWindow() {
        return this.pending ? { start: this.pending.start, end: this.pending.end } : this.getWindow();
    }

    /** Plot rectangle in px relative to the chart body (for host overlays/tests). */
    getPlotArea() { return this.geom ? { ...this.geom.plot } : null; }

    /** x position (px, body coords) of time t in the committed window. */
    xAt(t) {
        const g = this.geom;
        return g ? mapX(t, this.win.start, this.win.end, g.plot.x1, g.plot.x2) : 0;
    }

    timeAtX(x) {
        const g = this.geom;
        return g ? timeAt(x, this.win.start, this.win.end, g.plot.x1, g.plot.x2) : 0;
    }

    // ---- data and windows ----

    /** Ask the host for a window; emits tschart:window-request and returns
     *  the request id to pass back with setDataset. */
    requestWindow(start, end) {
        this.reqId++;
        this.pending = { id: this.reqId, start, end };
        this._clearCursor();
        this.dx = this._shiftFor(this.pending);
        this._applyShift();
        this._emit('window-request', { requestId: this.reqId, start, end });
        this._overlay();
        return this.reqId;
    }

    /** ds: {requestId (0/undefined = unsolicited), start, end,
     *  sources: {sourceId: {samples, time: key|fn, gap}}, applied()}.
     *  Returns false when stale. */
    setDataset(ds) {
        const id = ds.requestId || 0;
        const stale = id ? (!this.pending || id !== this.pending.id) : !!this.pending;
        if (stale) return false;
        if (this.gesture || this.spring) {
            this.deferred = ds;
            return true;
        }
        this._apply(ds);
        return true;
    }

    cancelPending() {
        if (!this.pending) return;
        this.pending = null;
        this._springTo(0);
        this._overlay();
    }

    /** spans: [{start, end (0/null = open), color, opacity, style 'fill'|'hatch',
     *  minWidth}] drawn in setId order. */
    setSpans(setId, spans) {
        this.spans[setId] = (spans || []).slice();
        this._dirty();
    }

    /** notes: [{time, text, color}]; colliding notes share one label. */
    setNotes(notes, prefix = '') {
        this.notes = (notes || []).slice().sort((a, b) => a.time - b.time);
        this.notePrefix = prefix;
        this._dirty();
    }

    /** st: 'ok' | 'loading' | 'empty' | 'error' */
    setStatus(st, text = '') {
        this.status = { st, text };
        this._overlay();
    }

    clearCursor() {
        this._clearCursor();
        this._overlay();
    }

    destroy() {
        if (this.ro) this.ro.disconnect();
        cancelAnimationFrame(this.raf);
        this.root.remove();
    }

    _apply(ds) {
        this.deferred = null;
        this.pending = null;
        this.dx = 0;
        this.win = { start: ds.start, end: ds.end };
        const map = new Map();
        for (const src of this.sources) {
            const d = ds.sources && ds.sources[src.id];
            if (!d) continue;
            const samples = d.samples || [];
            const tf = typeof d.time === 'function' ? d.time : (x => x[d.time || 't']);
            map.set(src.id, { samples, t: samples.map(tf), gap: d.gap || Infinity });
        }
        this.data = { sources: map };
        this._derive();
        this._clearCursor();
        if (ds.applied) ds.applied();
        this._dirty();
    }

    _derive() {
        for (const l of this.layers) {
            const d = this.data.sources.get(l.source.id);
            if (!d) { l.raw = l.vals = null; continue; }
            l.raw = d.samples.map(x => {
                const v = l.value(x);
                return isNone(v) ? null : v;
            });
            l.vals = l.interp === 'plateau' ? interpolatePlateaus(d.t, l.raw, d.gap) : l.raw;
        }
    }

    // ---- persistence ----

    _restore() {
        this.saved = {};
        const k = this.o.storageKey;
        if (!k) return;
        try {
            this.saved = JSON.parse(localStorage.getItem(k)) || {};
        } catch (e) { this.saved = {}; }
        if (typeof this.saved.axisOpen === 'boolean') this.axisOpen = this.saved.axisOpen;
        if (typeof this.saved.endTags === 'boolean') this.endTags = this.saved.endTags;
    }

    _save() {
        const k = this.o.storageKey;
        if (!k) return;
        const groups = {};
        this.groups.forEach(g => { groups[g.id] = g.visible; });
        try {
            localStorage.setItem(k, JSON.stringify({ axisOpen: this.axisOpen,
                                                     endTags: this.endTags, groups }));
        } catch (e) { /* storage full or blocked */ }
    }

    _emit(name, detail) {
        this.root.dispatchEvent(new CustomEvent('tschart:' + name, { detail, bubbles: true }));
    }

    // ---- DOM ----

    _build(root) {
        this.root = root;
        root.classList.add('tschart');
        if (this.o.id) root.dataset.tschart = this.o.id;
        root.textContent = '';
        this.head = h('div', 'tschart-head');
        this.body = h('div', 'tschart-body');
        root.append(this.head, this.body);
        this.svg = s('svg', { class: 'tschart-svg' }, this.body);
        this.defs = s('defs', {}, this.svg);
        this.clip = s('rect', {}, s('clipPath', { id: this.uid + '-clip' }, this.defs));
        this.stClip = s('g', { 'clip-path': `url(#${this.uid}-clip)` }, this.svg);
        this.stat = s('g', { class: 'tschart-static' }, this.stClip);
        this.dyn = s('g', { class: 'tschart-dyn' }, this.svg);
        this.ov = h('div', 'tschart-ov');
        this.body.appendChild(this.ov);
        this.patterns = new Map();
        this._bindInput();
        if (typeof ResizeObserver !== 'undefined') {
            this.ro = new ResizeObserver(() => this._dirty());
            this.ro.observe(this.body);
        }
        this._header();
    }

    _hatch(color) {
        let id = this.patterns.get(color);
        if (id) return id;
        id = `${this.uid}-hatch${this.patterns.size}`;
        const p = s('pattern', { id, width: 8, height: 8, patternUnits: 'userSpaceOnUse',
                                 patternTransform: 'rotate(45)' }, this.defs);
        s('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: color, 'stroke-width': 2,
                    'stroke-opacity': 0.4 }, p);
        this.patterns.set(color, id);
        return id;
    }

    _header() {
        if (!this.head) return;
        const hd = Object.assign({ chips: true, key: true, tagsButton: true }, this.o.header);
        this.head.textContent = '';
        if (hd.chips) {
            for (const g of this.groups) {
                const b = h('button', 'tschart-chip');
                b.type = 'button';
                b.dataset.tschartChip = g.id;
                b.setAttribute('aria-pressed', String(g.visible));
                b.style.setProperty('--ts-chip', g.color);
                const sw = h('span', 'tschart-sw' + (g.swatch === 'fill' ? ' fill' : ''));
                sw.style.background = g.color;
                b.append(sw, document.createTextNode(g.label));
                b.addEventListener('click', () => {
                    g.visible = !g.visible;
                    this._clearCursor();
                    this._save();
                    this._header();
                    this._dirty();
                    this._emit('group-toggled', { id: g.id, visible: g.visible });
                });
                this.head.appendChild(b);
            }
        }
        if (hd.tagsButton || (hd.key && this.keys.length)) this.head.appendChild(h('span', 'tschart-spacer'));
        if (hd.key) {
            for (const k of this.keys) {
                const e = h('span', 'tschart-key');
                e.dataset.tschartKey = k.id;
                const sw = h('i');
                if (k.style === 'hatch') {
                    sw.style.border = `2px solid ${k.color}`;
                    sw.style.background = `repeating-linear-gradient(45deg, ${k.color} 0 2px, transparent 2px 5px)`;
                    sw.style.opacity = '0.8';
                } else {
                    sw.style.background = k.color;
                }
                e.append(sw, document.createTextNode(k.label));
                this.head.appendChild(e);
            }
        }
        if (hd.tagsButton) {
            const b = h('button', 'tschart-chip tschart-tagbtn');
            b.type = 'button';
            b.dataset.tschartTags = '';
            b.title = 'Value tags';
            b.setAttribute('aria-pressed', String(this.endTags));
            b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
                'stroke="currentColor" stroke-width="2"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0' +
                'L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>';
            b.addEventListener('click', () => {
                this.setEndTags(!this.endTags);
                this._emit('tags-toggled', { on: this.endTags });
            });
            this.head.appendChild(b);
        }
    }

    // ---- layout and the static layer ----

    _dirty() {
        this.needStatic = true;
        this._schedule();
    }

    _overlay() {
        this._schedule();
    }

    _schedule() {
        if (this.raf || typeof requestAnimationFrame === 'undefined') return;
        this.raf = requestAnimationFrame(() => {
            this.raf = 0;
            if (this.needStatic) {
                this.needStatic = false;
                this._layout();
                this._drawStatic();
            }
            this._drawOverlay();
        });
    }

    /** Render synchronously (tests, screenshots). */
    flush() {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.needStatic = false;
        this._layout();
        this._drawStatic();
        this._drawOverlay();
    }

    _layerVisible(l) {
        const gs = l.groups.length ? l.groups : l.pane.groups;
        return !gs.length || gs.some(g => g.visible);
    }

    _paneVisible(p) {
        if (!p.layers.length) return !p.groups.length || p.groups.some(g => g.visible);
        return p.layers.some(l => this._layerVisible(l));
    }

    _notesInWindow() {
        if (!this.win) return [];
        return this.notes.filter(n => n.time >= this.win.start && n.time <= this.win.end);
    }

    _layout() {
        const W = this.body.clientWidth, H = this.body.clientHeight;
        if (!W || !H) { this.geom = null; return; }
        const m = this.m;
        const noteH = this._notesInWindow().length ? m.noteStripH : 0;
        const plot = { x1: m.sidePad, x2: W - m.sidePad, y1: m.topPad + noteH, y2: H - m.timeAxisH };
        const vis = this.panes.map(p => this._paneVisible(p));
        const slots = splitPanes(plot.y1, plot.y2, m.paneGap, this.panes.map(p => p.weight),
                                 this.panes.map(p => p.minHeight), vis);
        const win = this.win;
        const xsBySrc = new Map();
        if (win && this.data) {
            const pw = plot.x2 - plot.x1, span = Math.max(1, win.end - win.start);
            for (const [id, d] of this.data.sources) {
                xsBySrc.set(id, d.t.map(t => plot.x1 + Math.floor((t - win.start) * pw / span)));
            }
        }
        const axes = this.panes.map((p, i) => {
            let lo = Infinity, hi = -Infinity;
            if (win && this.data) {
                for (const l of p.layers) {
                    if (!l.drivesRange || !l.raw || !this._layerVisible(l)) continue;
                    const t = this.data.sources.get(l.source.id).t;
                    for (let k = 0; k < t.length; k++) {
                        const v = l.raw[k];
                        if (v === null || t[k] < win.start || t[k] > win.end) continue;
                        if (v < lo) lo = v;
                        if (v > hi) hi = v;
                    }
                }
            }
            const sh = slots[i].y2 - slots[i].y1;
            const ticks = ticksForHeight(sh, p.maxTicks, m.tickMinPx);
            return lo <= hi ? autoRange(p.range, lo, hi, ticks) : autoRange(p.range, 1, 0, ticks);
        });
        this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        this.clip.setAttribute('x', plot.x1);
        this.clip.setAttribute('y', 0);
        this.clip.setAttribute('width', Math.max(0, plot.x2 - plot.x1));
        this.clip.setAttribute('height', H);
        this.geom = { W, H, plot, vis, slots, axes, xsBySrc };
    }

    _drawStatic() {
        const st = this.stat;
        st.textContent = '';
        const g = this.geom;
        if (!g || !this.win) return;
        const { plot, slots, axes } = g;
        const { start, end } = this.win;
        const xOf = t => mapX(t, start, end, plot.x1, plot.x2);
        const ph = plot.y2 - plot.y1;

        // 1. spans
        this.spans.forEach((set, setId) => {
            if (!set) return;
            const sg = s('g', { class: 'tschart-spans', 'data-set': setId }, st);
            for (const sp of set) {
                const e = sp.end || end;
                if (e < start || sp.start > end) continue;
                let x1 = xOf(sp.start), x2 = xOf(e);
                if (x2 - x1 < (sp.minWidth || 0)) x2 = x1 + sp.minWidth;
                const w = Math.max(1, x2 - x1);
                if (sp.style === 'hatch') {
                    s('rect', { x: x1, y: plot.y1, width: w, height: ph, fill: sp.color,
                                'fill-opacity': 0.1, class: 'tschart-span hatch' }, sg);
                    if (w >= 8) {
                        s('rect', { x: x1, y: plot.y1, width: w, height: ph,
                                    fill: `url(#${this._hatch(sp.color)})` }, sg);
                    }
                    if (sp.start >= start) {
                        s('line', { x1, x2: x1, y1: plot.y1, y2: plot.y2, stroke: sp.color,
                                    'stroke-width': 2, 'stroke-opacity': 0.7,
                                    class: 'tschart-span-start' }, sg);
                    }
                } else {
                    s('rect', { x: x1, y: plot.y1, width: w, height: ph, fill: sp.color,
                                'fill-opacity': sp.opacity === undefined ? 0.2 : sp.opacity,
                                class: 'tschart-span' }, sg);
                }
            }
        });

        // 2. pane grid
        this.panes.forEach((p, i) => {
            if (!g.vis[i]) return;
            const a = axes[i], sl = slots[i];
            for (let v = a.lo; v <= a.hi; v += a.step) {
                const y = mapY(v, a.lo, a.hi, sl.y1, sl.y2) + 0.5;
                s('line', { x1: plot.x1, x2: plot.x2, y1: y, y2: y, class: 'tschart-grid' }, st);
            }
        });

        // 3. time axis
        const step = timeTickStep(end - start, Math.max(1, Math.floor((plot.x2 - plot.x1) / 110)));
        const fmt = this.o.timeFormat || defaultTimeFormat;
        for (let t = firstTick(start, step, localSinceMidnight(start)); t <= end; t += step) {
            const x = xOf(t) + 0.5;
            s('line', { x1: x, x2: x, y1: plot.y1, y2: plot.y2, class: 'tschart-grid' }, st);
            const anchor = x - plot.x1 < 20 ? 'start' : (plot.x2 - x < 20 ? 'end' : 'middle');
            s('text', { x, y: plot.y2 + 15, 'text-anchor': anchor, class: 'tschart-time' }, st)
                .textContent = fmt(t, step);
        }

        // 4. series
        for (const l of this.layers) {
            const pi = l.pane.index;
            if (!g.vis[pi] || !l.vals || !this._layerVisible(l)) continue;
            const d = this.data.sources.get(l.source.id);
            const xs = g.xsBySrc.get(l.source.id);
            const a = axes[pi], sl = slots[pi];
            const pts = decimate(xs, d.t, l.vals, d.gap);
            if (!pts.length) continue;
            const Y = v => mapY(v, a.lo, a.hi, sl.y1, sl.y2);
            const base = Y(clamp(0, a.lo, a.hi));
            let line = '', area = '', lastX = 0;
            for (let k = 0; k < pts.length; k++) {
                const p = pts[k], y = Y(p.v);
                if (p.brk) {
                    if (area) area += `H${lastX}V${base}Z`;
                    line += `M${p.x},${y}`;
                    area += `M${p.x},${base}V${y}`;
                } else if (l.geom === 'step') {
                    line += `H${p.x}V${y}`;
                    area += `H${p.x}V${y}`;
                } else {
                    line += `L${p.x},${y}`;
                    area += `L${p.x},${y}`;
                }
                lastX = p.x;
            }
            if (area) area += `H${lastX}V${base}Z`;
            const lg = s('g', { class: 'tschart-layer', 'data-layer': l.id }, st);
            if (l.fill) {
                s('path', { d: area, fill: l.color, 'fill-opacity': l.fillOpacity, stroke: 'none',
                            class: 'tschart-fill' }, lg);
            }
            s('path', { d: line, fill: 'none', stroke: l.color, 'stroke-width': l.width,
                        'stroke-linejoin': 'round', 'stroke-dasharray': l.dash || undefined,
                        class: 'tschart-line' }, lg);
        }

        // 5. notes
        const notes = this._notesInWindow();
        if (notes.length) {
            const xs = notes.map(n => xOf(n.time));
            const { group } = groupNotes(xs, this.m.noteLabelW);
            const top = this.m.topPad;
            for (let i = 0; i < notes.length; i++) {
                if (group[i] !== i) continue;
                let j = i;
                while (j + 1 < notes.length && group[j + 1] === i) j++;
                const same = notes.slice(i, j + 1).every(n => n.text === notes[i].text);
                const label = this.notePrefix + (same ? notes[i].text : '×' + (j - i + 1));
                const x = xs[i] + 0.5;
                const ng = s('g', { class: 'tschart-note', 'data-time': notes[i].time }, st);
                s('line', { x1: x, x2: x, y1: top + 4, y2: plot.y1, stroke: notes[i].color,
                            'stroke-width': 2 }, ng);
                const tx = Math.min(x + 4, plot.x2 - measure(label) - 2);
                const te = s('text', { x: tx, y: top + this.m.noteStripH / 2 + 4,
                                       class: 'tschart-note-label' }, ng);
                te.style.fill = notes[i].color;
                te.textContent = label;
            }
        }
        this._applyShift();
    }

    _applyShift() {
        this.stat.setAttribute('transform', this.dx ? `translate(${this.dx},0)` : '');
    }

    // ---- overlay: pills, gutter, end tags, edge zones, cursor, status ----

    _drawOverlay() {
        const dyn = this.dyn, ov = this.ov;
        dyn.textContent = '';
        ov.textContent = '';
        const g = this.geom;
        this.root.classList.toggle('panning', !!(this.gesture && this.gesture.pan));
        if (!g) return;
        const { plot, slots, axes, W } = g;
        const m = this.m;
        const shifted = this.dx !== 0 || !!this.pending;

        if (this.win && this.dx) this._drawEdges();

        // gutter
        if (this.axisOpen) {
            const gx = plot.x1 + m.gutterW;
            s('rect', { x: plot.x1, y: plot.y1, width: m.gutterW, height: plot.y2 - plot.y1,
                        class: 'tschart-gutter' }, dyn);
            this.panes.forEach((p, i) => {
                if (!g.vis[i]) return;
                const a = axes[i], sl = slots[i];
                s('line', { x1: gx, x2: gx, y1: sl.y1, y2: sl.y2, stroke: p.color,
                            'stroke-width': 2 }, dyn);
                for (let v = a.lo; v <= a.hi; v += a.step) {
                    const y = mapY(v, a.lo, a.hi, sl.y1, sl.y2);
                    s('line', { x1: gx - 4, x2: gx, y1: y + 0.5, y2: y + 0.5, stroke: p.color }, dyn);
                    const te = s('text', { x: gx - 6, y: clamp(y + 4, sl.y1 + 10, sl.y2 - 1),
                                           'text-anchor': 'end', class: 'tschart-axis' }, dyn);
                    te.style.fill = p.color;
                    te.textContent = p.fmt(v, 'axis');
                }
            });
        }

        // pills
        this.panes.forEach((p, i) => {
            if (!g.vis[i] || !p.unit) return;
            const b = h('button', 'tschart-pill', `${p.unit} ${this.axisOpen ? '◂' : '▸'}`);
            b.type = 'button';
            b.dataset.tschartPill = p.id;
            b.style.color = p.color;
            b.style.left = (plot.x1 + 4 + (this.axisOpen ? m.gutterW : 0)) + 'px';
            b.style.top = (slots[i].y1 + 4) + 'px';
            b.addEventListener('pointerdown', e => e.stopPropagation());
            b.addEventListener('click', () => {
                this.setAxisOpen(!this.axisOpen);
                this._emit('axis-toggled', { on: this.axisOpen });
            });
            ov.appendChild(b);
        });

        // end tags
        if (this.endTags && !this.cursor && !shifted && this.win && this.data) {
            this.panes.forEach((p, i) => {
                if (!g.vis[i]) return;
                const a = axes[i], sl = slots[i];
                const items = [];
                for (const l of p.layers) {
                    if (l.tag === null || l.tag === undefined || !l.raw || !this._layerVisible(l)) continue;
                    const t = this.data.sources.get(l.source.id).t;
                    let k = t.length - 1;
                    while (k >= 0 && (t[k] > this.win.end || l.raw[k] === null)) k--;
                    if (k < 0 || t[k] < this.win.start) continue;
                    const v = l.raw[k];
                    items.push({ l, v, y0: mapY(v, a.lo, a.hi, sl.y1, sl.y2) });
                }
                if (!items.length) return;
                const ys = items.map(it => it.y0);
                placeTags(ys, m.tagH, 2, sl.y1, sl.y2);
                items.forEach((it, k) => {
                    const y = ys[k];
                    const tag = h('div', 'tschart-tag',
                                  it.l.tag + (it.l.tag ? ' ' : '') + p.fmt(it.v, 'tag'));
                    tag.dataset.tschartTag = it.l.id;
                    tag.style.color = it.l.color;
                    tag.style.borderColor = it.l.color;
                    tag.style.right = (W - plot.x2 + 6) + 'px';
                    tag.style.top = y + 'px';
                    ov.appendChild(tag);
                    if (Math.abs(y - it.y0) > 4) {
                        s('line', { x1: plot.x2 - 3, x2: plot.x2 - 3, y1: it.y0, y2: y,
                                    stroke: it.l.color, 'stroke-width': 1.5 }, dyn);
                    }
                });
            });
        }

        // cursor
        if (this.cursor && !shifted) this._drawCursor();

        // status / spinner
        const pw = plot.x2 - plot.x1, cy = (plot.y1 + plot.y2) / 2;
        if (this.pending || this.status.st === 'loading') {
            let pm = 500;
            if (this.pending && this.win) {
                pm = uncoveredPermille(this.win.start, this.win.end, this.pending.start, this.pending.end);
            }
            const sp = h('div', 'tschart-spin');
            sp.style.left = (plot.x1 + pw * pm / 1000) + 'px';
            sp.style.top = cy + 'px';
            ov.appendChild(sp);
        }
        if (this.status.st !== 'ok' && this.status.text && !this.pending) {
            const st = h('div', 'tschart-status ' + this.status.st, this.status.text);
            st.dataset.tschartStatus = this.status.st;
            st.style.left = (plot.x1 + pw / 2) + 'px';
            st.style.top = (cy + (this.status.st === 'loading' ? 26 : 0)) + 'px';
            ov.appendChild(st);
        }
    }

    _drawEdges() {
        const { plot } = this.geom;
        const { start, end } = this.win;
        const pw = plot.x2 - plot.x1, span = Math.max(1, end - start);
        const X = t => plot.x1 + (t - start) * pw / span + this.dx;
        const et = this.o.edgeText || {};
        const zone = (x1, x2, bx, label, kind) => {
            if (x2 - x1 < 1) return;
            s('rect', { x: x1, y: plot.y1, width: x2 - x1, height: plot.y2 - plot.y1,
                        fill: `url(#${this._hatch('#8a8a9a')})`, class: 'tschart-edge-zone' }, this.dyn);
            s('line', { x1: bx, x2: bx, y1: plot.y1, y2: plot.y2, class: 'tschart-edge-line' }, this.dyn);
            if (label && x2 - x1 > 40) {
                const e = h('div', 'tschart-edge', label);
                e.dataset.tschartEdge = kind;
                e.style.left = ((x1 + x2) / 2) + 'px';
                e.style.top = ((plot.y1 + plot.y2) / 2) + 'px';
                this.ov.appendChild(e);
            }
        };
        const xe = X(this.earliest);
        if (this.earliest && xe > plot.x1) zone(plot.x1, Math.min(xe, plot.x2), xe, et.before, 'before');
        const xl = X(this.latest);
        if (this.latest && xl < plot.x2) zone(Math.max(xl, plot.x1), plot.x2, xl, et.after, 'after');
    }

    _cursorAt(px) {
        const g = this.geom;
        if (!g || !this.data || !this.win || this.pending) return null;
        const src = this.sources[0];
        const d = src && this.data.sources.get(src.id);
        if (!d) return null;
        const xs = g.xsBySrc.get(src.id);
        const cur = this.layers.filter(l => l.inCursor && l.raw && this._layerVisible(l) &&
                                            g.vis[l.pane.index]);
        const ok = d.t.map((t, k) => t >= this.win.start && t <= this.win.end &&
                                     cur.some(l => this._valueAt(l, d, k) !== null));
        const k = nearestX(xs, ok, px, this.m.cursorSnapPx);
        return k < 0 ? null : { index: k, time: d.t[k], x: xs[k] };
    }

    // Index into l's own source for default-source sample k, or -1.
    _indexFor(l, d, k) {
        if (l.source === this.sources[0]) return k;
        const ld = this.data.sources.get(l.source.id);
        return ld ? nearestTime(ld.t, d.t[k], ld.gap === Infinity ? 0 : ld.gap) : -1;
    }

    _valueAt(l, d, k, interp) {
        const i = this._indexFor(l, d, k);
        if (i < 0) return null;
        const v = (interp ? l.vals : l.raw)[i];
        return v === undefined ? null : v;
    }

    _setCursor(c) {
        const same = (c && this.cursor && c.index === this.cursor.index) || (!c && !this.cursor);
        this.cursor = c;
        if (same) return;
        this._overlay();
        this._emit('cursor', c ? { time: c.time, index: c.index } : null);
    }

    _clearCursor() {
        if (!this.cursor) return;
        this.cursor = null;
        if (this.root) this._emit('cursor', null);
    }

    _drawCursor() {
        const g = this.geom, c = this.cursor;
        const { plot, slots, axes } = g;
        const src = this.sources[0];
        const d = this.data.sources.get(src.id);
        s('line', { x1: c.x + 0.5, x2: c.x + 0.5, y1: plot.y1, y2: plot.y2,
                    class: 'tschart-cursor' }, this.dyn);
        const layerRows = [];
        for (const l of this.layers) {
            if (!l.inCursor || !l.raw || !this._layerVisible(l) || !g.vis[l.pane.index]) continue;
            const raw = this._valueAt(l, d, c.index);
            if (raw === null) continue;
            const a = axes[l.pane.index], sl = slots[l.pane.index];
            const y = mapY(this._valueAt(l, d, c.index, true), a.lo, a.hi, sl.y1, sl.y2);
            s('circle', { cx: c.x + 0.5, cy: y, r: 5, fill: l.color, class: 'tschart-dot' }, this.dyn);
            layerRows.push({ kind: 'value', label: l.name || l.id, value: l.pane.fmt(raw, 'cursor'),
                             color: l.color });
        }
        let rows = [], layersAt = -1;
        const card = {
            add: (kind, label, value, color) => rows.push({ kind, label, value, color }),
            addLayers: () => { layersAt = rows.length; },
        };
        if (this.cardCb) {
            this.cardCb({ time: c.time, index: c.index, source: src, sample: d.samples[c.index] }, card);
        }
        if (layersAt < 0) layersAt = rows.length;
        rows.splice(layersAt, 0, ...layerRows);
        if (rows.length > this.m.cardMaxRows) {
            rows = rows.slice(0, this.m.cardMaxRows - 1);
            rows.push({ kind: 'text', label: '…' });
        }
        const el = h('div', 'tschart-card');
        el.dataset.tschartCard = '';
        for (const r of rows) {
            const row = h('div', 'tschart-row ' + r.kind);
            if ((r.kind === 'value' || r.kind === 'block') && r.color) {
                const sw = h('span', 'sw');
                sw.style.background = r.color;
                row.appendChild(sw);
            }
            const lab = h('span', 'l', r.label || '');
            if (r.kind === 'block' && r.color) lab.style.color = r.color;
            row.appendChild(lab);
            if (r.value !== undefined && r.value !== null && r.value !== '') {
                row.appendChild(h('span', 'v', r.value));
            }
            el.appendChild(row);
        }
        el.style.maxWidth = Math.round((plot.x2 - plot.x1) * 0.6) + 'px';
        el.style.top = (plot.y1 + 4) + 'px';
        el.style.left = '0px';
        el.style.visibility = 'hidden';
        this.ov.appendChild(el);
        const w = el.offsetWidth;
        let x = c.x + 16;
        if (x + w > plot.x2) x = c.x - 16 - w;
        el.style.left = Math.max(plot.x1, x) + 'px';
        el.style.visibility = '';
    }

    // ---- input ----

    _bindInput() {
        const b = this.body;
        this.lastTap = 0;
        this.lastPanEnd = 0;
        const local = e => {
            const r = b.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        };
        const inPlot = p => this.geom && p.y >= this.geom.plot.y1 && p.y <= this.geom.plot.y2 &&
                            p.x >= this.geom.plot.x1 && p.x <= this.geom.plot.x2;

        b.addEventListener('pointerdown', e => {
            if (e.button > 0 || !this.win) return;
            const p = local(e);
            if (!inPlot(p)) return;
            this.gesture = { id: e.pointerId, type: e.pointerType, x0: p.x, y0: p.y,
                             base: this.dx, pan: false, long: false };
            if (e.pointerType !== 'mouse') {
                this.gesture.timer = setTimeout(() => {
                    const gs = this.gesture;
                    if (!gs || gs.pan) return;
                    gs.long = true;
                    this._setCursor(this._cursorAt(gs.x0));
                }, this.m.longPressMs);
            }
        });

        b.addEventListener('pointermove', e => {
            const p = local(e);
            const gs = this.gesture;
            if (!gs) {
                if (e.pointerType === 'mouse' && !this.spring) {
                    this._setCursor(inPlot(p) ? this._cursorAt(p.x) : null);
                }
                return;
            }
            if (e.pointerId !== gs.id) return;
            const dx = p.x - gs.x0, dy = p.y - gs.y0;
            if (gs.long) {
                this._setCursor(this._cursorAt(p.x));
                return;
            }
            if (!gs.pan) {
                if (Math.abs(dx) > this.m.panStartPx && Math.abs(dx) > Math.abs(dy)) {
                    gs.pan = true;
                    clearTimeout(gs.timer);
                    try { b.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                    cancelAnimationFrame(this.springRaf);
                    this.spring = false;
                    gs.base = this.dx;
                    this._clearCursor();
                } else if (Math.abs(dy) > this.m.panStartPx) {
                    clearTimeout(gs.timer);
                    this.gesture = null;
                    return;
                } else {
                    return;
                }
            }
            const { plot } = this.geom;
            const lim = panLimits(this.win.start, this.win.end, this.earliest, this.latest,
                                  plot.x2 - plot.x1);
            this.dx = rubberBand(Math.round(gs.base + dx), lim);
            this._applyShift();
            this._overlay();
        });

        const end = (e, cancelled) => {
            const gs = this.gesture;
            if (!gs || e.pointerId !== gs.id) return;
            clearTimeout(gs.timer);
            this.gesture = null;
            const p = local(e);
            const now = Date.now();
            if (gs.pan) {
                this.lastPanEnd = now;
                const { plot } = this.geom;
                const pw = plot.x2 - plot.x1, w = this.win.end - this.win.start;
                const snap = typeof this.o.panSnap === 'function' ? this.o.panSnap(w) : (this.o.panSnap || 0);
                const target = cancelled ? null :
                    panTarget(this.dx, this.win.start, this.win.end, this.earliest, this.latest, pw, snap);
                const from = this.dx;
                if (target !== null) {
                    this.requestWindow(target - w, target);
                    const to = this.dx;
                    this.dx = from;
                    this._springTo(to);
                } else {
                    this._springTo(this.pending ? this._shiftFor(this.pending) : 0);
                }
            } else if (!gs.long && !cancelled) {
                if (now - this.lastTap < this.m.doubleTapMs && Math.abs(p.x - this.lastTapX) < 30 &&
                    now - this.lastPanEnd > this.m.doubleTapAfterPanMs) {
                    this.lastTap = 0;
                    this._emit('double-tap', { time: this.timeAtX(p.x) });
                } else {
                    this.lastTap = now;
                    this.lastTapX = p.x;
                    if (gs.type !== 'mouse') this._setCursor(this._cursorAt(p.x));
                }
            }
            this._overlay();
            if (this.deferred && !this.spring) this._apply(this.deferred);
        };
        b.addEventListener('pointerup', e => end(e, false));
        b.addEventListener('pointercancel', e => end(e, true));
        b.addEventListener('pointerleave', e => {
            if (e.pointerType === 'mouse' && !this.gesture) this._setCursor(null);
        });
    }

    _shiftFor(win) {
        if (!this.win || !this.geom || win.end - win.start !== this.win.end - this.win.start) return 0;
        const pw = this.geom.plot.x2 - this.geom.plot.x1;
        return Math.round((this.win.start - win.start) * pw / (win.end - win.start));
    }

    _springTo(target) {
        cancelAnimationFrame(this.springRaf);
        const from = this.dx;
        if (from === target || typeof requestAnimationFrame === 'undefined') {
            this.dx = target;
            this.spring = false;
            this._applyShift();
            this._overlay();
            if (this.deferred) this._apply(this.deferred);
            return;
        }
        this.spring = true;
        const t0 = performance.now(), ms = this.m.springMs;
        const step = now => {
            const k = Math.min(1, (now - t0) / ms);
            const e = 1 - Math.pow(1 - k, 3);
            this.dx = Math.round(from + (target - from) * e);
            this._applyShift();
            this._overlay();
            if (k < 1) {
                this.springRaf = requestAnimationFrame(step);
            } else {
                this.spring = false;
                if (this.deferred && !this.gesture) this._apply(this.deferred);
            }
        };
        this.springRaf = requestAnimationFrame(step);
    }
}

let measureCtx = null;
function measure(text) {
    if (typeof document === 'undefined') return text.length * 6;
    if (!measureCtx) {
        measureCtx = document.createElement('canvas').getContext('2d');
        measureCtx.font = '11px system-ui, sans-serif';
    }
    return measureCtx.measureText(text).width;
}

TsChart.METRICS = METRICS;

TsChart.logic = logic;
return TsChart;
});
