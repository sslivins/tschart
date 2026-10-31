/* LVGL config for the host render test: what the Arctic controller uses
 * that matters to tschart (RGB565, software renderer), with the C library
 * allocator and no OS. Anything not set here takes LVGL's default. */
#ifndef LV_CONF_H
#define LV_CONF_H

#define LV_COLOR_DEPTH 16
#define LV_USE_STDLIB_MALLOC LV_STDLIB_CLIB
#define LV_USE_STDLIB_STRING LV_STDLIB_CLIB
#define LV_USE_STDLIB_SPRINTF LV_STDLIB_CLIB
#define LV_USE_OS LV_OS_NONE

#define LV_USE_DRAW_SW 1
#define LV_DRAW_SW_COMPLEX 1

#define LV_USE_LOG 1
#define LV_LOG_LEVEL LV_LOG_LEVEL_WARN
#define LV_LOG_PRINTF 1

#define LV_USE_ASSERT_NULL 1
#define LV_USE_ASSERT_MALLOC 1
#define LV_USE_ASSERT_OBJ 1

#define LV_FONT_MONTSERRAT_12 1
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_16 1

#define LV_USE_CANVAS 1
#define LV_USE_SNAPSHOT 1

#endif
