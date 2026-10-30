# tschart design notes (API sketch v1)

> Historical design record from the first implementation. The shipped C API is
> `include/tschart.h`; differences are listed in [api.md](api.md).

Target: LVGL 9.5, ESP32-P4 (M5Stack Tab5, 720x1280), ESP-IDF 6.1. First consumer:
arctic-controller History > Cycles (`main/heatpump_history_screen.cpp`). Later: home
4 h chart, other projects.

v1 = v0 + fixes from two reviews (LVGL/perf and API/reuse). v0 kept as
`chart_widget_api_v0.md`. Changes are summarised in "Changelog" at the end.

Agreed UX (mockups at the end): stacked panes sharing one time axis; chip header
(legend + visibility toggles) inside the card; compact band key; collapsible y-axis
(closed = unit pill per pane, open = 66 px gutter OVER the plot); line-end value tags
with a toggle; tap/scrub cursor with readout card (existing behaviour, kept).

## 1. Packaging

- Separate repo `sslivins/tschart`, ESP-IDF component submodule
  `components/tschart`.
- C API (`tschart.h`), C++17 implementation, real `lv_obj_class_t` subclass of `lv_obj`.
- **Depends on LVGL 9.5 private headers, deliberately.** Subclassing needs
  `lv_obj_class_private.h`; the static cache needs `lv_display_private.h`
  (`layer_head`). The component includes private headers in one place (`tschart_lv.h`)
  and fails the build with `#error` unless `LVGL_VERSION == 9.5.x`. CI builds against
  the pinned LVGL. No "slow-path fallback": uncached drawing costs 100–160 ms/frame
  today, so it's not a usable product.
- No app dependencies (no i18n, prefs, storage). Strings, formatters, units and data
  come from the host.
- Pure logic (tick nicing, auto-range, end-tag placement, plateau interpolation,
  decimation, x/y mapping, pan/snap math, cursor time lookup) is LVGL-free with native
  ctest tests.

## 2. Threading, ownership and lifetimes (contract)

- **Every `tschart_*` call must run on the LVGL thread / under the LVGL lock.**
  Worker tasks never touch the widget; they hand results to the LVGL thread.
- **Config structs and strings are copied.** Compound literals and `i18n_get()`
  results are safe to pass. To change text (language switch), call the matching
  setter again (`tschart_pane_set_unit_tag`, `tschart_layer_set_names`,
  `tschart_group_set_label`, `tschart_set_edge_text`, ...).
- **Spans and notes are copied** on `set_spans`/`set_notes` (small arrays).
- **Sample memory is borrowed**, see §4. It must stay valid and unchanged until it is
  replaced through `tschart_set_dataset()` or the chart is deleted. The widget calls
  the dataset's `release` callback when it stops using it, so the host frees in one place.
- **Handles** (`tschart_pane_t*`, `tschart_layer_t*`, `tschart_group_t*`,
  `tschart_source_t*`) are owned by the chart and become invalid when it is deleted.
- Deleting the chart while a host query is in flight is safe as long as the host
  checks `lv_obj_is_valid()` (or uses its own handle) before delivering. Stale
  results are rejected by request id (§3).

## 3. Time model, panning and the pending window

```c
typedef uint32_t tschart_time_t;          // unix seconds

void tschart_set_bounds(lv_obj_t *c, tschart_time_t earliest, tschart_time_t latest);
void tschart_set_edge_text(lv_obj_t *c, const char *before, const char *after);
void tschart_set_time_formatter(lv_obj_t *c, tschart_time_fmt_cb_t cb, void *ud);
void tschart_set_pan_snap(lv_obj_t *c, uint32_t snap_seconds);   // 0 = no snap
```

Windows are committed only as part of a dataset (§4), so window and data can never
disagree.

Pan flow:
1. Widget owns the gesture (drag > 14 px pans, rubber-band past bounds at 1/3 speed,
   180 ms spring back).
2. On release it computes the target window (snapped, clamped), stores it as
   **`pending_window`**, increments `request_id` and emits
   `TSCHART_EVENT_WINDOW_REQUEST` with `{request_id, start, end}`.
3. While pending, the old cached image is drawn shifted to its position in the
   pending window's mapping (no snap-back), with edge hatching and a loading spinner.
4. The host loads asynchronously and calls `tschart_set_dataset(c, &ds)` with
   `ds.request_id`. Mismatched ids are released and ignored (stale).
