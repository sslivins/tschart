/* tsbars -- bucket (bar) chart. See include/tsbars.h. */
#include "tsbars.h"

#include "tschart_priv.h"

#include <new>
#include <stdio.h>
#include <string.h>

using namespace tschart;

lv_event_code_t TSBARS_EVENT_SELECT;
lv_event_code_t TSBARS_EVENT_VIEW_CHANGED;

struct tsbars_pane {
    lv_obj_t *chart;
    char id[ID_LEN];
    char unit[16];
    char empty[TEXT_LEN];
    tsbars_pane_cfg_t cfg;     // id/unit/empty_text point at the copies above
    PaneSlot slot;
    Axis axis;
    bool have;                 // a bucket in view has a value
};

struct tsbars_series {
    tsbars_pane_t *pane;
    char id[ID_LEN];
    tsbars_series_cfg_t cfg;
};

namespace {

constexpr int32_t STRIPE_STEP = 12;
constexpr int32_t STRIPE_W = 5;
constexpr lv_opa_t PROVISIONAL_MIX = 89;  // 35 % of the colour over the panel

struct BarsImpl {
    lv_obj_t *self;
    const lv_font_t *small_font;
    lv_color_t accent;
    tsbars_metrics_t m;
    uint16_t count;
    uint16_t bar_permille;
    int32_t bar_max_px;
    tsbars_select_style_t select_style;
    tsbars_pane panes[TSBARS_MAX_PANES];
    uint8_t npanes;
    tsbars_series series[TSBARS_MAX_SERIES];
    uint8_t nseries;
    tsbars_label_cb_t label_cb;
    void *label_ud;
    int32_t min_gap;
    tsbars_bucket_t *buckets;
    size_t nbuckets;
    int32_t first;
    int32_t lim_back, lim_fwd;
    uint32_t selected;
    tschart_status_t status;
    char status_text[64];
    // Gesture
    int32_t x0, dx;
    bool panning, springing, moved, press_in_plot;
    PanLimits lim;
};

struct Bars {
    lv_obj_t obj;
    BarsImpl *d;
};

lv_obj_class_t s_class;

BarsImpl *D(const lv_obj_t *c) { return ((const Bars *)c)->d; }

void copy_str(char *dst, size_t cap, const char *src) {
    if (cap) snprintf(dst, cap, "%s", src ? src : "");
}

int32_t clamp_first(const BarsImpl *d, int32_t first) {
    const int32_t max = LV_MAX(0, (int32_t)d->nbuckets - (int32_t)d->count);
    return LV_CLAMP(0, first, max);
}

struct BarsGeo {
    lv_area_t coords;
    lv_area_t plot;
    int32_t pw;
    int32_t n;
};

bool geo(const lv_obj_t *c, BarsGeo *g) {
    const BarsImpl *d = D(c);
    lv_obj_get_coords(c, &g->coords);
    const tsbars_metrics_t &m = d->m;
    g->plot = {g->coords.x1 + m.gutter, g->coords.y1 + m.top, g->coords.x2 - m.right,
               g->coords.y2 - m.label_h};
    g->pw = lv_area_get_width(&g->plot);
    g->n = d->count;
    return g->pw > 0 && g->plot.y2 > g->plot.y1 + 20 && d->npanes;
}

int32_t sx(const BarsGeo &g, int32_t j) { return slot_x(g.plot.x1, g.pw, g.n, j); }

// The panel the bars sit on, for the provisional mix: the nearest opaque
// background up the tree.
lv_color_t panel_color(lv_obj_t *c) {
    for (lv_obj_t *o = c; o; o = lv_obj_get_parent(o)) {
        if (lv_obj_get_style_bg_opa(o, LV_PART_MAIN) >= LV_OPA_50) {
            return lv_obj_get_style_bg_color(o, LV_PART_MAIN);
        }
    }
    return lv_color_black();
}

// Bars on their own use their series index; stacks the slots after them.
int32_t stack_slot(const tsbars_series &sr, uint8_t s) {
    return sr.cfg.stack ? TSBARS_MAX_SERIES + sr.cfg.stack % TSBARS_MAX_SERIES : s;
}

bool value(const tsbars_series &s, const tsbars_bucket_t &b, int32_t *out) {
    return s.cfg.value && s.cfg.value(&b, out, s.cfg.ud);
}

// Pane slots, then axes fitted to the buckets in view.
void fit(lv_obj_t *c, const BarsGeo &g) {
    BarsImpl *d = D(c);
    uint16_t weights[TSBARS_MAX_PANES], mins[TSBARS_MAX_PANES];
    bool vis[TSBARS_MAX_PANES];
    PaneSlot slots[TSBARS_MAX_PANES];
    for (uint8_t k = 0; k < d->npanes; k++) {
        weights[k] = d->panes[k].cfg.weight ? d->panes[k].cfg.weight : 1;
        mins[k] = d->panes[k].cfg.min_height;
        vis[k] = true;
    }
    split_panes(g.plot.y1, g.plot.y2, d->m.pane_gap, weights, mins, vis, d->npanes, slots);
    const int32_t end = LV_MIN((int32_t)d->nbuckets, d->first + (int32_t)d->count);
    for (uint8_t k = 0; k < d->npanes; k++) {
        tsbars_pane &p = d->panes[k];
        p.slot = slots[k];
        int32_t lo = INT32_MAX, hi = INT32_MIN;
        int32_t stacks[2 * TSBARS_MAX_SERIES];
        for (int32_t i = d->first; i < end; i++) {
            memset(stacks, 0, sizeof(stacks));
            for (uint8_t s = 0; s < d->nseries; s++) {
                const tsbars_series &sr = d->series[s];
                int32_t v;
                if (sr.pane != &p || !value(sr, d->buckets[i], &v)) continue;
                if (sr.cfg.geom == TSBARS_GEOM_BAR) {
                    int32_t &sum = stacks[stack_slot(sr, s)];
                    sum += LV_MAX(0, v);
                    lo = LV_MIN(lo, 0);
                    hi = LV_MAX(hi, sum);
                } else {
                    lo = LV_MIN(lo, v);
                    hi = LV_MAX(hi, v);
                }
            }
        }
        const RangeCfg rc = {p.cfg.auto_range, p.cfg.has_min, p.cfg.has_max, p.cfg.min,
                             p.cfg.max, p.cfg.min_span, p.cfg.include_zero,
                             p.cfg.pad_permille, p.cfg.min_pad, p.cfg.min_step};
        const int32_t ticks = ticks_for_height(p.slot.y2 - p.slot.y1,
                                               p.cfg.max_ticks ? p.cfg.max_ticks : 5,
                                               d->m.tick_min_px);
        p.have = lo <= hi;
        p.axis = auto_range(rc, lo, hi, ticks);
    }
}

void fmt(const tsbars_pane &p, int32_t v, char *buf, size_t cap) {
    if (p.cfg.fmt && p.cfg.fmt(v, TSCHART_FMT_AXIS, buf, cap, p.cfg.fmt_ud)) return;
    snprintf(buf, cap, "%ld", (long)v);
}

int32_t y_of(const tsbars_pane &p, int32_t v) {
    return map_y(v, p.axis.lo, p.axis.hi, p.slot.y1, p.slot.y2);
}

void draw_axes(lv_obj_t *c, lv_layer_t *layer, const BarsGeo &g) {
    BarsImpl *d = D(c);
    const lv_font_t *font = d->small_font;
    const lv_color_t grid = col_grid(c);
    const int32_t fh = lv_font_get_line_height(font);
    const int32_t gx1 = g.coords.x1 + 4, gx2 = g.plot.x1 - 8;
    for (uint8_t k = 0; k < d->npanes; k++) {
        const tsbars_pane &p = d->panes[k];
        const int32_t mid = (p.slot.y1 + p.slot.y2) / 2;
        if (p.unit[0]) {
            const lv_color_t uc = p.cfg.has_unit_color ? p.cfg.unit_color : col_dim();
            if (p.cfg.unit_at == TSBARS_UNIT_MIDDLE) {
                text(layer, {gx1, mid - fh / 2, gx2, mid + fh / 2}, p.unit, uc,
                     LV_TEXT_ALIGN_CENTER, font);
            } else {
                const int32_t y = p.slot.y1 - LV_MIN(d->m.top, 32);
                text(layer, {gx1, y, gx2, y + fh}, p.unit, uc, LV_TEXT_ALIGN_CENTER, font);
            }
        }
        if (!p.have && p.empty[0]) {
            line(layer, g.plot.x1, p.slot.y2, g.plot.x2, p.slot.y2, grid, 1);
            text(layer, {g.plot.x1, mid - fh / 2, g.plot.x2, mid + fh / 2}, p.empty, col_dim(),
                 LV_TEXT_ALIGN_CENTER, font);
            continue;
        }
        if (p.axis.step <= 0) continue;
        for (int32_t v = p.axis.lo; v <= p.axis.hi; v += p.axis.step) {
            const int32_t y = y_of(p, v);
            line(layer, g.plot.x1, y, g.plot.x2, y, grid, 1);
            const bool end = v == p.axis.lo || v + p.axis.step > p.axis.hi;
            if (p.cfg.ends_only && !end) continue;
            char buf[16];
            fmt(p, v, buf, sizeof(buf));
            // Ends-only labels sit inside the pane, clear of a middle unit.
            int32_t ty = y - fh / 2;
            if (p.cfg.ends_only) ty = v == p.axis.lo ? y - fh : y;
            text(layer, {gx1, ty, gx2, ty + fh}, buf, col_dim(), LV_TEXT_ALIGN_RIGHT, font);
        }
    }
}

// Stripes in the colour over a light mix of it, clipped to the bar.
void striped(lv_layer_t *layer, const lv_area_t &a, lv_color_t color, lv_color_t panel) {
    rect(layer, a, lv_color_mix(color, panel, PROVISIONAL_MIX), LV_OPA_COVER);
    const lv_area_t saved = layer->_clip_area;
    if (!lv_area_intersect(&layer->_clip_area, &saved, &a)) {
        layer->_clip_area = saved;
        return;
    }
    lv_draw_line_dsc_t dsc;
    lv_draw_line_dsc_init(&dsc);
    dsc.color = color;
    dsc.width = STRIPE_W;
    // x + y = k lines, phase anchored to the screen so neighbours line up.
    const int32_t k0 = a.x1 + a.y1 - STRIPE_W;
    for (int32_t k = k0 - (k0 % STRIPE_STEP + STRIPE_STEP) % STRIPE_STEP; k < a.x2 + a.y2 + STRIPE_W;
         k += STRIPE_STEP) {
        dsc.p1.x = k - a.y2 - STRIPE_W;
        dsc.p1.y = a.y2 + STRIPE_W;
        dsc.p2.x = k - a.y1 + STRIPE_W;
        dsc.p2.y = a.y1 - STRIPE_W;
        lv_draw_line(layer, &dsc);
    }
    layer->_clip_area = saved;
}

void draw_bucket_bars(lv_obj_t *c, lv_layer_t *layer, const BarsGeo &g, int32_t i, int32_t x1,
                      int32_t x2, lv_color_t panel) {
    BarsImpl *d = D(c);
    const tsbars_bucket_t &b = d->buckets[i];
    int32_t bx1, bx2;
    bar_extent(x1, x2, d->bar_permille, d->bar_max_px, &bx1, &bx2);
    int32_t stacks[2 * TSBARS_MAX_SERIES] = {};
    for (uint8_t s = 0; s < d->nseries; s++) {
        const tsbars_series &sr = d->series[s];
        int32_t v;
        if (sr.cfg.geom != TSBARS_GEOM_BAR || !value(sr, b, &v) || v <= 0) continue;
        const tsbars_pane &p = *sr.pane;
        if (!p.have) continue;
        int32_t &base = stacks[stack_slot(sr, s)];
        const int32_t ylo = y_of(p, base);
        base += v;
        // Off-view buckets can be taller than the axis fitted to the view.
        const int32_t yhi = LV_MAX(y_of(p, base), p.slot.y1);
        if (ylo - yhi < 1) continue;
        const lv_area_t a = {bx1, yhi, bx2 - 1, ylo - 1};
        if (b.flags & TSBARS_PROVISIONAL) {
            striped(layer, a, sr.cfg.color, panel);
        } else {
            rect(layer, a, sr.cfg.color, LV_OPA_COVER);
        }
    }
}

void draw_lines(lv_obj_t *c, lv_layer_t *layer, const BarsGeo &g, int32_t lo, int32_t hi) {
    BarsImpl *d = D(c);
    for (uint8_t s = 0; s < d->nseries; s++) {
        const tsbars_series &sr = d->series[s];
        const tsbars_pane &p = *sr.pane;
        if (sr.cfg.geom != TSBARS_GEOM_LINE || !p.have) continue;
        const lv_opa_t opa = sr.cfg.opa ? sr.cfg.opa : (lv_opa_t)LV_OPA_60;
        const int32_t w = sr.cfg.width ? sr.cfg.width : 2;
        bool prev = false;
        int32_t px = 0, py = 0;
        for (int32_t i = lo; i < hi; i++) {
            int32_t v;
            const bool ok = value(sr, d->buckets[i], &v);
            if (!ok) {
                prev = false;
                continue;
            }
            const int32_t j = i - d->first;
            const int32_t x = (sx(g, j) + sx(g, j + 1)) / 2 + d->dx;
            const int32_t y = LV_CLAMP(p.slot.y1, y_of(p, v), p.slot.y2);
            if (prev) line(layer, px, py, x, y, sr.cfg.color, w, opa);
            prev = true;
            px = x;
            py = y;
        }
        if (!sr.cfg.point_radius) continue;
        const int32_t r = sr.cfg.point_radius;
        for (int32_t i = lo; i < hi; i++) {
            int32_t v;
            if (!value(sr, d->buckets[i], &v)) continue;
            const int32_t j = i - d->first;
            const int32_t x = (sx(g, j) + sx(g, j + 1)) / 2 + d->dx;
            const int32_t y = LV_CLAMP(p.slot.y1, y_of(p, v), p.slot.y2);
            rect(layer, {x - r, y - r, x + r, y + r}, sr.cfg.color, LV_OPA_COVER,
                 LV_RADIUS_CIRCLE);
        }
    }
}

void draw_main(lv_obj_t *c, lv_layer_t *layer) {
    BarsImpl *d = D(c);
    BarsGeo g;
    if (!geo(c, &g)) return;
    fit(c, g);
    draw_axes(c, layer, g);

    const lv_area_t saved = layer->_clip_area;
    const lv_area_t band = {g.plot.x1, g.coords.y1, g.plot.x2, g.coords.y2};
    if (lv_area_intersect(&layer->_clip_area, &saved, &band)) {
        // The view plus a view's worth either side, so a drag slides them in.
        const int32_t n = d->count;
        const int32_t lo = LV_MAX(0, d->first - n);
        const int32_t hi = LV_MIN((int32_t)d->nbuckets, d->first + 2 * n);
        const lv_color_t panel = panel_color(c);
        const int32_t bottom = d->panes[d->npanes - 1].slot.y2;
        const int32_t every = d->min_gap > 0 ? label_every(g.pw, n, d->min_gap) : 1;
        const int32_t newest = (int32_t)d->nbuckets - 1;
        const int32_t fh = lv_font_get_line_height(d->small_font);
        for (int32_t i = lo; i < hi; i++) {
            const int32_t j = i - d->first;
            const int32_t x1 = sx(g, j) + d->dx, x2 = sx(g, j + 1) + d->dx;
            if (x2 < g.plot.x1 - 1 || x1 > g.plot.x2 + 1) continue;
            const tsbars_bucket_t &b = d->buckets[i];
            const bool sel = d->selected && b.key == d->selected;
            if (sel && d->select_style == TSBARS_SELECT_FILL) {
                rect(layer, {x1, g.plot.y1, x2 - 1, bottom}, d->accent, 36);
            }
            draw_bucket_bars(c, layer, g, i, x1, x2, panel);
            if (d->label_cb && (newest - i) % every == 0) {
                char buf[24];
                if (d->label_cb(&b, buf, sizeof(buf), d->label_ud)) {
                    const int32_t cx = (x1 + x2) / 2, ly = g.plot.y2 + (d->m.label_h - fh) / 2;
                    text(layer, {cx - 60, ly, cx + 60, ly + fh}, buf,
                         (b.flags & TSBARS_ACCENT) ? d->accent : col_dim(),
                         LV_TEXT_ALIGN_CENTER, d->small_font);
                }
            }
            if (sel && d->select_style == TSBARS_SELECT_OUTLINE) {
                lv_draw_rect_dsc_t dsc;
                lv_draw_rect_dsc_init(&dsc);
                dsc.bg_opa = LV_OPA_TRANSP;
                dsc.border_color = d->accent;
                dsc.border_width = 2;
                dsc.radius = 6;
                const lv_area_t a = {x1 + 2, g.plot.y1, x2 - 2, bottom + 4};
                lv_draw_rect(layer, &dsc, &a);
            }
        }
        draw_lines(c, layer, g, lo, hi);
    }
    layer->_clip_area = saved;

    if (d->status != TSCHART_STATUS_OK && d->status_text[0]) {
        const lv_font_t *font = lv_obj_get_style_text_font(c, LV_PART_MAIN);
        const int32_t fh = lv_font_get_line_height(font);
        const int32_t mid = (g.plot.y1 + g.plot.y2) / 2;
        text(layer, {g.plot.x1, mid - fh / 2, g.plot.x2, mid + fh / 2}, d->status_text,
             col_dim(), LV_TEXT_ALIGN_CENTER, font);
    }
}

// ---- Input --------------------------------------------------------------------

void spring_exec_cb(void *var, int32_t v) {
    BarsImpl *d = (BarsImpl *)var;
    d->dx = v;
    lv_obj_invalidate(d->self);
}

void spring_done_cb(lv_anim_t *a) {
    BarsImpl *d = (BarsImpl *)a->var;
    d->springing = false;
    d->dx = 0;
    lv_obj_invalidate(d->self);
}

void spring_stop(BarsImpl *d) {
    if (!d->springing) return;
    lv_anim_delete(d, spring_exec_cb);
    d->springing = false;
    d->dx = 0;
}

void spring_from(BarsImpl *d, int32_t from) {
    d->dx = from;
    lv_obj_invalidate(d->self);
    if (from == 0) return;
    d->springing = true;
    lv_anim_t anim;
    lv_anim_init(&anim);
    lv_anim_set_var(&anim, d);
    lv_anim_set_exec_cb(&anim, spring_exec_cb);
    lv_anim_set_values(&anim, from, 0);
    lv_anim_set_duration(&anim, SPRING_MS);
    lv_anim_set_path_cb(&anim, lv_anim_path_ease_out);
    lv_anim_set_completed_cb(&anim, spring_done_cb);
    lv_anim_start(&anim);
}

PanLimits limits(const BarsImpl *d, const BarsGeo &g) {
    int32_t back = d->first;
    int32_t fwd = LV_MAX(0, (int32_t)d->nbuckets - d->first - (int32_t)d->count);
    if (d->lim_back >= 0) back = LV_MIN(back, d->lim_back);
    if (d->lim_fwd >= 0) fwd = LV_MIN(fwd, d->lim_fwd);
    return {-(int32_t)((int64_t)fwd * g.pw / g.n), (int32_t)((int64_t)back * g.pw / g.n)};
}

void pan_end(lv_obj_t *c, bool apply) {
    BarsImpl *d = D(c);
    if (!d->panning) return;
    d->panning = false;
    BarsGeo g;
    const int32_t shown = d->dx;
    if (!geo(c, &g)) {
        spring_from(d, 0);
        return;
    }
    const int32_t dx = apply ? LV_CLAMP(d->lim.min_dx, shown, d->lim.max_dx) : 0;
    const int32_t steps = pan_steps(dx, g.pw, g.n);
    int32_t moved = 0;
    if (steps) {
        const int32_t before = d->first;
        d->first = clamp_first(d, d->first + steps);
        moved = d->first - before;
    }
    // The new view draws in place at once; the part-slot left over eases home.
    spring_from(d, shown + (int32_t)((int64_t)moved * g.pw / g.n));
    if (moved) {
        tsbars_view_changed_t ev = {moved, {}};
        tsbars_get_view(c, &ev.view);
        lv_obj_send_event(c, TSBARS_EVENT_VIEW_CHANGED, &ev);
    }
}

void on_press(lv_obj_t *c, lv_event_code_t code) {
    BarsImpl *d = D(c);
    lv_indev_t *indev = lv_indev_active();
    if (indev == nullptr) return;
    lv_point_t pt;
    lv_indev_get_point(indev, &pt);
    BarsGeo g;
    const bool have = geo(c, &g);
    switch (code) {
        case LV_EVENT_PRESSED:
            spring_stop(d);
            d->x0 = pt.x;
            d->dx = 0;
            d->panning = false;
            d->moved = false;
            d->press_in_plot = have && pt.x >= g.plot.x1 && pt.x <= g.plot.x2 &&
                               pt.y >= g.plot.y1;
            lv_obj_invalidate(c);
            return;
        case LV_EVENT_RELEASED:
        case LV_EVENT_PRESS_LOST:
            pan_end(c, code == LV_EVENT_RELEASED);
            return;
        default:
            break;
    }
    if (!d->press_in_plot || !have) return;
    if (!d->panning) {
        if (LV_ABS(pt.x - d->x0) <= PAN_START_PX || !d->nbuckets) return;
        d->panning = d->moved = true;
        d->x0 = pt.x;  // start sliding from here, no jump
        d->lim = limits(d, g);
        return;
    }
    const int32_t dx = rubber_band(pt.x - d->x0, d->lim);
    if (dx != d->dx) {
        d->dx = dx;
        lv_obj_invalidate(c);
    }
}

void on_click(lv_obj_t *c) {
    BarsImpl *d = D(c);
    if (d->moved || !d->press_in_plot) return;
    lv_indev_t *indev = lv_indev_active();
    if (indev == nullptr) return;
    lv_point_t pt;
    lv_indev_get_point(indev, &pt);
    const int32_t i = tsbars_index_at(c, pt.x);
    if (i < 0) return;
    const tsbars_bucket_t &b = d->buckets[i];
    if (!(b.flags & TSBARS_SELECTABLE)) return;
    d->selected = b.key;
    lv_obj_invalidate(c);
    tsbars_select_t ev = {b.key, i, &b};
    lv_obj_send_event(c, TSBARS_EVENT_SELECT, &ev);
}

// ---- Class ----------------------------------------------------------------------

void constructor_cb(const lv_obj_class_t *, lv_obj_t *obj) {
    void *mem = lv_malloc_zeroed(sizeof(BarsImpl));
    LV_ASSERT_MALLOC(mem);
    BarsImpl *d = new (mem) BarsImpl();
    ((Bars *)obj)->d = d;
    d->self = obj;
    d->small_font = lv_obj_get_style_text_font(obj, LV_PART_MAIN);
    d->accent = lv_color_hex(0x22d3ee);
    d->m = {64, 14, 36, 36, 14, 36};
    d->count = 14;
    d->bar_permille = 600;
    d->lim_back = d->lim_fwd = -1;
    lv_obj_remove_flag(obj, (lv_obj_flag_t)(LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_SCROLL_MOMENTUM |
                                            LV_OBJ_FLAG_SCROLL_CHAIN | LV_OBJ_FLAG_GESTURE_BUBBLE));
    lv_obj_add_flag(obj, LV_OBJ_FLAG_CLICKABLE);
}

void destructor_cb(const lv_obj_class_t *, lv_obj_t *obj) {
    BarsImpl *d = D(obj);
    if (d == nullptr) return;
    lv_anim_delete(d, nullptr);
    lv_free(d->buckets);
    d->~BarsImpl();
    lv_free(d);
    ((Bars *)obj)->d = nullptr;
}

void event_cb(const lv_obj_class_t *, lv_event_t *e) {
    if (lv_obj_event_base(&s_class, e) != LV_RESULT_OK) return;
    const lv_event_code_t code = lv_event_get_code(e);
    lv_obj_t *c = (lv_obj_t *)lv_event_get_current_target(e);
    switch (code) {
        case LV_EVENT_DRAW_MAIN:
            draw_main(c, lv_event_get_layer(e));
            break;
        case LV_EVENT_PRESSED:
        case LV_EVENT_PRESSING:
        case LV_EVENT_RELEASED:
        case LV_EVENT_PRESS_LOST:
            on_press(c, code);
            break;
        case LV_EVENT_CLICKED:
            on_click(c);
            break;
        default:
            break;
    }
}

void class_init() {
    if (s_class.name) return;
    s_class.base_class = &lv_obj_class;
    s_class.constructor_cb = constructor_cb;
    s_class.destructor_cb = destructor_cb;
    s_class.event_cb = event_cb;
    s_class.width_def = LV_PCT(100);
    s_class.height_def = 400;
    s_class.group_def = LV_OBJ_CLASS_GROUP_DEF_FALSE;
    s_class.instance_size = sizeof(Bars);
    s_class.name = "tsbars";
    TSBARS_EVENT_SELECT = (lv_event_code_t)lv_event_register_id();
    TSBARS_EVENT_VIEW_CHANGED = (lv_event_code_t)lv_event_register_id();
}

}  // namespace

