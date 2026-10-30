/*
 * tsbars -- tschart's bucket (bar) chart for LVGL 9.5.
 *
 * Equal slots for ordinal buckets (days, months...) instead of a time axis,
 * so calendar quirks such as DST never shift a bar. Stacked panes, each with
 * its own y scale, hold stacked bars and/or line series. Buckets in progress
 * are striped; one bucket can be selected; a sideways drag pans by whole
 * buckets with the neighbours already drawn, so they slide in with the
 * finger.
 *
 * Contract (as tschart.h):
 *  - Every tsbars_* call runs on the LVGL thread / under the LVGL lock.
 *  - Config structs and strings are copied; the bucket array is copied but
 *    each bucket's `data` is borrowed until the next tsbars_set_buckets()
 *    or the chart's deletion.
 *  - The axes fit the buckets in view only, so they hold still mid-drag.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "lvgl.h"
#include "tschart.h"

#ifdef __cplusplus
extern "C" {
#endif

#define TSBARS_MAX_PANES  3
#define TSBARS_MAX_SERIES 8

typedef struct tsbars_pane tsbars_pane_t;
typedef struct tsbars_series tsbars_series_t;

/* ---- Buckets ------------------------------------------------------------- */

enum {
    TSBARS_ACCENT = 1,       /* label in the accent colour (e.g. today) */
    TSBARS_PROVISIONAL = 2,  /* still filling up: bars are striped */
    TSBARS_SELECTABLE = 4,   /* a tap selects it */
};

typedef struct {
    uint32_t key;            /* unique, ascending, e.g. YYYYMMDD; 0 = none */
    uint8_t flags;
    const void *data;        /* borrowed; passed back to the callbacks */
} tsbars_bucket_t;

/* ---- Creation ------------------------------------------------------------ */

lv_obj_t *tsbars_create(lv_obj_t *parent);

/** Font for tick, unit and bucket labels (default: the object's font). */
void tsbars_set_small_font(lv_obj_t *c, const lv_font_t *font);
void tsbars_set_accent(lv_obj_t *c, lv_color_t color);

typedef struct {
    int16_t gutter;     /* y-axis labels, left of the plot (64) */
    int16_t right;      /* right inset (14) */
    int16_t top;        /* above the first pane: its unit sits here (36) */
    int16_t label_h;    /* bucket labels under the last pane (36) */
    int16_t pane_gap;   /* (14) */
    int16_t tick_min_px;/* least px per tick interval (36) */
} tsbars_metrics_t;
void tsbars_set_metrics(lv_obj_t *c, const tsbars_metrics_t *m);

/** Buckets in view (default 14). */
void tsbars_set_count(lv_obj_t *c, uint16_t count);
/** Bar width as permille of the slot (default 600), capped at max_px (0 = no
 *  cap). */
void tsbars_set_bar_width(lv_obj_t *c, uint16_t permille, int32_t max_px);

typedef enum { TSBARS_SELECT_OUTLINE, TSBARS_SELECT_FILL } tsbars_select_style_t;
void tsbars_set_select_style(lv_obj_t *c, tsbars_select_style_t style);

/* ---- Panes and series ------------------------------------------------------ */

typedef enum { TSBARS_UNIT_TOP, TSBARS_UNIT_MIDDLE } tsbars_unit_at_t;

typedef struct {
    const char *id;
    uint16_t weight;
    uint16_t min_height;
    const char *unit;          /* e.g. "kWh"; TOP: above the pane, MIDDLE: in the gutter */
    tsbars_unit_at_t unit_at;
    bool has_unit_color;
    lv_color_t unit_color;     /* default: dim */
    bool auto_range;
    bool has_min, has_max;
    int32_t min, max;
    int32_t min_span;
    bool include_zero;
    uint16_t pad_permille;
    int32_t min_pad;
    int32_t min_step;
    uint8_t max_ticks;         /* default 5 */
    bool ends_only;            /* tick labels at the ends only */
    tschart_value_fmt_cb_t fmt;
    void *fmt_ud;
    const char *empty_text;    /* shown when no bucket in view has a value */
} tsbars_pane_cfg_t;