5. `tschart_cancel_pending(c)` (e.g. query failed) springs back to the committed
   window. A new pan while pending supersedes the old request.

Double tap emits `TSCHART_EVENT_DOUBLE_TAP` with `{time}` (timestamp under the
finger), so the host can recentre on it (current behaviour) or jump to latest.

## 4. Data: sources and datasets (host owns memory)

The widget never copies samples. A source is a strided array, so
`history_telemetry_sample_t[]` in PSRAM is used in place. A chart can have several
sources (e.g. coil/COP from a different store later); one is the default.

```c
typedef enum { TSCHART_I16, TSCHART_I32, TSCHART_U16, TSCHART_U32 } tschart_num_t;

typedef struct {
    const void *base;
    size_t      count;
    size_t      stride;         // sizeof(sample)
    size_t      time_offset;    // offsetof(sample, timestamp), u32
    uint32_t    gap_seconds;    // break lines across larger gaps
} tschart_source_data_t;

typedef struct {
    size_t        offset;       // offsetof(sample, field)
    tschart_num_t type;
    size_t        flags_offset; // validity bitfield (u8); TSCHART_NO_FLAGS = none
    uint8_t       flags_mask;
    int32_t     (*xform)(int32_t raw, void *ud);  // optional (deci-C -> deci-F)
    void         *xform_ud;
} tschart_field_t;

#define TSCHART_NONE INT32_MIN    // "no value" for derived arrays

tschart_source_t *tschart_add_source(lv_obj_t *c, const char *id);  // first = default

typedef struct {
    uint32_t             request_id;   // 0 = unsolicited (initial load, live update)
    tschart_time_t       start, end;   // window this data is for
    struct { tschart_source_t *src; tschart_source_data_t data; } sources[TSCHART_MAX_SOURCES];
                                       // Kconfig, default 4; more -> set_dataset rejects + logs
    uint8_t              source_count;
    void (*release)(void *ud);         // called when the widget no longer reads it
    void                *release_ud;
} tschart_dataset_t;

bool tschart_set_dataset(lv_obj_t *c, const tschart_dataset_t *ds);  // false = stale
void tschart_set_status(lv_obj_t *c, tschart_status_t st, const char *text);
     // TSCHART_STATUS_OK | LOADING | EMPTY | ERROR  -> centred message in the plot
```

`set_dataset` atomically swaps window + all source pointers, releases the previous
dataset, bumps the data generation and clears cursor/tags. Cursor lookups across
sources use the nearest timestamp within that source's `gap_seconds`.

Values are fixed-point ints; panes declare `value_div` for labels.

## 5. Panes and layers

```c
typedef struct {
    const char *id;               // persistence + test tags
    uint16_t    weight;
    uint16_t    min_height;       // px; drop ticks before going below
    const char *unit_tag;         // pill text: "°C", "coil °C", "kW", "COP"
    lv_color_t  color;
    bool        auto_range;       // false = fixed [min,max]
    bool        has_min, has_max; // fixed bounds, or AUTO floor/ceiling
    int32_t     min, max;
    int32_t     min_span;         // AUTO: never zoom tighter than this
    bool        include_zero;
    uint8_t     max_ticks;
    int32_t     value_div;
    tschart_value_fmt_cb_t fmt;   // see below
    void       *fmt_ud;
} tschart_pane_cfg_t;

typedef enum { TSCHART_FMT_AXIS, TSCHART_FMT_TAG, TSCHART_FMT_CURSOR } tschart_fmt_ctx_t;
typedef size_t (*tschart_value_fmt_cb_t)(int32_t v, tschart_fmt_ctx_t ctx,
                                         char *buf, size_t cap, void *ud);

typedef enum {
    TSCHART_GEOM_LINE,      // straight segments
    TSCHART_GEOM_STEP,      // hold value until next sample (horizontal then vertical)
} tschart_geom_t;

typedef enum {
    TSCHART_INTERP_NONE,
    TSCHART_INTERP_PLATEAU, // whole-unit staircases drawn through plateau midpoints
} tschart_interp_t;

typedef struct {
    const char       *id;
    const char       *name;       // cursor card row: "Inlet"
    const char       *tag_name;   // end tag "in"; NULL = no tag
    tschart_source_t *source;     // NULL = default source
    tschart_field_t   field;
    const int32_t    *derived;    // OR: host array parallel to source (TSCHART_NONE = gap)
    tschart_geom_t    geom;
    tschart_interp_t  interp;
    bool              fill;       // fill to baseline (power = STEP + fill)
    lv_opa_t          fill_opa;
    lv_color_t        color;
    uint8_t           width;
    uint8_t           dash, gap;
    bool              in_cursor;
    bool              drives_range;
} tschart_layer_cfg_t;

tschart_pane_t  *tschart_add_pane (lv_obj_t *c, const tschart_pane_cfg_t *cfg);
tschart_layer_t *tschart_add_layer(tschart_pane_t *p, const tschart_layer_cfg_t *cfg);
void tschart_add_hline(tschart_pane_t *p, int32_t value, lv_color_t color,
                       uint8_t dash, const char *tag_name);   // constant reference line
```