// ---- Public API -------------------------------------------------------------------

lv_obj_t *tsbars_create(lv_obj_t *parent) {
    class_init();
    lv_obj_t *obj = lv_obj_class_create_obj(&s_class, parent);
    lv_obj_class_init_obj(obj);
    return obj;
}

void tsbars_set_small_font(lv_obj_t *c, const lv_font_t *font) {
    D(c)->small_font = font;
    lv_obj_invalidate(c);
}

void tsbars_set_accent(lv_obj_t *c, lv_color_t color) {
    D(c)->accent = color;
    lv_obj_invalidate(c);
}

void tsbars_set_metrics(lv_obj_t *c, const tsbars_metrics_t *m) {
    D(c)->m = *m;
    lv_obj_invalidate(c);
}

void tsbars_set_count(lv_obj_t *c, uint16_t count) {
    BarsImpl *d = D(c);
    d->count = count ? count : 1;
    d->first = clamp_first(d, d->first);
    lv_obj_invalidate(c);
}

void tsbars_set_bar_width(lv_obj_t *c, uint16_t permille, int32_t max_px) {
    D(c)->bar_permille = permille;
    D(c)->bar_max_px = max_px;
    lv_obj_invalidate(c);
}

void tsbars_set_select_style(lv_obj_t *c, tsbars_select_style_t style) {
    D(c)->select_style = style;
    lv_obj_invalidate(c);
}

