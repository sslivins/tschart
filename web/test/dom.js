// jsdom harness for the widget tests: loads tschart.js into a fresh window
// with a fixed layout size, no animation frames (springs jump straight to
// their end) and synchronous rendering via flush().
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'tschart.js'), 'utf8');

function setup({ width = 600, height = 300, colorMix } = {}) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="c"></div></body></html>',
                          { url: 'http://localhost/', runScripts: 'outside-only' });
    const w = dom.window;
    const size = { width, height };
    const def = (name, get) => Object.defineProperty(w.HTMLElement.prototype, name,
                                                     { configurable: true, get });
    def('clientWidth', () => size.width);
    def('clientHeight', () => size.height);
    def('offsetWidth', () => 120);
    w.cancelAnimationFrame = () => {};
    // Text measuring: 7 px per character.
    w.HTMLCanvasElement.prototype.getContext = () => ({
        font: '', measureText: t => ({ width: String(t).length * 7 }),
    });
    if (colorMix !== undefined) w.CSS = { supports: () => colorMix };
    w.eval(SRC);
    const root = w.document.getElementById('c');
    return { window: w, document: w.document, root, size, TsChart: w.TsChart, TsBars: w.TsBars };
}

// Pointer events in body-local coordinates (the body's rect is at 0,0).
function pointer(env, el, type, x, y, { id = 1, pointerType = 'mouse' } = {}) {
    const w = env.window;
    const Ctor = w.PointerEvent || w.MouseEvent;
    const e = new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0,
                               pointerId: id, pointerType, isPrimary: true });
    for (const [k, v] of Object.entries({ pointerId: id, pointerType, isPrimary: true })) {
        if (e[k] !== v) Object.defineProperty(e, k, { value: v });
    }
    el.dispatchEvent(e);
}

function drag(env, el, x0, y, x1, opts) {
    pointer(env, el, 'pointerdown', x0, y, opts);
    const steps = 6;
    for (let i = 1; i <= steps; i++) pointer(env, el, 'pointermove', x0 + (x1 - x0) * i / steps, y, opts);
    pointer(env, el, 'pointerup', x1, y, opts);
}

const $$ = (root, sel) => [...root.querySelectorAll(sel)];
const num = (el, attr) => parseFloat(el.getAttribute(attr));

module.exports = { setup, pointer, drag, $$, num };
