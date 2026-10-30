# tschart API

Two implementations share one model and one set of names:

| | C / LVGL 9.5 (ESP-IDF component) | Web (plain JS, no dependencies) |
|---|---|---|
| Entry | `include/tschart.h` | `web/tschart.js` (global `TsChart`, or `require`) |
| Logic | `src/tschart_logic.cpp`, tests `tests/test_logic.cpp` | `TsChart.logic`, tests `web/test/logic.test.js` (same vectors) |
| Render | cached ARGB8888 static image + per-frame overlay | SVG static group (translated while panning) + SVG/HTML overlay |

The original design and its review history are in [design.md](design.md).

## Model

- **Sources**: sample arrays sharing a time base. The first source is the
  default; the cursor snaps to its samples. At most 4 per dataset.
- **Panes** are stacked and share the time axis. Each has a unit pill, a
  colour, a range config (auto or fixed, include zero, min span, padding,
  minimum step) and a value formatter called with context `axis`, `tag` or
  `cursor`.
- **Layers** draw one value per sample in a pane: `line` or `step`
  geometry, optional fill to the baseline, optional plateau interpolation
  (smooths whole-unit staircases), an end-tag name, and flags for whether it
  appears in the cursor card and drives the pane's range.
- **Groups** are the header chips. Each chip shows or hides its panes and
  layers. A pane with nothing visible collapses and the rest re-split by
  weight.
- **Keys** are legend items for spans (`fill` or `hatch`). A span can name
  a key and take its colour and style from it. A fill key with a *fill
  strength* draws its spans (and its swatch) as an opaque mix of that much
  of its colour over the plot background, instead of a translucent band.
  The band then looks like the legend on any background; a translucent warm
  colour over a dark blue panel doesn't.
- **Spans** are full-height bands in z-ordered sets (`fill` or `hatch` with
  a start line, plus a minimum width). **Notes** are labels above the plot;
  colliding notes merge into one label (shared text, or `×N`).
- **Windows**: the host commits a window only with its data
  (`set_dataset`). A pan that ends past the snap threshold calls
  `request_window`, which emits *window-request* with a request id. Until
  the data arrives, the old image is drawn shifted with a spinner over the
  uncovered part. Stale ids are rejected. Data that arrives mid-gesture is
  applied on release. `cancel_pending` springs back.
- **Toggles** (chips, axis gutter, end tags) emit events only when the user
  changes them; setters are silent so hosts can restore saved state.

## Web API

```js
const chart = new TsChart(element, {
  id: 'history',                    // data-tschart attribute
  timeFormat: (t, step) => '…',     // axis labels; default local h:mm / weekday
  edgeText: { before: 'Start of history', after: 'Now' },
  panSnap: w => Math.min(900, w / 12),   // seconds, or fn(windowSeconds)
  header: { chips: true, key: true, tagsButton: true },
  storageKey: 'my-chart',           // persist chips / axis / tags in localStorage
  metrics: { /* override TsChart.METRICS px values */ },
});
const src = chart.addSource('telemetry');
const pane = chart.addPane({ id, weight, minHeight, unit, color, maxTicks,
  range: { auto, hasMin, hasMax, min, max, minSpan, includeZero, padPermille, minPad, minStep },
  fmt: (v, ctx) => string });
chart.addLayer(pane, { id, name, tag, source, value: sample => number|null,
  geom: 'line'|'step', interp: 'none'|'plateau', fill, fillOpacity, color, width, dash,
  inCursor, drivesRange });
chart.addGroup({ id, label, color, swatch: 'line'|'fill', panes: [], layers: [] });
chart.addKey(id, label, color, 'fill'|'hatch' | { style, fillStrength });  // 0.25 | '25%' | 'var(--x)'

chart.setBounds(earliest, latest);
chart.setDataset({ requestId, start, end,
  sources: { telemetry: { samples, time: 't' /* key or fn */, gap: 300 } },
  applied: () => { /* set spans, notes, status for this window */ } });   // false = stale
chart.requestWindow(start, end);   // returns the request id
chart.cancelPending();
chart.setSpans(setId, [{ start, end, minWidth, key }                     // keyed
                     | { start, end, minWidth, color, opacity, style: 'fill'|'hatch' }]);
chart.setNotes([{ time, text, color }], prefix);
chart.setStatus('ok'|'loading'|'empty'|'error', text);
chart.setCard((info, card) => {      // info: {time, index, source, sample}
  card.add('title'|'block'|'text'|'value'|'warning', label, value, color);
  card.addLayers();                  // layer rows go here (default: at the end)
});
chart.setAxisOpen(bool); chart.setEndTags(bool); chart.setGroupVisible(id, bool);
chart.getWindow(); chart.getTargetWindow(); chart.getPlotArea(); chart.xAt(t); chart.timeAtX(x);
chart.clearCursor(); chart.flush(); chart.destroy();
```

Events are `CustomEvent`s that bubble from the element:

| event | `detail` |
|---|---|
| `tschart:window-request` | `{requestId, start, end}` |
| `tschart:double-tap` | `{time}` |
| `tschart:group-toggled` | `{id, visible}` |
| `tschart:axis-toggled`, `tschart:tags-toggled` | `{on}` |
| `tschart:cursor` | `{time, index}` or `null` |

Input: a mouse hover moves the cursor. A horizontal drag (mouse or touch)
pans. A touch tap places the cursor and a long press scrubs. A double
click or double tap emits *double-tap*. Vertical touch movement scrolls the
page.