tsbars_pane_t *tsbars_add_pane(lv_obj_t *c, const tsbars_pane_cfg_t *cfg) {
    BarsImpl *d = D(c);
    if (d->npanes >= TSBARS_MAX_PANES) return nullptr;
    tsbars_pane &p = d->panes[d->npanes++];
    p = {};
    p.chart = c;
    p.cfg = *cfg;
    copy_str(p.id, sizeof(p.id), cfg->id);
    copy_str(p.unit, sizeof(p.unit), cfg->unit);
    copy_str(p.empty, sizeof(p.empty), cfg->empty_text);
    p.cfg.id = p.id;
    p.cfg.unit = p.unit;
    p.cfg.empty_text = p.empty;
    lv_obj_invalidate(c);
    return &p;
}

void tsbars_pane_set_empty_text(tsbars_pane_t *p, const char *text) {
    copy_str(p->empty, sizeof(p->empty), text);
    lv_obj_invalidate(p->chart);
}

tsbars_series_t *tsbars_add_series(tsbars_pane_t *p, const tsbars_series_cfg_t *cfg) {
    BarsImpl *d = D(p->chart);
    if (d->nseries >= TSBARS_MAX_SERIES) return nullptr;
    tsbars_series &s = d->series[d->nseries++];
    s = {};
    s.pane = p;
    s.cfg = *cfg;
    copy_str(s.id, sizeof(s.id), cfg->id);
    s.cfg.id = s.id;
    lv_obj_invalidate(p->chart);
    return &s;
}