Geometry and fill are independent, so power is `GEOM_STEP + fill` (held step-area,
as today). `derived` lives in the dataset's lifetime (released with it). Plateau arrays
are computed by the widget on dataset change.

## 6. Groups (chips) and visibility

```c
typedef enum { TSCHART_SWATCH_LINE, TSCHART_SWATCH_FILL } tschart_swatch_t;

tschart_group_t *tschart_add_group(lv_obj_t *c, const char *id, const char *label,
                                   lv_color_t color, tschart_swatch_t swatch);
void tschart_group_add_pane (tschart_group_t *g, tschart_pane_t *p);
void tschart_group_add_layer(tschart_group_t *g, tschart_layer_t *l);
void tschart_group_set_visible(tschart_group_t *g, bool on);   // no event emitted
bool tschart_group_get_visible(const tschart_group_t *g);
void tschart_group_set_label(tschart_group_t *g, const char *label);
```

A pane with no visible layers collapses; others re-split by weight. User toggles emit
`TSCHART_EVENT_GROUP_TOGGLED`; the host persists them (widget has no storage).

## 7. Full-height overlays

```c
typedef struct {
    tschart_time_t start, end;   // end == 0 -> open to window end
    lv_color_t     color;
    lv_opa_t       opa;
    uint8_t        style;        // FILL | BASELINE_STRIP | HATCH
} tschart_span_t;

typedef struct { tschart_time_t start, end; const char *text; lv_color_t color; } tschart_note_t;

void tschart_set_spans(lv_obj_t *c, uint8_t set_id, const tschart_span_t *s, size_t n); // copied
void tschart_set_notes(lv_obj_t *c, const tschart_note_t *n, size_t count);            // copied
void tschart_add_key  (lv_obj_t *c, const char *id, const char *label, lv_color_t color);
```

Span sets z-order by `set_id`: run bands, defrost, faults. **Run-band computation
stays in the host** (mode/run semantics are domain specific). Notes reserve a top
strip only when present.

## 8. Layout, header and test tags

```c
void tschart_set_id(lv_obj_t *c, const char *id);   // e.g. "temperature_history_chart"
enum { TSCHART_HEADER_CHIPS = 1, TSCHART_HEADER_KEY = 2, TSCHART_HEADER_TAG_BTN = 4 };
void tschart_set_header(lv_obj_t *c, uint8_t flags);
void tschart_get_plot_area(const lv_obj_t *c, lv_area_t *out);  // for host overlays
```

- The widget owns its internal layout (header row on top, plot below). Externally it
  is a normal object; `flex_grow` sizing works as today.
- Header row wraps to a second line if labels don't fit (FR/ES), and the plot shrinks.
  Hosts can pass shorter labels.
- Chips, key and tag button are child `lv_obj` buttons with test tags (user_data):
  `<id>` on the chart, `<id>_chip_<group_id>`, `<id>_tags_btn`, `<id>_axis_btn`.
- Device tests that use `history_view_temps` / `history_view_power` move to
  `<id>_chip_temps` / `<id>_chip_power` in the same PR as the port.

## 9. Y-axis gutter

```c
void tschart_set_axis_open(lv_obj_t *c, bool open);   // no event
bool tschart_get_axis_open(const lv_obj_t *c);
```

Closed: one pill per visible pane. Open: 66 px gutter over the plot's left edge, all
ticks in pane colour. X mapping unchanged, so the cache stays valid. User toggles emit
`TSCHART_EVENT_AXIS_TOGGLED`.

## 10. End tags

```c
void tschart_set_end_tags(lv_obj_t *c, bool on);      // no event
```

