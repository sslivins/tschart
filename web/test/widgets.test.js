// Widget tests for the web TsChart and TsBars: build charts in jsdom, render
// with flush() and check the SVG/DOM they produce and the events they emit.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, pointer, drag, $$, num } = require('./dom.js');

const END = 1_800_000_000;
const START = END - 4 * 3600;

// A fixed 4-hour tank chart like the Home screen's.
function homeChart(opts = {}, envOpts = {}) {
    const env = setup(envOpts);
    const c = new env.TsChart(env.root, Object.assign({ id: 't', relativeTime: 'now', axis: 'outside' }, opts));
    c.addSource('s');
    const pane = c.addPane({ id: 'temp', maxTicks: 5,
        fmt: (v, ctx) => ctx === 'axis' ? `${v / 10}°` : `${(v / 10).toFixed(1)} °C` });
    c.addLayer(pane, { id: 'tank', name: 'Tank', tag: 'tank', value: s => s.v, color: '#fff' });
    c.addKey('heat', 'Heating', '#f80', { fillStrength: 0.3 });
    c.addKey('fault', 'Fault', '#f00', 'hatch');
    c.setPaneRange('temp', 200, 600, 100);
    return { env, c, pane };
}

function samples(step = 300, from = START, to = END) {
    const out = [];
    for (let t = from; t <= to; t += step) out.push({ t, v: 400 + ((t / step) % 10) * 10 });
    return out;
}

function load(c, { data = samples(), gap = 900, applied } = {}) {
    c.setDataset({ start: START, end: END, sources: { s: { samples: data, time: 't', gap } }, applied });
    c.flush();
}

const texts = els => els.map(e => e.textContent);

// ------------------------------------------------------------- TsChart ----

test('outside axis shows the fixed pane range bottom to top', () => {
    const { env, c } = homeChart();
    load(c);
    const labels = $$(env.root, '.tschart-axis-out text');
    assert.deepEqual(texts(labels), ['20°', '30°', '40°', '50°', '60°']);
    const ys = labels.map(l => num(l, 'y'));
    assert.ok(ys.every((y, i) => i === 0 || y < ys[i - 1]), 'labels climb the plot');
    assert.equal($$(env.root, '.tschart-pill').length, 0, 'no axis pills when outside');
});

test('setPaneRange moves the scale', () => {
    const { env, c } = homeChart();
    load(c);
    c.setPaneRange('temp', 0, 400, 100);
    c.flush();
    assert.deepEqual(texts($$(env.root, '.tschart-axis-out text')), ['0°', '10°', '20°', '30°', '40°']);
});

// The test DOM measures text at 7 px per character.
test('the outside axis is only as wide as its labels', () => {
    const { env, c } = homeChart();
    load(c);
    const plotX = () => num(env.root.querySelector('.tschart-plotbg'), 'x');
    assert.equal(plotX(), 3 * 7 + 4, '"60°" plus gap and margin');
    c.setPaneRange('temp', 0, 12000, 3000);
    c.flush();
    assert.equal(plotX(), 5 * 7 + 4, '"1200°" widens it');
});

test('the open axis gutter fits its labels', () => {
    const env = setup();
    const c = new env.TsChart(env.root, { id: 'h', relativeTime: 'now' });
    c.addSource('s');
    const pane = c.addPane({ id: 'temp', unit: '°C', fmt: (v, ctx) => `${v / 10}°` });
    c.addLayer(pane, { id: 'tank', name: 'Tank', value: s => s.v, color: '#fff' });
    c.setPaneRange('temp', 200, 600, 100);
    load(c);
    c.setAxisOpen(true);
    c.flush();
    const gutter = env.root.querySelector('.tschart-gutter');
    assert.equal(num(gutter, 'width'), 3 * 7 + 6, '"60°" plus tick, gap and margin');
    const pill = env.root.querySelector('.tschart-pill');
    assert.equal(parseFloat(pill.style.left), num(gutter, 'x') + 4 + 3 * 7 + 6, 'pill sits past it');
});