void tsbars_set_labels(lv_obj_t *c, tsbars_label_cb_t cb, void *ud, int32_t min_gap) {
    BarsImpl *d = D(c);
    d->label_cb = cb;
    d->label_ud = ud;
    d->min_gap = min_gap;
    lv_obj_invalidate(c);
}

static int32_t find_key(const BarsImpl *d, uint32_t key) {
    for (size_t i = 0; i < d->nbuckets; i++) {
        if (d->buckets[i].key == key) return (int32_t)i;
    }
    return -1;
}

void tsbars_set_buckets(lv_obj_t *c, const tsbars_bucket_t *b, size_t n, tsbars_view_t view,
                        uint32_t key) {
    BarsImpl *d = D(c);
    const uint32_t old_key = d->first < (int32_t)d->nbuckets ? d->buckets[d->first].key : 0;
    tsbars_bucket_t *copy = nullptr;
    if (n) {
        copy = (tsbars_bucket_t *)lv_malloc(n * sizeof(*copy));
        LV_ASSERT_MALLOC(copy);
        if (copy == nullptr) n = 0;
        else memcpy(copy, b, n * sizeof(*copy));
    }
    lv_free(d->buckets);
    d->buckets = copy;
    d->nbuckets = n;
    int32_t first = (int32_t)n - (int32_t)d->count;
    int32_t at;
    switch (view) {
        case TSBARS_VIEW_FIRST_KEY:
            if ((at = find_key(d, key)) >= 0) first = at;
            break;
        case TSBARS_VIEW_LAST_KEY:
            if ((at = find_key(d, key)) >= 0) first = at - d->count + 1;
            break;
        case TSBARS_VIEW_KEEP:
            if (old_key && (at = find_key(d, old_key)) >= 0) first = at;
            break;
        default:
            break;
    }
    d->first = clamp_first(d, first);
    lv_obj_invalidate(c);
}

