# tschart

A time-series chart widget with stacked panes, built for small touch screens
and reused on the web. It has one model and two implementations:

- **`include/` + `src/`**: an LVGL 9.5 widget packaged as an ESP-IDF
  component (first consumer: the
  [arctic-controller](https://github.com/sslivins/arctic-controller)
  History > Cycles screen on an ESP32-P4 Tab5).
- **`web/tschart.js`**: a dependency-free browser version with the same
  concepts, names and logic, driven by the same test vectors.

Features:
- Stacked panes that share a time axis.
- Header chips that act as both the legend and the visibility toggles.
- A collapsible y-axis gutter with unit pills.
- Line-end value tags that spread out so they never overlap, with an
  on/off toggle.
- A cursor card.
- Pan with snap, a pending-window spinner and spring-back, plus hatched
  "start of history" / "now" edge zones.
- Span bands (fill or hatch) and fault notes that merge when they collide.

See [docs/api.md](docs/api.md).

## ESP-IDF

Add the repo as a submodule under `components/tschart`. The component
requires `lvgl`.

```c
#include "tschart.h"
lv_obj_t *c = tschart_create(parent);
tschart_source_t *src = tschart_add_source(c, "telemetry");
tschart_pane_t *temps = tschart_add_pane(c, &(tschart_pane_cfg_t){ ... });
tschart_add_layer(temps, &(tschart_layer_cfg_t){ ... });
lv_obj_add_event_cb(c, on_window_request, TSCHART_EVENT_WINDOW_REQUEST, NULL);
```

## Web

```html
<div id="chart" style="height:400px"></div>
<script src="tschart.js"></script>
<script>
  const chart = new TsChart(document.getElementById('chart'), { id: 'history' });
  // addSource / addPane / addLayer / addGroup, then setDataset(...)
</script>
```

Open `web/demo.html` in a browser to try every feature on synthetic data.

## Tests

```sh
cmake -S tests -B build && cmake --build build && ctest --test-dir build   # C logic
npm ci && npm test                                  # JS logic + widget DOM tests (jsdom)
# LVGL widgets: build against LVGL 9.5 and run the headless render test
cmake -S tests/lvgl -B build-lvgl -DLVGL_DIR=<lvgl v9.5.0 checkout> && cmake --build build-lvgl && ctest --test-dir build-lvgl
```

The render test writes each scene to `build-lvgl/render_*.bmp`; CI uploads
them as the `lvgl-renders` artifact.