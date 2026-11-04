// Headless render test: build the widgets the way the Arctic controller does,
// render them with LVGL's software renderer into an RGB565 framebuffer, and
// check the pixels and the events a simulated pointer produces. Each scene
// is also written out as a BMP (argv[1] prefix) for eyeballing in CI.
#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "lvgl.h"
#include "tsbars.h"
#include "tschart.h"

static int g_checks = 0;
static int g_failures = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        g_checks++;                                                          \
        if (!(cond)) {                                                       \
            g_failures++;                                                    \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);           \
        }                                                                    \
    } while (0)

#define CHECK_EQ(a, b)                                                       \
    do {                                                                     \
        g_checks++;                                                          \
        long long _a = (long long)(a), _b = (long long)(b);                  \
        if (_a != _b) {                                                      \
            g_failures++;                                                    \
            printf("FAIL %s:%d: %s == %s (%lld vs %lld)\n", __FILE__,        \
                   __LINE__, #a, #b, _a, _b);                                \
        }                                                                    \
    } while (0)

#define CHECK_NEAR(a, b, tol)                                                \
    do {                                                                     \
        g_checks++;                                                          \
        long long _a = (long long)(a), _b = (long long)(b);                  \
        if (llabs(_a - _b) > (long long)(tol)) {                             \
            g_failures++;                                                    \
            printf("FAIL %s:%d: %s ~ %s (%lld vs %lld, tol %lld)\n",         \
                   __FILE__, __LINE__, #a, #b, _a, _b, (long long)(tol));    \
        }                                                                    \
    } while (0)

// ---- Display, pointer and clock ------------------------------------------

constexpr int W = 800, H = 480;
alignas(64) static uint16_t g_fb[W * H];
static lv_display_t *g_disp;
static uint32_t g_ms = 1000;
static const char *g_out;

struct Pointer {
    int32_t x, y;
    bool down;
};
static Pointer g_ptr;

static uint32_t tick_cb() { return g_ms; }
static void flush_cb(lv_display_t *d, const lv_area_t *, uint8_t *) { lv_display_flush_ready(d); }
static void read_cb(lv_indev_t *, lv_indev_data_t *data) {
    data->point.x = g_ptr.x;
    data->point.y = g_ptr.y;
    data->state = g_ptr.down ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}

static void run(uint32_t ms) {
    for (uint32_t t = 0; t < ms; t += 5) {
        g_ms += 5;
        lv_timer_handler();
    }
}

static void render(const char *name) {
    run(100);
    lv_refr_now(g_disp);
    if (!g_out) return;
    char path[512];
    snprintf(path, sizeof path, "%s_%s.bmp", g_out, name);
    FILE *f = fopen(path, "wb");
    if (!f) return;
    const uint32_t row = W * 3, size = 54 + row * H;
    uint8_t hdr[54] = {'B', 'M'};
    auto put32 = [&](int at, uint32_t v) { memcpy(hdr + at, &v, 4); };
    put32(2, size);
    put32(10, 54);
    put32(14, 40);
    put32(18, W);
    put32(22, (uint32_t)-H);  // top-down
    hdr[26] = 1;
    hdr[28] = 24;
    fwrite(hdr, 1, sizeof hdr, f);
    static uint8_t line[W * 3];
    for (int y = 0; y < H; y++) {
        for (int x = 0; x < W; x++) {
            const uint16_t v = g_fb[y * W + x];
            line[x * 3 + 0] = (uint8_t)((v & 31) * 255 / 31);
            line[x * 3 + 1] = (uint8_t)(((v >> 5) & 63) * 255 / 63);
            line[x * 3 + 2] = (uint8_t)(((v >> 11) & 31) * 255 / 31);
        }
        fwrite(line, 1, sizeof line, f);
    }
    fclose(f);
}

// Pointer gestures. The indev is read every LV_DEF_REFR_PERIOD (33 ms).
static void press(int32_t x, int32_t y) {
    g_ptr = {x, y, true};
    run(40);
}
static void move_to(int32_t x, int32_t y) {
    const int32_t x0 = g_ptr.x, y0 = g_ptr.y;
    for (int i = 1; i <= 8; i++) {
        g_ptr.x = x0 + (x - x0) * i / 8;
        g_ptr.y = y0 + (y - y0) * i / 8;
        run(40);
    }
}
static void release() {
    g_ptr.down = false;
    run(40);
}
static void drag(int32_t x0, int32_t y, int32_t x1) {
    press(x0, y);
    move_to(x1, y);
    release();
    run(600);  // let springs settle
}
// Held still past the pan delay, then dragged.
static void hold_drag(int32_t x0, int32_t y, int32_t x1) {
    press(x0, y);
    run(400);
    move_to(x1, y);
    release();
    run(600);
}
static void tap(int32_t x, int32_t y) {
    press(x, y);
    release();
    run(400);  // past the double-click window
}

// ---- Pixels ---------------------------------------------------------------

struct Rgb {
    int r, g, b;
};

static Rgb px(int x, int y) {
    const uint16_t v = g_fb[y * W + x];
    return {((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31};
}
static Rgb hex(uint32_t h) { return {(int)(h >> 16) & 255, (int)(h >> 8) & 255, (int)h & 255}; }
static Rgb mix(Rgb fg, Rgb bg, int opa) {
    return {bg.r + (fg.r - bg.r) * opa / 255, bg.g + (fg.g - bg.g) * opa / 255,
            bg.b + (fg.b - bg.b) * opa / 255};
}
static bool near(Rgb a, Rgb b, int tol = 14) {
    return abs(a.r - b.r) <= tol && abs(a.g - b.g) <= tol && abs(a.b - b.b) <= tol;
}
template <typename F>
static int count_col(int x, int y1, int y2, F pred) {
    int n = 0;
    for (int y = y1; y <= y2; y++) n += pred(px(x, y)) ? 1 : 0;
    return n;
}
template <typename F>
static int count_row(int y, int x1, int x2, F pred) {
    int n = 0;
    for (int x = x1; x <= x2; x++) n += pred(px(x, y)) ? 1 : 0;
    return n;
}

// ---- Home chart: tank line, run bands, a fault, setpoint line -------------

constexpr uint32_t BG = 0x1a1a2e, DIM = 0xa0a0b0, LINE = 0x00ff00, HEAT = 0xf97316,
                   FAULT = 0xff0000, REF = 0x3b82f6;
constexpr tschart_time_t END = 1800000000, START = END - 4 * 3600;

struct Sample {
    uint32_t t;
    int16_t v;
    uint8_t ok;
};
static Sample g_samples[64];
static size_t g_nsamples;

static size_t fmt_temp(int32_t v, tschart_fmt_ctx_t, char *buf, size_t cap, void *) {
    int n = v == TSCHART_NONE ? snprintf(buf, cap, "--") : snprintf(buf, cap, "%d°", (int)(v / 10));
    return n < 0 ? 0 : (size_t)n;
}

struct Events {
    int window_requests, cursor_changes;
    tschart_window_request_t last_request;
    tschart_cursor_changed_t last_cursor;
    int selects, view_changes;
    tsbars_select_t last_select;
    tsbars_view_changed_t last_view;
};
static Events g_ev;

static void chart_event(lv_event_t *e) {
    const lv_event_code_t code = lv_event_get_code(e);
    if (code == TSCHART_EVENT_WINDOW_REQUEST) {
        g_ev.window_requests++;
        g_ev.last_request = *(tschart_window_request_t *)lv_event_get_param(e);
    } else if (code == TSCHART_EVENT_CURSOR_CHANGED) {
        g_ev.cursor_changes++;
        g_ev.last_cursor = *(tschart_cursor_changed_t *)lv_event_get_param(e);
    } else if (code == TSBARS_EVENT_SELECT) {
        g_ev.selects++;
        g_ev.last_select = *(tsbars_select_t *)lv_event_get_param(e);
    } else if (code == TSBARS_EVENT_VIEW_CHANGED) {
        g_ev.view_changes++;
        g_ev.last_view = *(tsbars_view_changed_t *)lv_event_get_param(e);
    }
}

static void style_widget(lv_obj_t *c) {
    lv_obj_set_pos(c, 20, 20);
    lv_obj_set_size(c, 760, 320);
    lv_obj_set_style_bg_color(c, lv_color_hex(BG), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(c, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(c, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(c, 0, LV_PART_MAIN);
    lv_obj_set_style_text_color(c, lv_color_hex(DIM), LV_PART_MAIN);
    lv_obj_set_style_text_font(c, &lv_font_montserrat_16, LV_PART_MAIN);
    lv_obj_add_event_cb(c, chart_event, LV_EVENT_ALL, nullptr);
}

static int32_t x_of(const lv_area_t &p, tschart_time_t t, tschart_time_t s = START,
                    tschart_time_t e = END) {
    return p.x1 + (int32_t)((int64_t)(t - s) * (p.x2 - p.x1) / (int64_t)(e - s));
}

static lv_obj_t *home_chart(tschart_pane_t **pane_out, tschart_source_t **src_out) {
    lv_obj_t *c = tschart_create(lv_screen_active());
    style_widget(c);
    tschart_set_small_font(c, &lv_font_montserrat_12);
    tschart_set_header(c, 0);
    tschart_set_end_tags(c, false);
    tschart_set_input(c, 0);
    tschart_set_axis_outside(c, true);
    tschart_set_relative_time(c, "now");

    tschart_source_t *src = tschart_add_source(c, "tank");
    tschart_pane_cfg_t pane = {};
    pane.id = "tank";
    pane.color = lv_color_hex(DIM);
    pane.max_ticks = 5;
    pane.fmt = fmt_temp;
    tschart_pane_t *p = tschart_add_pane(c, &pane);
    tschart_pane_set_range(p, 200, 600, 100);

    tschart_layer_cfg_t l = {};
    l.id = "tank";
    l.name = "Tank";
    l.field.offset = offsetof(Sample, v);
    l.field.type = TSCHART_I16;
    l.field.flags_offset = offsetof(Sample, ok);
    l.field.flags_mask = 1;
    l.geom = TSCHART_GEOM_LINE;
    l.color = lv_color_hex(LINE);
    l.width = 3;
    l.in_cursor = true;
    tschart_add_layer(p, &l);

    tschart_add_key(c, "heating", nullptr, lv_color_hex(HEAT), TSCHART_SPAN_FILL);
    tschart_key_set_fill_strength(c, "heating", LV_OPA_30);
    tschart_add_key(c, "fault", nullptr, lv_color_hex(FAULT), TSCHART_SPAN_HATCH);
    tschart_set_id(c, "home_chart");

    // 5-minute samples with nothing between 1 h and 1.5 h in.
    g_nsamples = 0;
    for (tschart_time_t t = START; t <= END; t += 300) {
        if (t > START + 3600 && t < START + 5400) continue;
        const double ph = (double)(t - START) / 3600.0;
        g_samples[g_nsamples++] = {t, (int16_t)(400 + lround(120 * sin(ph * 1.7))), 1};
    }
    *pane_out = p;
    *src_out = src;
    return c;
}

static tschart_dataset_t home_dataset(tschart_source_t *src, uint32_t request_id,
                                      tschart_time_t start, tschart_time_t end) {
    tschart_dataset_t ds = {};
    ds.request_id = request_id;
    ds.start = start;
    ds.end = end;
    ds.sources[0].src = src;
    ds.sources[0].data = {g_samples, g_nsamples, sizeof(Sample), offsetof(Sample, t), 900};
    ds.source_count = 1;
    return ds;
}

static void test_home_chart() {
    tschart_pane_t *pane;
    tschart_source_t *src;
    lv_obj_t *c = home_chart(&pane, &src);
    const tschart_dataset_t ds = home_dataset(src, 0, START, END);
    CHECK(tschart_set_dataset(c, &ds));
    const tschart_span_t runs[] = {{START + 2 * 3600, START + 3 * 3600, {}, 0,
                                    TSCHART_SPAN_FILL, 3, "heating"}};
    tschart_set_spans(c, 0, runs, 1);
    const tschart_span_t faults[] = {{END - 1200, 0, {}, 0, TSCHART_SPAN_HATCH, 3, "fault"}};
    tschart_set_spans(c, 2, faults, 1);
    const tschart_note_t notes[] = {{END - 1200, "P02", lv_color_hex(FAULT)}};
    tschart_set_notes(c, notes, 1, "! ");
    const tschart_ref_line_t ref = {pane, 450, lv_color_hex(REF), "45°"};
    tschart_set_ref_lines(c, &ref, 1);
    render("home");

    lv_area_t p;
    tschart_get_plot_area(c, &p);
    CHECK(p.x1 > 20 && p.x2 <= 780 && p.y1 >= 20 && p.y2 < 340);
    CHECK(p.x1 > 40);  // room for the outside axis labels
    const auto is_line = [](Rgb c) { return c.g > 200 && c.r < 100 && c.b < 100; };
    const auto is_bg = [](Rgb c) { return near(c, hex(BG), 6); };

    // The line is unbroken except across the missing half hour.
    const int32_t gap1 = x_of(p, START + 3600), gap2 = x_of(p, START + 5400);
    int drawn = 0, cols = 0, in_gap = 0;
    for (int32_t x = p.x1 + 3; x <= p.x2 - 3; x++) {
        const bool has = count_col(x, p.y1, p.y2, is_line) > 0;
        if (x > gap1 + 4 && x < gap2 - 4) {
            in_gap += has;
        } else if (x < gap1 - 4 || x > gap2 + 4) {
            cols++;
            drawn += has;
        }
    }
    CHECK_EQ(in_gap, 0);
    CHECK_EQ(drawn, cols);

    // The line follows the fixed 20..60° scale.
    const int32_t x0 = x_of(p, START + 3 * 3600 + 1800);
    int32_t y_line = -1;
    for (int32_t y = p.y1; y <= p.y2 && y_line < 0; y++)
        if (is_line(px(x0, y))) y_line = y;
    const double ph = 3.5;
    const int32_t v = 400 + (int32_t)lround(120 * sin(ph * 1.7));
    CHECK_NEAR(y_line, p.y2 - (v - 200) * (p.y2 - p.y1) / 400, 4);

    // The heating band is the key colour at 30% over the background, opaque.
    const Rgb band = mix(hex(HEAT), hex(BG), LV_OPA_30);
    const int32_t xb = x_of(p, START + 2 * 3600 + 1800);
    const int h = p.y2 - p.y1 + 1;
    CHECK(count_col(xb, p.y1, p.y2, [&](Rgb c) { return near(c, band); }) > h * 3 / 4);
    // A column with no span is the plain background.
    const int32_t xn = x_of(p, START + 1800);
    CHECK(count_col(xn, p.y1, p.y2, is_bg) > h * 3 / 4);

    // The open fault runs to the right edge, hatched.
    const auto is_red = [](Rgb c) { return c.r > 120 && c.g < 70 && c.b < 70; };
    const int32_t xf = x_of(p, END - 600);
    const int red = count_col(xf, p.y1, p.y2, is_red);
    CHECK(red > h / 10);
    CHECK(red < h * 9 / 10);
    CHECK(count_col(p.x2 - 2, p.y1, p.y2, is_red) > 0);
    CHECK_EQ(count_col(x_of(p, END - 1800), p.y1 + 1, p.y2, is_red), 0);
    // Its note sits in the strip above the plot.
    CHECK(count_row(p.y1 - 8, xf - 40, xf + 60, is_red) > 0 ||
          count_row(p.y1 - 12, xf - 40, xf + 60, is_red) > 0);

    // The setpoint line at 45° is 62.5% up the 20..60° scale.
    const int32_t yr = p.y2 - (450 - 200) * (p.y2 - p.y1) / 400;
    const auto is_ref = [](Rgb c) { return c.b > 180 && c.r < 120; };
    int best = 0;
    for (int32_t y = yr - 2; y <= yr + 2; y++)
        best = LV_MAX(best, count_row(y, p.x1, x_of(p, END - 1800), is_ref));
    CHECK(best > (x_of(p, END - 1800) - p.x1) / 4);

    // Axis labels left of the plot and time labels below it.
    const auto is_text = [](Rgb c) { return c.r > 80 && c.g > 80 && c.b > 80; };
    int axis = 0, time = 0;
    for (int32_t x = 20; x < p.x1; x++) axis += count_col(x, p.y1, p.y2, is_text);
    for (int32_t y = p.y2 + 2; y < 340; y++) time += count_row(y, p.x1, p.x2, is_text);
    CHECK(axis > 20);
    CHECK(time > 20);

    // ---- Input ----
    const int32_t yp = (p.y1 + p.y2) / 2, quarter = (p.x2 - p.x1) / 4;
    g_ev = {};
    drag(p.x1 + 100, yp, p.x1 + 100 + quarter);
    CHECK_EQ(g_ev.window_requests, 0);  // input off: nothing
    CHECK_EQ(g_ev.cursor_changes, 0);

    tschart_set_input(c, TSCHART_INPUT_CURSOR);
    press(p.x1 + 100, yp);
    move_to(p.x1 + 300, yp);
    CHECK_EQ(g_ev.window_requests, 0);  // no pan: a drag scrubs
    CHECK(g_ev.cursor_changes > 0);
    CHECK(g_ev.last_cursor.active);
    CHECK_NEAR(g_ev.last_cursor.time,
               START + (int64_t)(300 - 0) * (END - START) / (p.x2 - p.x1), 450);
    render("home_cursor");
    release();
    tschart_clear_cursor(c);

    tschart_set_input(c, TSCHART_INPUT_PAN | TSCHART_INPUT_CURSOR);
    tschart_set_bounds(c, START - 86400, END);
    g_ev = {};
    drag(p.x1 + 50, yp, p.x1 + 50 + quarter / 2);  // ends over data, short of the gap
    CHECK_EQ(g_ev.window_requests, 0);  // a plain drag scrubs
    CHECK(g_ev.last_cursor.active);
    tschart_clear_cursor(c);

    // Held still first, the drag pans from where the finger was held.
    press(p.x1 + 50, yp);
    run(400);
    CHECK(!g_ev.last_cursor.active);  // the cursor makes way
    move_to(p.x1 + 50 + quarter, yp);
    release();
    run(600);
    CHECK_EQ(g_ev.window_requests, 1);
    const tschart_window_request_t r = g_ev.last_request;
    CHECK_EQ(r.end - r.start, END - START);
    CHECK_NEAR(r.end, END - (int64_t)quarter * (END - START) / (p.x2 - p.x1), 60);

    const tschart_dataset_t stale = home_dataset(src, r.request_id + 1, r.start, r.end);
    CHECK(!tschart_set_dataset(c, &stale));
    const tschart_dataset_t fresh = home_dataset(src, r.request_id, r.start, r.end);
    CHECK(tschart_set_dataset(c, &fresh));
    tschart_time_t ws, we;
    tschart_get_window(c, &ws, &we);
    CHECK_EQ(ws, r.start);
    CHECK_EQ(we, r.end);
    render("home_panned");

    lv_obj_delete(c);
    run(50);
}

// ---- Energy bars: stacked heat/water, COP line, today provisional ---------

constexpr uint32_t WATER = 0xfbbf24, COP = 0x22c55e, BAR_KEY0 = 20261025;

struct Day {
    bool has;
    int32_t heat, water, cop;
};
static Day g_days[6];

static bool heat_value(const tsbars_bucket_t *b, int32_t *out, void *) {
    const Day *d = (const Day *)b->data;
    if (!d->has) return false;
    *out = d->heat;
    return true;
}
static bool water_value(const tsbars_bucket_t *b, int32_t *out, void *) {
    const Day *d = (const Day *)b->data;
    if (!d->has) return false;
    *out = d->water;
    return true;
}
static bool cop_value(const tsbars_bucket_t *b, int32_t *out, void *) {
    const Day *d = (const Day *)b->data;
    if (!d->has) return false;
    *out = d->cop;
    return true;
}
static size_t fmt_kwh(int32_t v, tschart_fmt_ctx_t, char *buf, size_t cap, void *) {
    const int n = snprintf(buf, cap, "%d", (int)(v / 1000));
    return n < 0 ? 0 : (size_t)n;
}
static size_t fmt_cop(int32_t v, tschart_fmt_ctx_t, char *buf, size_t cap, void *) {
    const int n = snprintf(buf, cap, "%d.%d", (int)(v / 100), (int)(v / 10 % 10));
    return n < 0 ? 0 : (size_t)n;
}
static size_t day_label(const tsbars_bucket_t *b, char *buf, size_t cap, void *) {
    const int n = snprintf(buf, cap, "D%u", (unsigned)(b->key - BAR_KEY0));
    return n < 0 ? 0 : (size_t)n;
}

static void test_energy_bars() {
    lv_obj_t *c = tsbars_create(lv_screen_active());
    style_widget(c);
    tsbars_set_small_font(c, &lv_font_montserrat_12);
    tsbars_set_count(c, 4);
    tsbars_set_labels(c, day_label, nullptr, 0);

    tsbars_pane_cfg_t kwh = {};
    kwh.id = "kwh";
    kwh.weight = 3;
    kwh.unit = "kWh";
    kwh.auto_range = true;
    kwh.include_zero = true;
    kwh.min_step = 1000;
    kwh.fmt = fmt_kwh;
    kwh.empty_text = "No energy";
    tsbars_pane_t *pk = tsbars_add_pane(c, &kwh);
    tsbars_series_cfg_t s = {};
    s.id = "heat";
    s.color = lv_color_hex(HEAT);
    s.stack = 1;
    s.value = heat_value;
    tsbars_add_series(pk, &s);
    s.id = "water";
    s.color = lv_color_hex(WATER);
    s.value = water_value;
    tsbars_add_series(pk, &s);

    tsbars_pane_cfg_t cop = {};
    cop.id = "cop";
    cop.weight = 1;
    cop.unit = "COP";
    cop.auto_range = true;
    cop.fmt = fmt_cop;
    tsbars_pane_t *pc = tsbars_add_pane(c, &cop);
    tsbars_series_cfg_t l = {};
    l.id = "cop";
    l.color = lv_color_hex(COP);
    l.geom = TSBARS_GEOM_LINE;
    l.point_radius = 3;
    l.value = cop_value;
    tsbars_add_series(pc, &l);

    // Six days, four in view. Day 3 has no data; day 5 is today.
    tsbars_bucket_t b[6];
    for (int i = 0; i < 6; i++) {
        g_days[i] = {i != 3, 1000 * (i + 1), 500, 250 + 10 * i};
        b[i] = {BAR_KEY0 + (uint32_t)i,
                (uint8_t)((i != 3 ? TSBARS_SELECTABLE : 0) |
                          (i == 5 ? TSBARS_ACCENT | TSBARS_PROVISIONAL : 0)),
                &g_days[i]};
    }
    tsbars_set_buckets(c, b, 6, TSBARS_VIEW_NEWEST, 0);
    render("energy");

    lv_area_t p;
    tsbars_get_plot_area(c, &p);
    CHECK(p.x1 > 20 && p.x2 <= 780 && p.y1 >= 20 && p.y2 < 340);
    tsbars_view_info_t view;
    tsbars_get_view(c, &view);
    CHECK_EQ(view.first_key, BAR_KEY0 + 2);
    CHECK_EQ(view.last_key, BAR_KEY0 + 5);

    const int32_t slot = (p.x2 - p.x1 + 1) / 4;
    const auto centre = [&](int i) { return p.x1 + slot * (i - 2) + slot / 2; };
    const auto is_heat = [](Rgb c) { return near(c, hex(HEAT), 20); };
    const auto is_water = [](Rgb c) { return near(c, hex(WATER), 20); };
    const auto is_bar = [&](Rgb c) { return is_heat(c) || is_water(c); };

    // Heat stacks under water; heights scale with kWh (d4 heat 5, d2 heat 3).
    const int h4 = count_col(centre(4), p.y1, p.y2, is_heat);
    const int h2 = count_col(centre(2), p.y1, p.y2, is_heat);
    CHECK(h2 > 10);
    CHECK_NEAR(h4 * 300 / LV_MAX(h2, 1), 500, 25);
    int32_t top_heat = -1, bottom_water = -1;
    for (int32_t y = p.y1; y <= p.y2; y++) {
        if (top_heat < 0 && is_heat(px(centre(4), y))) top_heat = y;
        if (is_water(px(centre(4), y))) bottom_water = y;
    }
    CHECK(bottom_water >= 0 && bottom_water < top_heat);
    CHECK_NEAR(bottom_water + 1, top_heat, 2);
    CHECK_EQ(count_col(centre(3), p.y1, p.y2, is_bar), 0);

    // Today is striped: the column alternates between the solid colour and
    // its tint instead of one solid run.
    int runs = 0;
    bool was = false;
    for (int32_t y = p.y1; y <= p.y2; y++) {
        const bool on = is_heat(px(centre(5), y));
        runs += on && !was;
        was = on;
    }
    CHECK(runs >= 4);

    // The COP line has points at days with data.
    const auto is_cop = [](Rgb c) { return near(c, hex(COP), 40); };
    CHECK(count_col(centre(4), p.y1, p.y2, is_cop) > 0);
    CHECK_EQ(count_col(centre(3), p.y1, p.y2, is_cop), 0);

    // ---- Input ----
    const int32_t yp = p.y1 + 20;
    g_ev = {};
    tap(centre(4), yp);
    CHECK_EQ(g_ev.selects, 1);
    CHECK_EQ(g_ev.last_select.key, BAR_KEY0 + 4);
    CHECK_EQ(tsbars_get_selected(c), BAR_KEY0 + 4);
    render("energy_selected");
    tap(centre(3), yp);
    CHECK_EQ(g_ev.selects, 1);  // no data, not selectable

    drag(p.x1 + 20, yp, p.x1 + 20 + slot * 22 / 10);
    CHECK_EQ(g_ev.view_changes, 0);  // a plain drag scrubs the selection

    hold_drag(p.x1 + 20, yp, p.x1 + 20 + slot * 22 / 10);
    CHECK_EQ(g_ev.view_changes, 1);
    CHECK_EQ(g_ev.last_view.steps, -2);
    tsbars_get_view(c, &view);
    CHECK_EQ(view.first_key, BAR_KEY0);
    CHECK_EQ(view.last_key, BAR_KEY0 + 3);
    render("energy_panned");

    hold_drag(p.x2 - 20, yp, p.x2 - 20 - slot * 3);
    tsbars_get_view(c, &view);
    CHECK_EQ(view.last_key, BAR_KEY0 + 5);
    const int n = g_ev.view_changes;
    hold_drag(p.x2 - 20, yp, p.x2 - 20 - slot * 2);  // already at the newest
    CHECK_EQ(g_ev.view_changes, n);
    tsbars_get_view(c, &view);
    CHECK_EQ(view.last_key, BAR_KEY0 + 5);

    lv_obj_delete(c);
    run(50);
}

int main(int argc, char **argv) {
    g_out = argc > 1 ? argv[1] : nullptr;
    lv_init();
    lv_tick_set_cb(tick_cb);
    g_disp = lv_display_create(W, H);
    lv_display_set_color_format(g_disp, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(g_disp, g_fb, nullptr, sizeof g_fb, LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_flush_cb(g_disp, flush_cb);
    lv_obj_set_style_bg_color(lv_screen_active(), lv_color_hex(0x000000), LV_PART_MAIN);
    lv_indev_t *indev = lv_indev_create();
    lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(indev, read_cb);

    test_home_chart();
    test_energy_bars();

    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures ? 1 : 0;
}
