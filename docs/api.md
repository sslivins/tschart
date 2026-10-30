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
- **Keys** are legend items for spans (`fill` or `hatch`).
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
chart.addKey(id, label, color, 'fill'|'hatch');

chart.setBounds(earliest, latest);
chart.setDataset({ requestId, start, end,
  sources: { telemetry: { samples, time: 't' /* key or fn */, gap: 300 } },
  applied: () => { /* set spans, notes, status for this window */ } });   // false = stale
chart.requestWindow(start, end);   // returns the request id
chart.cancelPending();
chart.setSpans(setId, [{ start, end, color, opacity, style: 'fill'|'hatch', minWidth }]);
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
`--ts-text`, `--ts-dim`, `--ts-grid`, `--ts-panel`, `--ts-card` and
`--ts-danger`. Test hooks are `data-tschart-chip|pill|tag|edge|card|status`
attributes, plus `data-layer` on series groups.

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
- Spans take `min_width` and a `FILL` or `HATCH` style. Notes take a label
  prefix.
- `tschart_set_small_font()`, `tschart_set_cursor_x()` (tests) and
  `tschart_get_group()`/`_get_id()` were added.
- The static cache is ARGB8888, not RGB565. Profiling counters are behind
  `CONFIG_TSCHART_PROFILE`.
- `tschart_add_hline` and dataset `release` callbacks aren't implemented
  yet. The host keeps sample memory alive until the next `set_dataset`.

Known numeric difference: plateau interpolation truncates to integers in C
and keeps fractions in JS. Everything else matches the shared test vectors.