Colours come from CSS variables, so a host theme can restyle the chart:
`--ts-text`, `--ts-dim`, `--ts-grid`, `--ts-panel`, `--ts-card`,
`--ts-danger` and `--ts-plot-bg` (the plot background, default
`--ts-panel`; must be opaque, keyed fills are mixed into it). Without CSS
`color-mix()` keyed fills fall back to translucency. Test hooks are `data-tschart-chip|pill|tag|edge|card|status`
attributes, plus `data-layer` on series groups.

## Bucket charts (TsBars / tsbars)

`TsBars` (web, `TsChart.Bars`) and `tsbars` (C, `include/tsbars.h`) chart
ordinal buckets such as days or months. Every bucket gets an equal slot, so
calendar quirks (DST, month lengths) never shift a bar. They share the pane
range model, value formatters, status overlay and colours with tschart.

- **Buckets** are oldest first, one per slot, empty ones included. Each has
  a unique ascending `key`, the host's `data` and flags: *accent* (label in
  the accent colour, e.g. today), *provisional* (still filling up: bars are
  drawn with diagonal stripes) and *selectable*.
- **Panes** stack vertically, each with its own y scale and a unit at the
  top or in the gutter middle. Tick labels can be `all` or `ends` only. The
  axes fit the buckets in view, so they hold still during a drag.
- **Series** are `bar` (stacked by a shared `stack` id, in series order) or
  `line` (through slot centres, broken at missing values, optional dots).
- **View**: `count` buckets are in view. A sideways drag pans by whole
  buckets with the neighbours already drawn, rubber-bands at the loaded
  ends or the host's pan limits, and emits *view* with the step count once
  it settles. The host reloads around the new view and calls `setBuckets`
  again keeping it.
- **Selection**: a tap on a selectable bucket selects it (outline or fill)
  and emits *select*.

```js
const bars = new TsBars(element, {
  id: 'energy', count: 14, barWidth: 0.62, barMaxPx: 32,
  selectStyle: 'outline'|'fill',
  labels: { text: (b, i) => '�', mode: 'every'|'sparse', minGap: 28 },
  metrics: { /* gutter, right, top, labelH, paneGap, tickMinPx */ },
});
const kwh = bars.addPane({ id, weight, minHeight, unit, unitAt: 'top'|'middle', unitColor,
  range: { /* as TsChart */ }, maxTicks, tickLabels: 'all'|'ends', fmt, emptyText });
bars.addSeries(kwh, { id, name, color, value: b => number|null,
  geom: 'bar'|'line', stack, width, opacity, pointRadius });
bars.setBuckets([{ key, data, label, accent, provisional, selectable }],
                { first } | { firstKey } | { lastKey } | { last: true });   // default: keep
bars.setView(first); bars.getView();      // {first, count, firstKey, lastKey}
bars.setCount(n); bars.setPanLimits(back, forward);
bars.setSelected(key); bars.setCard((b, card) => card.add(kind, label, value, color));
bars.setStatus(st, text); bars.getPlotArea(); bars.flush(); bars.destroy();
```

| event | `detail` |
|---|---|
| `tsbars:select` | `{key, index, bucket}` |
| `tsbars:view` | `{steps, first, count, firstKey, lastKey}` |

Test hooks: `data-tsbars` on the root, `.tsbars-bar[data-key]` (plus
`.provisional`), `.tsbars-hit[data-key]`, `.tsbars-label` (plus `.accent`),
`.tsbars-sel`, and `.panning` on the root during a drag.

The C API mirrors it: `tsbars_add_pane()` / `tsbars_add_series()` with
value callbacks, `tsbars_set_labels()` with a label callback and a minimum
gap, `tsbars_set_buckets(..., TSBARS_VIEW_KEEP|FIRST_KEY|LAST_KEY|NEWEST,
key)` (the array is copied, each bucket's `data` borrowed), and the events
`TSBARS_EVENT_SELECT` (`tsbars_select_t`) and `TSBARS_EVENT_VIEW_CHANGED`
(`tsbars_view_changed_t`). The web card has no LVGL counterpart; hosts show
a selected bucket's detail themselves.

## C API vs. the design sketch

The shipped `tschart.h` differs from [design.md](design.md) in these ways:

- `tschart_dataset_t.applied(c, ud)` runs after a dataset is accepted and
  before the redraw. Set that window's spans, notes and status here.
- `tschart_request_window()` lets the host start a load itself (zoom
  buttons, double tap, live follow).
- The pane range uses `pad_permille`, `min_pad` and `min_step`. There is no
  `value_div`; formatters scale the values.
- Card rows include a `BLOCK` kind (block swatch, coloured label).
  `tschart_card_add_layers()` places the layer rows.
- Spans take `min_width` and a `FILL` or `HATCH` style, or a `key`
  (resolved when set; add keys first). `tschart_key_set_fill_strength()`
  mixes a key's fills over the chart's `bg_color`. Notes take a label
  prefix.
- `tschart_set_small_font()`, `tschart_set_cursor_x()` (tests) and
  `tschart_get_group()`/`_get_id()` were added.
- The static cache is ARGB8888, not RGB565. Profiling counters are behind
  `CONFIG_TSCHART_PROFILE`.
- `tschart_add_hline` and dataset `release` callbacks aren't implemented
  yet. The host keeps sample memory alive until the next `set_dataset`.

Known numeric difference: plateau interpolation truncates to integers in C
and keeps fractions in JS. Everything else matches the shared test vectors.