void tsbars_set_view(lv_obj_t *c, int32_t first) {
    BarsImpl *d = D(c);
    d->first = clamp_first(d, first);
    lv_obj_invalidate(c);
}

void tsbars_get_view(const lv_obj_t *c, tsbars_view_info_t *out) {
    const BarsImpl *d = D(c);
    const int32_t last = LV_MIN((int32_t)d->nbuckets, d->first + (int32_t)d->count) - 1;
    out->first = d->first;
    out->count = d->count;
    out->first_key = d->first < (int32_t)d->nbuckets ? d->buckets[d->first].key : 0;
    out->last_key = last >= 0 ? d->buckets[last].key : 0;
}

void tsbars_set_pan_limits(lv_obj_t *c, int32_t back, int32_t forward) {
    D(c)->lim_back = back;
    D(c)->lim_fwd = forward;
}

void tsbars_set_selected(lv_obj_t *c, uint32_t key) {
    D(c)->selected = key;
    lv_obj_invalidate(c);
}

uint32_t tsbars_get_selected(const lv_obj_t *c) { return D(c)->selected; }

void tsbars_set_status(lv_obj_t *c, tschart_status_t st, const char *text) {
    BarsImpl *d = D(c);
    d->status = st;
    copy_str(d->status_text, sizeof(d->status_text), text);
    lv_obj_invalidate(c);
}

void tsbars_get_plot_area(const lv_obj_t *c, lv_area_t *out) {
    BarsGeo g;
    geo(c, &g);
    *out = g.plot;
}

int32_t tsbars_index_at(const lv_obj_t *c, int32_t x) {
    const BarsImpl *d = D(c);
    BarsGeo g;
    if (!geo(c, &g) || x < g.plot.x1 || x > g.plot.x2) return -1;
    const int32_t j = slot_at(x, g.plot.x1, g.pw, g.n);
    if (j < 0 || j >= g.n) return -1;
    const int32_t i = d->first + j;
    return i < (int32_t)d->nbuckets ? i : -1;
}
