// Mirrors tests/test_logic.cpp. Run: node --test web/test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../tschart.js').logic;

const eqAxis = (a, lo, hi, step) => {
    assert.equal(a.lo, lo);
    assert.equal(a.hi, hi);
    if (step !== undefined) assert.equal(a.step, step);
};

test('niceAxis', () => {
    eqAxis(L.niceAxis(183, 471, 6, 10), 100, 500, 100);
    eqAxis(L.niceAxis(203, 261, 6, 10), 200, 280, 20);
    eqAxis(L.niceAxis(183, 351, 6, 10), 150, 400, 50);
    eqAxis(L.niceAxis(-143, -12, 6, 10), -150, 0, 50);
    eqAxis(L.niceAxis(201, 203, 6, 10), 200, 210, 10);
    assert.equal(L.niceAxis(0, 3150, 5, 1000).step, 1000);
    assert.equal(L.niceAxis(0, 3150, 5, 1000).hi, 4000);
    assert.equal(L.niceAxis(0, 7300, 5, 1000).step, 2000);
    assert.equal(L.niceAxis(0, 7300, 5, 1000).hi, 8000);
    eqAxis(L.niceAxis(0, 0, 5, 1000), 0, 1000);
    const a = L.niceAxis(50, 10, 4, 1);
    assert.ok(a.lo <= 10 && a.hi >= 50);
});

test('autoRange', () => {
    const temps = { auto: true, minSpan: 100, padPermille: 100, minPad: 20, minStep: 10 };
    eqAxis(L.autoRange(temps, 400, 410, 6), 300, 500);
    const none = L.autoRange(temps, 1, 0, 6);
    assert.ok(none.hi > none.lo);

    const power = { auto: true, includeZero: true, minSpan: 1000, padPermille: 50, minStep: 1000 };
    eqAxis(L.autoRange(power, 0, 3150, 5), 0, 4000);
    eqAxis(L.autoRange(power, 0, 4000, 5), 0, 5000);
    eqAxis(L.autoRange(power, 0, 0, 5), 0, 1000);
    eqAxis(L.autoRange(power, 50, 300, 5), 0, 1000);
    assert.equal(L.autoRange(power, 0, 960, 5).hi, 2000);

    assert.equal(L.autoRange({ ...temps, hasMin: true, min: 0 }, 400, 410, 6).lo, 0);

    const fixed = { auto: false, hasMin: true, hasMax: true, min: 0, max: 60, minStep: 1 };
    eqAxis(L.autoRange(fixed, 3, 7, 4), 0, 60, 20);
});

test('mapping', () => {
    assert.equal(L.mapX(1000, 1000, 2000, 10, 110), 10);
    assert.equal(L.mapX(1500, 1000, 2000, 10, 110), 60);
    assert.equal(L.mapX(2500, 1000, 2000, 10, 110), 110);
    assert.equal(L.mapX(500, 1000, 2000, 10, 110), 10);
    assert.equal(L.mapY(0, 0, 100, 0, 200), 200);
    assert.equal(L.mapY(100, 0, 100, 0, 200), 0);
    assert.equal(L.mapY(50, 0, 100, 0, 200), 100);
    assert.equal(L.mapY(-50, -100, 0, 0, 200), 100);
    assert.equal(L.timeAt(60, 1000, 2000, 10, 110), 1500);
    assert.equal(L.timeAt(0, 1000, 2000, 10, 110), 1000);
    assert.equal(L.timeAt(200, 1000, 2000, 10, 110), 2000);
});

test('interpolatePlateaus', () => {
    // C truncates to 202 / 207; JS keeps the fraction.
    assert.deepEqual(L.interpolatePlateaus([0, 60, 120, 180], [200, 200, 210, 210], 300),
                     [200, 202.5, 207.5, 210]);
    assert.deepEqual(L.interpolatePlateaus([0, 60, 1000, 1060, 1120],
                                           [100, 110, 300, null, 320], 300),
                     [100, 110, 300, null, 320]);
    assert.deepEqual(L.interpolatePlateaus([0, 60, 120], [50, 50, 50], 300), [50, 50, 50]);
});

test('decimate', () => {
    let out = L.decimate([5, 5, 5, 5, 5, 5, 6], [0, 1, 2, 3, 4, 5, 6],
                         [10, 3, 8, 20, 7, 9, 11], 100);
    assert.deepEqual(out.map(p => p.v), [10, 3, 20, 9, 11]);
    assert.ok(out[0].brk);
    assert.ok(!out[4].brk);

    out = L.decimate([1, 1, 1, 2, 3], [0, 10, 500, 510, 520], [1, 2, 3, null, 5], 100);
    assert.equal(out.length, 4);
    assert.deepEqual(out.map(p => p.brk), [true, false, true, true]);
    assert.equal(out[2].v, 3);
    assert.equal(out[3].v, 5);
});