Per pane: sort by y, push down, shift up at the bottom, merge equal rounded values
("in/out 27°"), leader tick when displaced > 4 px. Hidden while the cursor card shows.
User toggles emit `TSCHART_EVENT_TAGS_TOGGLED`.

## 11. Cursor

Current behaviour: tap snaps within 30 px; long-press then drag scrubs; tapping empty
space clears. Line across all panes, a dot per `in_cursor` layer, card flips near the
right edge. The card is built from rows; the widget adds a row per `in_cursor` layer
and the host adds the rest via a callback:

```c
typedef enum { TSCHART_ROW_TITLE, TSCHART_ROW_TEXT, TSCHART_ROW_VALUE, TSCHART_ROW_WARNING } tschart_row_kind_t;

typedef struct tschart_card tschart_card_t;   // opaque builder
void tschart_card_add(tschart_card_t *card, tschart_row_kind_t kind,
                      const char *label, const char *value, lv_color_t color);  // copied

typedef struct {
    tschart_time_t time;                         // cursor time
    tschart_source_t *src; size_t index;         // nearest sample in default source
} tschart_cursor_info_t;

void tschart_set_card_cb(lv_obj_t *c,
     void (*cb)(lv_obj_t *, const tschart_cursor_info_t *, tschart_card_t *, void *), void *ud);
void tschart_clear_cursor(lv_obj_t *c);
```

Host rows today: title ("7:04 AM · Heating"), run duration, run span, up to 2 faults
(WARNING rows). Rows are measured in pixels; long text wraps, max 10 rows, then an
ellipsis row. Card width is capped at 60 % of the plot.

## 12. Rendering, cache and memory

- **Static image** = background, grid, spans, series, time axis, notes. **RGB565**,
  opaque (~684x800x2 = 1.1 MB PSRAM).
- **Dynamic layer** drawn over it every frame: pills/gutter, end tags, cursor, pan
  offset, edge hatching, status message.
- **Invalidation generations** (one rule table in code, tested):

  | change | static_gen (rebuild) | layout_gen (re-split panes) | overlay only |
  |---|---|---|---|
  | dataset, spans, notes | ✓ | | |
  | group visibility, pane/layer cfg, labels/units, fmt | ✓ | ✓ | |
  | size, style, font (`LV_EVENT_SIZE_CHANGED`, `STYLE_CHANGED`) | ✓ | ✓ | |
  | axis open/close, tags on/off, cursor move | | | ✓ |

- **Overlay dirty areas:** every overlay element remembers its last bounds; an update
  invalidates old ∪ new. Window/data/group changes clear cursor and tags first.
- **Cache lifetime:** allocated lazily on first draw, freed on `LV_EVENT_SCREEN_UNLOADED`
  / when hidden and on delete (`tschart_release_cache()` for hosts that manage it). If
  allocation fails, the chart shows its status message instead of drawing uncached.
- **Decimation:** whenever > 1 sample falls in a pixel column, each column keeps
  first/min/max/last in time order; never bridges a gap. Separate reducers for LINE,
  STEP and filled layers. Tests: spikes, gaps, alternating extremes, pane edges.
- Profiling counters behind `TSCHART_PROFILE` Kconfig.

## 13. Input handling

- The chart clears `LV_OBJ_FLAG_SCROLLABLE` / scroll momentum on itself.
- Header children clear `LV_OBJ_FLAG_GESTURE_BUBBLE`. Chart pan/scrub only starts
  when the press began in the plot area (not on a child control).
- `LV_EVENT_PRESS_LOST` cancels pan (spring back) and scrub.

## 14. Events

All are custom codes from `lv_event_register_id()`; params are typed structs.

| event | param |
|---|---|
| `TSCHART_EVENT_WINDOW_REQUEST` | `{request_id, start, end}` |
| `TSCHART_EVENT_DOUBLE_TAP` | `{time}` |
| `TSCHART_EVENT_GROUP_TOGGLED` | `{group, visible}` |
| `TSCHART_EVENT_AXIS_TOGGLED` / `TAGS_TOGGLED` | `{on}` |
| `TSCHART_EVENT_CURSOR_CHANGED` | `{time, index}` or cleared |

Setters never emit toggle events (only user actions do).

## 15. Example: Cycles chart (host side)

