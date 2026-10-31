# Builds the LVGL widgets against LVGL 9.5 on the host and runs a headless
# render test. LVGL comes from -DLVGL_DIR=<checkout>, else it's fetched.
cmake_minimum_required(VERSION 3.16)
project(tschart_lvgl_tests C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 20)  # ESP-IDF 6 builds C++ as gnu++2x
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
    # -O2 so the format-truncation checks the firmware build runs fire here too.
    set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

set(LVGL_DIR "" CACHE PATH "LVGL 9.5 source tree; fetched when empty")
if(NOT LVGL_DIR)
    include(FetchContent)
    FetchContent_Declare(lvgl
        GIT_REPOSITORY https://github.com/lvgl/lvgl.git
        GIT_TAG v9.5.0
        GIT_SHALLOW TRUE)
    FetchContent_GetProperties(lvgl)
    if(NOT lvgl_POPULATED)
        FetchContent_Populate(lvgl)
    endif()
    set(LVGL_DIR ${lvgl_SOURCE_DIR})
endif()

file(GLOB_RECURSE LVGL_SOURCES ${LVGL_DIR}/src/*.c)
add_library(lvgl STATIC ${LVGL_SOURCES})
target_include_directories(lvgl SYSTEM PUBLIC ${LVGL_DIR} ${LVGL_DIR}/src ${CMAKE_CURRENT_LIST_DIR})
target_compile_definitions(lvgl PUBLIC LV_CONF_INCLUDE_SIMPLE)
target_compile_options(lvgl PRIVATE -w)

set(TSCHART_ROOT ${CMAKE_CURRENT_LIST_DIR}/../..)
add_library(tschart_lvgl STATIC
    ${TSCHART_ROOT}/src/tschart.cpp
    ${TSCHART_ROOT}/src/tschart_draw.cpp
    ${TSCHART_ROOT}/src/tschart_logic.cpp
    ${TSCHART_ROOT}/src/tsbars.cpp)
target_include_directories(tschart_lvgl PUBLIC ${TSCHART_ROOT}/include PRIVATE ${TSCHART_ROOT}/src)
target_link_libraries(tschart_lvgl PUBLIC lvgl)
# The warnings ESP-IDF builds components with, as errors.
target_compile_options(tschart_lvgl PRIVATE
    -Wall -Wextra -Werror -Wno-unused-parameter -Wno-sign-compare -Wformat-truncation)

add_executable(test_render test_render.cpp)
target_link_libraries(test_render PRIVATE tschart_lvgl m)
target_compile_options(test_render PRIVATE -Wall -Wextra -Werror -Wno-missing-field-initializers)

enable_testing()
add_test(NAME tschart_render COMMAND test_render ${CMAKE_BINARY_DIR}/render)