tsbars_pane_t *tsbars_add_pane(lv_obj_t *c, const tsbars_pane_cfg_t *cfg);
void tsbars_pane_set_empty_text(tsbars_pane_t *p, const char *text);

typedef enum { TSBARS_GEOM_BAR, TSBARS_GEOM_LINE } tsbars_geom_t;

/** The bucket's value; false = none. */
typedef bool (*tsbars_value_cb_t)(const tsbars_bucket_t *b, int32_t *out, void *ud);

typedef struct {
    const char *id;
    lv_color_t color;
    tsbars_geom_t geom;
    uint8_t stack;             /* bars with the same non-zero stack stack up,
                                  in series order; 0 = on their own */
    uint8_t width;             /* line width (2) */
    lv_opa_t opa;              /* line opacity (0 = LV_OPA_60) */
    uint8_t point_radius;      /* line dots (0 = none) */
    tsbars_value_cb_t value;
    void *ud;
} tsbars_series_cfg_t;

tsbars_series_t *tsbars_add_series(tsbars_pane_t *p, const tsbars_series_cfg_t *cfg);

/** Bucket label into buf; 0 = none. */
typedef size_t (*tsbars_label_cb_t)(const tsbars_bucket_t *b, char *buf, size_t cap,
                                    void *ud);
/** Labels every Nth bucket, anchored on the newest, so they sit at least
 *  min_gap px apart (0 = every bucket; the callback can thin them). */
void tsbars_set_labels(lv_obj_t *c, tsbars_label_cb_t cb, void *ud, int32_t min_gap);

/* ---- Data and view --------------------------------------------------------- */

typedef enum {
    TSBARS_VIEW_KEEP,        /* keep the first key in view, else the newest */
    TSBARS_VIEW_FIRST_KEY,
    TSBARS_VIEW_LAST_KEY,
    TSBARS_VIEW_NEWEST,
} tsbars_view_t;

/** Buckets oldest first; empty buckets included so every slot is one bucket. */
void tsbars_set_buckets(lv_obj_t *c, const tsbars_bucket_t *b, size_t n,
                        tsbars_view_t view, uint32_t key);
/** Moves the view to start at index `first` (silent). */
void tsbars_set_view(lv_obj_t *c, int32_t first);

typedef struct {
    int32_t first;
    uint16_t count;
    uint32_t first_key, last_key;
} tsbars_view_info_t;
void tsbars_get_view(const lv_obj_t *c, tsbars_view_info_t *out);
/** Buckets a drag may move back / forward before it rubber-bands (also
 *  capped by the loaded buckets); negative = no extra cap. */
void tsbars_set_pan_limits(lv_obj_t *c, int32_t back, int32_t forward);
/** Highlights a bucket (silent); 0 clears. */
void tsbars_set_selected(lv_obj_t *c, uint32_t key);
uint32_t tsbars_get_selected(const lv_obj_t *c);
/** Centred message over the plot; NULL/"" hides it. */
void tsbars_set_status(lv_obj_t *c, tschart_status_t st, const char *text);
void tsbars_get_plot_area(const lv_obj_t *c, lv_area_t *out);
/** Index of the bucket in view under screen x, or -1. */
int32_t tsbars_index_at(const lv_obj_t *c, int32_t x);

/* ---- Events ---------------------------------------------------------------- */

/* Registered on the first tsbars_create(). */
extern lv_event_code_t TSBARS_EVENT_SELECT;
extern lv_event_code_t TSBARS_EVENT_VIEW_CHANGED;

/** SELECT: the chart has already selected the bucket. */
typedef struct { uint32_t key; int32_t index; const tsbars_bucket_t *bucket; } tsbars_select_t;
/** VIEW_CHANGED after a drag moved the view by `steps` buckets within the
 *  loaded ones. Reload around it and call tsbars_set_buckets(KEEP). */
typedef struct { int32_t steps; tsbars_view_info_t view; } tsbars_view_changed_t;

#ifdef __cplusplus
}
#endif