```c
lv_obj_t *ch = tschart_create(parent);
tschart_set_id(ch, "temperature_history_chart");
tschart_source_t *hist = tschart_add_source(ch, "history");
tschart_set_pan_snap(ch, 15 * 60);

tschart_pane_t *temps = tschart_add_pane(ch, &(tschart_pane_cfg_t){ .id="temps",
        .weight=40, .unit_tag="°C", .color=WHITE, .auto_range=true, .min_span=200,
        .max_ticks=4, .value_div=10, .fmt=fmt_temp });
tschart_add_layer(temps, &(tschart_layer_cfg_t){ .id="inlet", .name=i18n_get(STR_INLET),
        .tag_name="in", .field=FIELD(inlet_deci_c, INLET_VALID), .geom=TSCHART_GEOM_LINE,
        .interp=TSCHART_INTERP_PLATEAU, .color=INLET, .width=3,
        .in_cursor=true, .drives_range=true });
tschart_pane_t *pwr = tschart_add_pane(ch, &(tschart_pane_cfg_t){ .id="power", .weight=25,
        .unit_tag="kW", .auto_range=true, .include_zero=true, .value_div=1000, .fmt=fmt_kw });
tschart_add_layer(pwr, &(tschart_layer_cfg_t){ .id="power", .name=i18n_get(STR_POWER),
        .tag_name="kW", .field=FIELD(power_w, POWER_VALID), .geom=TSCHART_GEOM_STEP,
        .fill=true, .fill_opa=LV_OPA_40, .color=POWER, .in_cursor=true, .drives_range=true });
/* outlet, setpoint (STEP), groups, keys ... */
tschart_set_header(ch, TSCHART_HEADER_CHIPS | TSCHART_HEADER_KEY | TSCHART_HEADER_TAG_BTN);
tschart_set_card_cb(ch, fill_cycle_card, NULL);
lv_obj_add_event_cb(ch, on_window_request, TSCHART_EVENT_WINDOW_REQUEST, NULL);

/* LVGL thread, after the worker finishes: */
tschart_dataset_t ds = { .request_id=req, .start=s, .end=e,
        .sources={{hist, {buf, n, sizeof(*buf), offsetof(history_telemetry_sample_t, timestamp),
                         CONTIGUOUS_SECONDS}}},
        .source_count=1, .release=free_samples, .release_ud=buf };
if (tschart_set_dataset(ch, &ds)) {
    tschart_set_spans(ch, 0, run_bands, nb);
    tschart_set_spans(ch, 1, defrosts, nd);
}
```

## 16. Rollout

1. Component + native tests. Port History > Cycles **to the new layout** (chips
   replace the Temps/Power toggle; temps + power panes; current data only). This is a
   deliberate UX change: device UI tests are updated in the same PR; parity required
   for pan/snap/spring, double-tap recentre, cursor card content, bands, faults,
   edge zones, loading/empty/error states.
2. Add coil temp + COP to history telemetry (record format change, separate PR), then
   the coil and COP panes.
3. Port the home 4 h chart (uses `tschart_add_hline` for the setpoint). Energy screen
   stays custom unless a BAR geometry is added later.

## 17. Decisions on the v0 open questions

- **Sources:** multiple per chart, one default (§4).
- **Run bands:** host-side; widget only draws spans. A separate pure helper can be
  shared later if another project needs it.
- **Persistence:** host, via toggle events; setters restore state without events.
- **Cache memory:** RGB565 (1.1 MB), lazy, freed when hidden.
- **Header children:** widget owns internal layout; external `flex_grow` unaffected;
  `tschart_get_plot_area()` for host overlays.

## Decided after v1 review

- Max sources per dataset: `TSCHART_MAX_SOURCES` Kconfig, default 4.
- Pane collapse snaps (no animation) for now.
- Live append: full `set_dataset` per sample (~100–160 ms rebuild every 30 s) is
  fine for v1; an incremental append path can come later if needed.

## Changelog v0 → v1

Blocking: threading/ownership contract (§2), pending window + request ids (§3),
atomic `set_dataset` with release callback (§4), explicit LVGL-private dependency
with no fallback (§1), double-tap time + `set_pan_snap` (§3), `GEOM_STEP + fill` for
power (§5), `tschart_set_id` + test tags (§8), rollout step 1 is a declared UX change (§16).
Other: multiple sources, `has_min/has_max`, formatter context, constant reference
line, status states, row-based card, label setters, invalidation table, RGB565 +
lazy cache, decimation rules, input isolation, typed event params.