test('splitPanes / ticksForHeight', () => {
    let s = L.splitPanes(0, 209, 10, [60, 40], [0, 0], [true, true]);
    assert.deepEqual(s, [{ y1: 0, y2: 119 }, { y1: 130, y2: 209 }]);
    s = L.splitPanes(0, 209, 10, [60, 40], [0, 0], [false, true]);
    assert.ok(s[0].y2 < s[0].y1);
    assert.deepEqual(s[1], { y1: 0, y2: 209 });
    s = L.splitPanes(0, 209, 10, [90, 10], [0, 60], [true, true]);
    assert.equal(s[1].y2 - s[1].y1 + 1, 60);
    assert.equal(s[0].y2, s[1].y1 - 11);

    assert.equal(L.ticksForHeight(200, 6, 40), 5);
    assert.equal(L.ticksForHeight(400, 6, 40), 6);
    assert.equal(L.ticksForHeight(20, 6, 40), 1);
});

test('placeTags', () => {
    const y = [100, 102, 50];
    assert.deepEqual(L.placeTags(y, 20, 2, 0, 300), [2, 0, 1]);
    assert.deepEqual(y, [100, 122, 50]);

    const y2 = [295, 290, 298];
    const o2 = L.placeTags(y2, 20, 2, 0, 300);
    assert.deepEqual(o2.map(i => y2[i]), [246, 268, 290]);

    const y3 = [5, 5, 5];
    const o3 = L.placeTags(y3, 20, 2, 0, 40);
    assert.equal(y3[o3[0]], 10);
    assert.ok(y3[o3[1]] > y3[o3[0]] && y3[o3[2]] > y3[o3[1]]);
});

test('pan', () => {
    const lim = L.panLimits(6400, 10000, 0, 10000, 600);
    assert.equal(lim.minDx, 0);
    assert.equal(lim.maxDx, 1066);
    assert.equal(L.rubberBand(-30, lim), -10);
    assert.equal(L.rubberBand(1096, lim), 1076);
    assert.equal(L.rubberBand(50, lim), 50);

    assert.equal(L.panTarget(300, 6400, 10000, 0, 10000, 600, 900), 8200);
    assert.equal(L.panTarget(20, 6400, 10000, 0, 10000, 600, 900), null);
    assert.equal(L.panTarget(-300, 6400, 10000, 0, 10000, 600, 900), null);
    assert.equal(L.panTarget(-300, 2800, 6400, 0, 10000, 600, 900), 8200);
    assert.equal(L.panTarget(5000, 2800, 6400, 0, 10000, 600, 900), 3700);

    assert.equal(L.uncoveredPermille(0, 1000, 500, 1500), 750);
    assert.equal(L.uncoveredPermille(500, 1500, 0, 1000), 250);
    assert.equal(L.uncoveredPermille(0, 1000, 5000, 6000), 500);
    assert.equal(L.uncoveredPermille(0, 1000, 0, 2000), 500);
});

test('time axis', () => {
    assert.equal(L.timeTickStep(3600, 4), 900);
    assert.equal(L.timeTickStep(6 * 3600, 4), 7200);
    assert.equal(L.timeTickStep(24 * 3600, 4), 21600);
    assert.equal(L.timeTickStep(7 * 86400, 4), 86400);
    assert.equal(L.firstTick(1000, 900, 1000), 1800);
    assert.equal(L.firstTick(1800, 900, 1800), 1800);
    assert.equal(L.firstTick(5000, 3600, 3600 * 5 + 200), 8400);
});

test('cursor', () => {
    const xs = [10, 20, 40, 80];
    const ok = [true, false, true, true];
    assert.equal(L.nearestX(xs, ok, 22, 30), 0);
    assert.equal(L.nearestX(xs, null, 22, 30), 1);
    assert.equal(L.nearestX(xs, ok, 200, 30), -1);
    const t = [100, 200, 300];
    assert.equal(L.nearestTime(t, 240, 60), 1);
    assert.equal(L.nearestTime(t, 260, 60), 2);
    assert.equal(L.nearestTime(t, 400, 60), -1);
    assert.equal(L.nearestTime(t, 0, 100), 0);
    assert.equal(L.nearestTime([], 0, 100), -1);
});

test('groupNotes', () => {
    const r = L.groupNotes([10, 30, 200, 220, 400], 50);
    assert.equal(r.count, 3);
    assert.deepEqual(r.group, [0, 0, 2, 2, 4]);
});

test('key fill strength', () => {
    assert.equal(L.strengthCss(0.25), '25%');
    assert.equal(L.strengthCss('var(--s)'), 'var(--s)');
    assert.equal(L.strengthCss(undefined), null);
    // No color-mix (node has no CSS): plain colour at the strength as opacity.
    assert.deepEqual(L.keyFill({ color: '#f97316', fillStrength: '40%' }),
                     { color: '#f97316', opacity: 0.4 });
    assert.deepEqual(L.keyFill({ color: '#f97316', fillStrength: null }),
                     { color: '#f97316', opacity: 1 });
});
