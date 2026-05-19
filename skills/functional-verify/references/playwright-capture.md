# Playwright capture rules

## Tools

- `browser_navigate` — load the route
- `browser_snapshot` — a11y tree (cheaper than a screenshot, use to locate elements)
- `browser_click` / `browser_type` / `browser_fill_form` / `browser_select_option` / `browser_press_key`
- `browser_wait_for` — wait for text/state changes
- `browser_console_messages level: error` — after every navigation
- `browser_network_requests` — when verifying API calls fired from UI
- `browser_evaluate` — for rects / computed styles you intend to cite
- `browser_take_screenshot` — `fullPage: false`
- `browser_close` — once at the end

One browser session for all scenarios.

## Viewports

- Responsive specs: 375 / 768 / 1280
- Otherwise: the spec's declared viewports

## Per-route capture

For each (route, viewport):

1. **Page screenshot** — `browser_take_screenshot fullPage: false` → `<route>-<viewport>.png`
2. **Slices for tall pages** — when `document.documentElement.scrollHeight > 2 × viewport.h`, capture viewport-scale slices at `scrollY = 0, vh, 2vh, …` → `<route>-<viewport>-slice-NN.png`. Full-page screenshots compress too aggressively for layout review at scale; slices are the actual evidence.

## Grading rules

- `Read` the PNG file path before grading. Inline previews returned by `browser_take_screenshot` do not count.
- To cite a rect/size/position, get it from `browser_evaluate` running `getBoundingClientRect()`. Do not name a number you didn't measure.
- Console errors: distinguish *new* errors from pre-existing ones by checking main branch when feasible. Pre-existing → flag as such, do not silently drop.