test('relative time labels count back from the window end, oldest first', () => {
    const { env, c } = homeChart();
    load(c);
    const labels = $$(env.root, '.tschart-time');
    assert.deepEqual(texts(labels), ['4 h', '3 h', '2 h', '1 h', 'now']);
    assert.equal(labels[0].getAttribute('text-anchor'), 'start');
    assert.equal(labels.at(-1).getAttribute('text-anchor'), 'end');
    const plot = c.getPlotArea();
    assert.ok(Math.abs(num(labels.at(-1), 'x') - plot.x2) <= 1);
});

test('keyed spans take the key colour mixed into the plot background', () => {
    const { env, c } = homeChart({}, { colorMix: true });
    load(c, { applied: () => {
        c.setSpans(0, [{ start: START + 3600, end: START + 7200, key: 'heat' },
                       { start: START, end: START + 600, key: 'nope' }]);
    } });
    const spans = $$(env.root, '.tschart-span');
    assert.equal(spans.length, 1, 'a span with an unknown key is not drawn');
    const [heat] = spans;
    assert.equal(heat.getAttribute('data-key'), 'heat');
    assert.match(heat.style.fill, /color-mix\(in srgb, #f80 30%/);
    assert.equal(heat.getAttribute('fill-opacity'), '1');
    // 1 h of a 4 h window across the plot.
    const plot = c.getPlotArea();
    assert.ok(Math.abs(num(heat, 'width') - (plot.x2 - plot.x1) / 4) <= 1);
    // The legend swatch is the same mix.
    const sw = env.root.querySelector('[data-tschart-key="heat"] i');
    assert.match(sw.style.background, /color-mix\(in srgb, #f80 30%/);
});

test('without color-mix a keyed fill falls back to translucency', () => {
    const { env, c } = homeChart({}, { colorMix: false });
    load(c, { applied: () => c.setSpans(0, [{ start: START + 3600, end: START + 7200, key: 'heat' }]) });
    const [heat] = $$(env.root, '.tschart-span');
    assert.equal(heat.getAttribute('fill-opacity'), '0.3');
    assert.doesNotMatch(heat.getAttribute('style') || '', /color-mix/);
});

test('hatched and open-ended spans', () => {
    const { env, c } = homeChart();
    load(c, { applied: () => {
        c.setSpans(2, [{ start: END - 1800, end: null, key: 'fault' },
                       { start: START + 60, end: START + 61, key: 'fault', minWidth: 3 }]);
    } });
    const spans = $$(env.root, '.tschart-spans[data-set="2"] .tschart-span');
    assert.equal(spans.length, 2);
    assert.ok(spans.every(s => s.classList.contains('hatch') && s.getAttribute('data-key') === 'fault'));
    const plot = c.getPlotArea();
    const open = spans.find(s => num(s, 'x') > plot.x1 + 100);
    assert.ok(Math.abs(num(open, 'x') + num(open, 'width') - plot.x2) <= 1, 'open span runs to now');
    const tiny = spans.find(s => s !== open);
    assert.ok(num(tiny, 'width') >= 3, 'minWidth keeps a short span visible');
    assert.ok(env.root.querySelector('pattern'), 'hatch pattern defined');
});

test('notes get the prefix and nearby notes share a label', () => {
    const { env, c } = homeChart();
    load(c, { applied: () => {
        c.setNotes([{ time: END - 1800, text: 'P02', color: '#f00' },
                    { time: END - 1790, text: 'P02', color: '#f00' },
                    { time: START + 1800, text: 'E03', color: '#f00' }], '⚠ ');
    } });
    const labels = texts($$(env.root, '.tschart-note-label'));
    assert.equal(labels.length, 2);
    assert.ok(labels.includes('⚠ E03'));
    assert.ok(labels.some(l => l.startsWith('⚠ P02')));
});

test('reference line sits at its value with a label', () => {
    const { env, c } = homeChart();
    load(c, { applied: () => c.setRefLines([{ pane: 'temp', value: 400, label: '40°', color: '#9cf' }]) });
    const ref = env.root.querySelector('.tschart-ref[data-pane="temp"]');
    assert.ok(ref);
    assert.equal(ref.querySelector('.tschart-ref-label').textContent, '40°');
    // 400 is mid-scale (200..600), so the line is half way up the plot.
    const plot = c.getPlotArea();
    const line = ref.querySelector('line');
    assert.ok(Math.abs(num(line, 'y1') - (plot.y1 + plot.y2) / 2) <= 1);
    c.setRefLines([]);
    c.flush();
    assert.equal($$(env.root, '.tschart-ref').length, 0);
});

test('a data gap breaks the line', () => {
    const { env, c } = homeChart();
    const data = samples().filter(s => s.t < START + 3600 || s.t > START + 7200);
    load(c, { data });
    const d = env.root.querySelector('.tschart-layer[data-layer="tank"] path').getAttribute('d');
    assert.equal((d.match(/M/g) || []).length, 2);
});

test('mouse hover shows the card with host rows and layer values', () => {
    const { env, c } = homeChart();
    c.setCard((info, card) => {
        card.add('title', `t=${info.time - START}`);
        card.addLayers();
        card.add('block', 'Heating', '', '#f80');
    });
    load(c);
    const events = [];
    env.root.addEventListener('tschart:cursor', e => events.push(e.detail));
    const plot = c.getPlotArea();
    pointer(env, c.body, 'pointermove', (plot.x1 + plot.x2) / 2, plot.y1 + 20);
    c.flush();
    const card = env.root.querySelector('.tschart-card');
    assert.ok(card, 'card shown');
    const rows = $$(card, '.tschart-row').map(r => r.className.split(' ')[1]);
    assert.deepEqual(rows, ['title', 'value', 'block']);
    assert.equal(card.querySelector('.value .l').textContent, 'Tank');
    assert.match(card.querySelector('.value .v').textContent, /^\d+\.\d °C$/);
    assert.ok(Math.abs(events.at(-1).time - (START + END) / 2) <= 300);
    assert.ok(env.root.querySelector('.tschart-cursor'));

    pointer(env, c.body, 'pointerleave', 0, 0);
    c.flush();
    assert.equal(env.root.querySelector('.tschart-card'), null);
    assert.equal(events.at(-1), null);
});

test('with pan disabled a drag scrubs instead of requesting a window', () => {
    const { env, c } = homeChart({ input: { pan: false } });
    c.setBounds(START - 86400, END);
    load(c);
    const requests = [];
    env.root.addEventListener('tschart:window-request', e => requests.push(e.detail));
    const plot = c.getPlotArea();
    drag(env, c.body, plot.x1 + 100, plot.y1 + 20, plot.x1 + 300, { pointerType: 'touch' });
    c.flush();
    assert.equal(requests.length, 0);
    assert.deepEqual({ ...c.getWindow() }, { start: START, end: END });
    assert.ok(env.root.querySelector('.tschart-card'), 'scrub leaves the cursor card up');
});

test('a drag pans back in time when panning is on', () => {
    const { env, c } = homeChart({ relativeTime: undefined, timeFormat: () => '' });
    c.setBounds(START - 86400, END);
    load(c);
    const requests = [];
    env.root.addEventListener('tschart:window-request', e => requests.push(e.detail));
    const plot = c.getPlotArea();
    const hour = (plot.x2 - plot.x1) / 4;
    drag(env, c.body, plot.x1 + 50, plot.y1 + 20, plot.x1 + 50 + hour);
    assert.equal(requests.length, 1);
    const r = requests[0];
    assert.equal(r.end - r.start, END - START, 'window length kept');
    assert.ok(Math.abs(r.end - (END - 3600)) <= 300, `about an hour back, got ${END - r.end}s`);

    // A dataset for an older request is stale.
    assert.equal(c.setDataset({ requestId: r.requestId + 1, start: r.start, end: r.end, sources: {} }), false);
});

test('on touch a drag scrubs even when panning is on', () => {
    const { env, c } = homeChart({ relativeTime: undefined, timeFormat: () => '' });
    c.setBounds(START - 86400, END);
    load(c);
    const requests = [];
    env.root.addEventListener('tschart:window-request', e => requests.push(e.detail));
    const plot = c.getPlotArea();
    drag(env, c.body, plot.x1 + 50, plot.y1 + 20, plot.x1 + 250, { pointerType: 'touch' });
    c.flush();
    assert.equal(requests.length, 0);
    assert.deepEqual({ ...c.getWindow() }, { start: START, end: END });
    assert.ok(env.root.querySelector('.tschart-card'), 'scrub leaves the cursor card up');
});

// Captures the widgets' timers so a test can say when a touch has been held.
function holdClock(env) {
    let pending = [];
    env.window.setTimeout = fn => pending.push(fn);
    env.window.clearTimeout = id => { pending[id - 1] = null; };
    return () => { const due = pending; pending = []; due.forEach(fn => fn && fn()); };
}

test('a touch puts the cursor down where it lands', () => {
    const { env, c } = homeChart();
    load(c);
    holdClock(env);
    const plot = c.getPlotArea();
    pointer(env, c.body, 'pointerdown', plot.x1 + 80, plot.y1 + 20, { pointerType: 'touch' });
    c.flush();
    assert.ok(env.root.querySelector('.tschart-card'), 'cursor up before any move');
});

test('on touch a hold then a drag pans back in time', () => {
    const { env, c } = homeChart({ relativeTime: undefined, timeFormat: () => '' });
    c.setBounds(START - 86400, END);
    load(c);
    const held = holdClock(env);
    const requests = [];
    env.root.addEventListener('tschart:window-request', e => requests.push(e.detail));
    const plot = c.getPlotArea(), hour = (plot.x2 - plot.x1) / 4, y = plot.y1 + 20;
    const touch = { pointerType: 'touch' };
    pointer(env, c.body, 'pointerdown', plot.x1 + 50, y, touch);
    pointer(env, c.body, 'pointermove', plot.x1 + 53, y, touch);  // a little jitter
    held();
    c.flush();
    assert.ok(env.root.classList.contains('holding'), 'the plot tints');
    assert.equal(env.root.querySelector('.tschart-card'), null, 'the cursor makes way');
    for (let i = 1; i <= 6; i++) pointer(env, c.body, 'pointermove', plot.x1 + 53 + hour * i / 6, y, touch);
    pointer(env, c.body, 'pointerup', plot.x1 + 53 + hour, y, touch);
    c.flush();
    assert.equal(requests.length, 1);
    assert.ok(Math.abs(requests[0].end - (END - 3600)) <= 300, `about an hour back, got ${END - requests[0].end}s`);
    assert.ok(!env.root.classList.contains('holding'));
});

test('a held touch that never moves keeps its cursor', () => {
    const { env, c } = homeChart();
    c.setBounds(START - 86400, END);
    load(c);
    const held = holdClock(env);
    const requests = [];
    env.root.addEventListener('tschart:window-request', e => requests.push(e.detail));
    const plot = c.getPlotArea();
    pointer(env, c.body, 'pointerdown', plot.x1 + 80, plot.y1 + 20, { pointerType: 'touch' });
    held();
    pointer(env, c.body, 'pointerup', plot.x1 + 80, plot.y1 + 20, { pointerType: 'touch' });
    c.flush();
    assert.equal(requests.length, 0);
    assert.ok(env.root.querySelector('.tschart-card'), 'cursor back up');
    assert.ok(!env.root.classList.contains('holding'));
});

test('utcOffset aligns time ticks to that zone', () => {
    const at = [];
    const opts = { relativeTime: undefined, timeFormat: (t, step) => { at.push([t, step]); return ''; } };
    const { c } = homeChart(Object.assign({ utcOffset: () => -7 * 3600 + 1800 }, opts));
    load(c);
    assert.ok(at.length > 1);
    for (const [t, step] of at) assert.equal((t - 7 * 3600 + 1800) % step, 0, `tick ${t} on a ${step}s step`);
});

test('with the cursor off, hover shows nothing', () => {
    const { env, c } = homeChart({ input: { cursor: false } });
    load(c);
    const plot = c.getPlotArea();
    pointer(env, c.body, 'pointermove', (plot.x1 + plot.x2) / 2, plot.y1 + 20);
    c.flush();
    assert.equal(env.root.querySelector('.tschart-card'), null);
});

test('end tags follow setEndTags', () => {
    const { env, c } = homeChart();
    load(c);
    c.setEndTags(true);
    c.flush();
    assert.ok($$(env.root, '.tschart-tag').length > 0);
    c.setEndTags(false);
    c.flush();
    assert.equal($$(env.root, '.tschart-tag').length, 0);
});

test('a group chip hides its pane and reports the toggle', () => {
    const env = setup();
    const c = new env.TsChart(env.root, { id: 'g', relativeTime: 'now' });
    c.addSource('s');
    const a = c.addPane({ id: 'a' }), b = c.addPane({ id: 'b' });
    c.addLayer(a, { id: 'la', value: s => s.v, color: '#f00' });
    c.addLayer(b, { id: 'lb', value: s => s.v, color: '#0f0' });
    c.addGroup({ id: 'ga', label: 'A', color: '#f00', panes: [a] });
    c.addGroup({ id: 'gb', label: 'B', color: '#0f0', panes: [b] });
    load(c);
    assert.ok(env.root.querySelector('[data-layer="lb"]'));
    const toggles = [];
    env.root.addEventListener('tschart:group-toggled', e => toggles.push(e.detail));
    const chip = $$(env.root, '.tschart-chip').find(x => x.textContent.includes('B'));
    chip.click();
    c.flush();
    assert.deepEqual(toggles.map(t => ({ ...t })), [{ id: 'gb', visible: false }]);
    assert.equal(c.getGroupVisible('gb'), false);
    assert.equal(env.root.querySelector('[data-layer="lb"]'), null);
    assert.ok(env.root.querySelector('[data-layer="la"]'));
});

test('status text replaces the plot message', () => {
    const { env, c } = homeChart();
    load(c, { data: [] });
    c.setStatus('empty', 'No tank readings');
    c.flush();
    assert.equal(env.root.querySelector('.tschart-status').textContent, 'No tank readings');
    c.setStatus('ok');
    c.flush();
    assert.equal(env.root.querySelector('.tschart-status'), null);
});

// -------------------------------------------------------------- TsBars ----

// Six days, four in view; day 3 has no data, day 5 is today (provisional).
function energy(opts = {}) {
    const env = setup();
    const b = new env.TsBars(env.root, Object.assign({ id: 'e', count: 4, labels: { text: x => x.label } }, opts));
    const kwh = b.addPane({ id: 'kwh', weight: 3, unit: 'kWh', range: { minStep: 1000 },
                            fmt: v => String(v / 1000), emptyText: 'No energy' });
    b.addSeries(kwh, { id: 'h', name: 'Heat', color: '#f80', stack: 'e', value: x => x.d && x.d.h });
    b.addSeries(kwh, { id: 'w', name: 'Water', color: '#fb0', stack: 'e', value: x => x.d && x.d.w });
    const cop = b.addPane({ id: 'cop', weight: 1, unit: 'COP', fmt: v => (v / 100).toFixed(1),
                            emptyText: 'No COP' });
    b.addSeries(cop, { id: 'cop', name: 'COP', color: '#4d8', geom: 'line', pointRadius: 3,
                       value: x => x.d && x.d.c });
    const buckets = [];
    for (let i = 0; i < 6; i++) {
        buckets.push({ key: `d${i}`, label: String(i), accent: i === 5, provisional: i === 5,
                       selectable: i !== 3,
                       d: i === 3 ? null : { h: 1000 * (i + 1), w: 500, c: 250 + i * 10 } });
    }
    b.setBuckets(buckets);
    b.flush();
    return { env, b, buckets };
}

const bars = (env, key) => $$(env.root, `.tsbars-bar[data-key="${key}"]`);

test('bars stack in series order and scale with their value', () => {
    const { env } = energy();
    const [h4, w4] = bars(env, 'd4');
    assert.equal(h4.getAttribute('data-series'), 'h');
    assert.equal(w4.getAttribute('data-series'), 'w');
    assert.ok(Math.abs(num(w4, 'y') + num(w4, 'height') - num(h4, 'y')) <= 1, 'water sits on heat');
    // d4 heat is 5 kWh, d2 heat is 3 kWh.
    const [h2] = bars(env, 'd2');
    assert.ok(Math.abs(num(h4, 'height') / num(h2, 'height') - 5 / 3) < 0.05);
    assert.equal(bars(env, 'd3').length, 0, 'no bars for a day without data');
});

test('today is striped and its label accented', () => {
    const { env } = energy();
    for (const r of bars(env, 'd5')) {
        assert.ok(r.classList.contains('provisional'));
        const id = r.getAttribute('fill').match(/^url\(#(.+)\)$/)[1];
        assert.ok(env.document.getElementById(id), 'stripe pattern exists');
    }
    assert.ok(bars(env, 'd4').every(r => !r.classList.contains('provisional')));
    const label = env.root.querySelector('.tsbars-label[data-key="d5"]');
    assert.ok(label.classList.contains('accent'));
});

test('the axis follows the stacked totals', () => {
    const { env } = energy();
    const axis = texts($$(env.root, '.tsbars-axis text'));
    assert.equal(axis[0], 'kWh');
    // The tallest stack in view is 6.5 kWh; the scale must reach it.
    const kwhTicks = axis.slice(1, axis.indexOf('COP')).map(Number);
    assert.equal(kwhTicks[0], 0);
    assert.ok(kwhTicks.at(-1) >= 6.5);
});

test('the bar axis is only as wide as its labels and units', () => {
    const { env } = energy();
    const clip = env.root.querySelector('clipPath rect');
    // Widest is "kWh"/"COP"/"2.9" at 3 characters, plus 4 px gap and 1 px margin.
    assert.equal(num(clip, 'x'), 3 * 7 + 5);
});

test('the COP line breaks at a day without data', () => {
    const { env } = energy();
    const d = env.root.querySelector('.tsbars-line[data-series="cop"]').getAttribute('d');
    assert.equal((d.match(/M/g) || []).length, 2);
    assert.equal($$(env.root, '.tsbars-point').some(p => p.getAttribute('data-key') === 'd3'), false);
});

test('labels cover every bucket including the neighbours outside the view', () => {
    const { env } = energy();
    const labels = $$(env.root, '.tsbars-label');
    assert.deepEqual(texts(labels), ['0', '1', '2', '3', '4', '5']);
    assert.deepEqual(labels.filter(l => l.classList.contains('tsbars-label-out')).map(l => l.textContent),
                     ['0', '1']);
});

test('clicking a day selects it; a day without data is not selectable', () => {
    const { env, b } = energy();
    const picks = [];
    env.root.addEventListener('tsbars:select', e => picks.push(e.detail.key));
    const hit = key => env.root.querySelector(`.tsbars-hit[data-key="${key}"]`);
    assert.equal(hit('d3'), null);
    const r = hit('d4');
    const x = num(r, 'x') + num(r, 'width') / 2, y = num(r, 'y') + 20;
    pointer(env, b.body, 'pointerdown', x, y);
    pointer(env, b.body, 'pointerup', x, y);
    assert.deepEqual(picks, ['d4']);
    assert.equal(b.getSelected(), 'd4');
    assert.notEqual(env.root.querySelector('.tsbars-sel').style.display, 'none');

    // d3 is between d2 and d4.
    const plot = b.getPlotArea(), slot = (plot.x2 - plot.x1) / 4;
    pointer(env, b.body, 'pointerdown', plot.x1 + slot * 1.5, y);
    pointer(env, b.body, 'pointerup', plot.x1 + slot * 1.5, y);
    assert.deepEqual(picks, ['d4']);
});

test('dragging pans by whole days and stops at the newest', () => {
    const { env, b } = energy();
    const views = [];
    env.root.addEventListener('tsbars:view', e => views.push(e.detail));
    const plot = b.getPlotArea(), slot = (plot.x2 - plot.x1) / 4, y = plot.y1 + 20;
    assert.equal(b.getView().lastKey, 'd5');

    drag(env, b.body, plot.x1 + 20, y, plot.x1 + 20 + slot * 2.2);
    assert.equal(views.length, 1);
    assert.equal(views[0].steps, -2);
    assert.deepEqual([b.getView().firstKey, b.getView().lastKey], ['d0', 'd3']);

    // Back to the newest, and a further drag past it springs back.
    drag(env, b.body, plot.x2 - 20, y, plot.x2 - 20 - slot * 3);
    assert.equal(b.getView().lastKey, 'd5');
    const n = views.length;
    drag(env, b.body, plot.x2 - 20, y, plot.x2 - 20 - slot * 2);
    assert.equal(views.length, n, 'no view change past the newest day');
    assert.equal(b.getView().lastKey, 'd5');
});

test('on touch a drag scrubs the day card and selects where it ends', () => {
    const { env, b } = energy();
    b.setCard((bk, card) => card.add('title', `Day ${bk.label}`));
    const views = [], picks = [];
    env.root.addEventListener('tsbars:view', e => views.push(e.detail));
    env.root.addEventListener('tsbars:select', e => picks.push(e.detail.key));
    const plot = b.getPlotArea(), slot = (plot.x2 - plot.x1) / 4, y = plot.y1 + 20;
    const touch = { pointerType: 'touch' };
    pointer(env, b.body, 'pointerdown', plot.x1 + slot * 0.5, y, touch);
    pointer(env, b.body, 'pointermove', plot.x1 + slot * 2.5, y, touch);
    assert.equal(env.root.querySelector('.tschart-card .title').textContent, 'Day 4');
    pointer(env, b.body, 'pointerup', plot.x1 + slot * 2.5, y, touch);
    assert.equal(views.length, 0, 'no pan');
    assert.equal(b.getView().lastKey, 'd5');
    assert.deepEqual(picks, ['d4']);
    assert.equal(env.root.querySelector('.tschart-card'), null);
});

test('on touch a hold then a drag pans by days; a still hold selects', () => {
    const { env, b } = energy();
    const held = holdClock(env);
    const views = [], picks = [];
    env.root.addEventListener('tsbars:view', e => views.push(e.detail));
    env.root.addEventListener('tsbars:select', e => picks.push(e.detail.key));
    const plot = b.getPlotArea(), slot = (plot.x2 - plot.x1) / 4, y = plot.y1 + 20;
    const touch = { pointerType: 'touch' };
    pointer(env, b.body, 'pointerdown', plot.x1 + 20, y, touch);
    held();
    for (let i = 1; i <= 6; i++) pointer(env, b.body, 'pointermove', plot.x1 + 20 + slot * 2.2 * i / 6, y, touch);
    pointer(env, b.body, 'pointerup', plot.x1 + 20 + slot * 2.2, y, touch);
    assert.equal(views.length, 1);
    assert.equal(views[0].steps, -2);
    assert.deepEqual(picks, []);

    pointer(env, b.body, 'pointerdown', plot.x1 + slot * 1.5, y, touch);
    held();
    pointer(env, b.body, 'pointerup', plot.x1 + slot * 1.5, y, touch);
    assert.equal(views.length, 1, 'no pan');
    assert.equal(picks.length, 1);
    assert.ok(!env.root.classList.contains('holding'));
});

test('mouse hover shows the card for the day under the pointer', () => {
    const { env, b } = energy();
    b.setCard((bk, card) => {
        card.add('title', `Day ${bk.label}`);
        card.add('value', 'Heat', `${bk.d.h / 1000} kWh`, '#f80');
    });
    const r = env.root.querySelector('.tsbars-hit[data-key="d4"]');
    pointer(env, b.body, 'pointermove', num(r, 'x') + 10, num(r, 'y') + 20);
    const card = env.root.querySelector('.tschart-card');
    assert.ok(card);
    assert.equal(card.querySelector('.title').textContent, 'Day 4');
    assert.equal(card.querySelector('.value .v').textContent, '5 kWh');
    pointer(env, b.body, 'pointerleave', 0, 0);
    assert.equal(env.root.querySelector('.tschart-card'), null);
});

test('a pane with no values in view shows its empty text', () => {
    const env = setup();
    const b = new env.TsBars(env.root, { count: 3 });
    const p = b.addPane({ id: 'kwh', emptyText: 'No energy recorded' });
    b.addSeries(p, { id: 'h', color: '#f80', value: () => null });
    b.setBuckets([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
    b.flush();
    assert.equal(env.root.querySelector('.tsbars-empty').textContent, 'No energy recorded');
    assert.equal($$(env.root, '.tsbars-bar').length, 0);
});
