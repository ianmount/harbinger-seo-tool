# Harbinger Design Brief — Reference Notes

Condensed summary of **Harbinger Design Brief _standalone_.html** (v1.0, "harbinger_clarity"). This file is the in-repo reference so we don't have to re-unpack the standalone HTML every time. **Always open the HTML for the visual examples.**

The system is an **editorial product UI** — navy chrome, cream paper, red accents, serif italics. Data-dense but literary.

---

## Brand core

| Token            | Hex       | Role                                          |
| ---------------- | --------- | --------------------------------------------- |
| `brand-navy`     | `#03293A` | **Primary.** App chrome, headlines, CTAs.     |
| `brand-navy-700` | `#0B3346` | Hover · hero gradient stop.                   |
| `brand-navy-600` | `#174156` | Info tone · dark-mode lift.                   |
| `brand-red`      | `#FF1E00` | **Accent only.** Never fills a whole surface. |
| `brand-red-700`  | `#D41800` | Hover on accent button.                       |
| `brand-paper`    | `#FAF7F2` | Canvas / app background.                      |
| `brand-cream`    | `#F6F1EA` | Preamble blocks, sidebar text color.          |
| `brand-sand`     | `#EDE4D6` | Skeleton base, deeper paper.                  |

**Brand red ≠ status danger.** Brand red is identity (one thing per screen: primary CTA border-accent, active sidebar item, section kicker, KPI change arrow). Status danger = `#C31B00` — they coexist and are deliberately different.

## Ink scale (text on paper)

| Token   | Value                     | Use                           |
| ------- | ------------------------- | ----------------------------- |
| `ink-1` | `#03293A`                 | Primary body / headlines.     |
| `ink-2` | `rgba(3, 41, 58, 0.74)`   | Secondary body, meta italics. |
| `ink-3` | `rgba(3, 41, 58, 0.52)`   | Captions, helper copy.        |

## Lines & surfaces

- `line` `#E5DED2`, `line-strong` `#CFC6B6` — warm, not gray.
- Surface elevation: `surface-1 #FFFFFF` (cards) → `surface-2 #FAF7F2` (paper) → `surface-3 #F1EADE` (deeper paper).
- **All off-whites are warm.** Never `#F5F5F5` or cool grays.

## Status (semantic only)

| Token     | Base      | Light     | Dark      |
| --------- | --------- | --------- | --------- |
| `success` | `#1A8F5A` | `#DCEFE2` | `#0F5E3A` |
| `warning` | `#C77C00` | `#F7E9CC` | `#7A4C00` |
| `danger`  | `#C31B00` | `#F7D9D1` | `#7E1200` |
| `info`    | `#174156` | `#D5E3EC` | `#0B3346` |

Badges pair each base with its `-light` background at ~12% tint, dark text for AA contrast.

---

## Typography

Two families only. **No Inter, no Roboto, no Geist, no system-ui as primary.**

- **Heading / UI / Chrome:** Montserrat (fallback Gotham, system-ui). Weights 500, 600, 700, 800, 900. Used for every uppercase label, button, card title, number.
- **Body / Editorial:** Source Serif 4 (fallback Source Serif Pro, Georgia). Optical sizes. Italic 400/500 for headlines & quotes; roman 400/500 for body.

### Scale

| Role           | Size    | Weight        | Tracking   | Notes                      |
| -------------- | ------- | ------------- | ---------- | -------------------------- |
| Display        | 38px    | 500           | -0.01em    | Sans                       |
| H1             | 32–44px | 900           | -0.01em    | Sans; can be serif italic on heroes |
| H2             | 22px    | 800           | -0.005em   | Sans                       |
| H3 / Card      | 13–15px | 700           | 0.04em     | Sans, **uppercase**        |
| H4             | 11.5px  | 700           | 0.16em     | Sans, **uppercase**        |
| Subheadline    | 12px    | 700           | 0.20em     | Sans, **uppercase**        |
| Eyebrow        | 11px    | 800           | 0.22em     | Sans, uppercase, often red |
| Body           | 15px    | 400 serif     | —          | 1.55 line-height           |
| Caption        | 11px    | 500 sans      | —          | Ink-3                      |

### Tracking scale
- `tr-eyebrow` = 0.22em
- `tr-label`   = 0.18em
- `tr-section` = 0.24em

### The signature move

**Serif italic body with sans-bold inline on proper nouns and numbers.** This is the brand. Use it in heroes, page intros, editorial quotes, KPI captions.

```html
Retention climbed to <b>96%</b> in Q2, driven by the <b>Southeast</b> region's book consolidation.
```

Where `<b>` is swapped to Montserrat 800, roman, `color: ink-1`; the surrounding prose is Source Serif 4 italic 500, `color: ink-2`.

---

## Spacing, radii, elevation

### Spacing (4px base)

`xs 4 · sm 8 · md 12 · base 16 · lg 20 · xl 24 · 2xl 32 · 3xl 48`

- Card interior padding: **20px** (md), 24px (lg), 14px (sm).
- Page gutter: 24–32px responsive.
- Max content width: 1600px (dashboards); 1120px for narrow editorial shells.

### Radii
- Card `14px` (0.875rem)
- Input `10px` (0.625rem)
- Button `8px` (0.5rem)
- Badge `8px`
- Pill `9999px`

### Shadows
- `shadow-sm`        `0 1px 2px rgba(3,41,58,.04), 0 2px 6px rgba(3,41,58,.04)`
- `shadow-card`      `0 1px 0 rgba(3,41,58,.04), 0 1px 3px rgba(3,41,58,.06)` — **default resting card**
- `shadow-card-hover` `0 4px 12px -2px rgba(3,41,58,.10), 0 2px 4px -2px rgba(3,41,58,.06)`
- `shadow-elev`      `0 2px 6px rgba(3,41,58,.06), 0 8px 24px -8px rgba(3,41,58,.12)` — heroes, popovers
- `shadow-overlay`   `0 12px 32px -12px rgba(3,41,58,.18)`

---

## Components

### Buttons (`.btn`)
- **Uppercase Montserrat 700, 0.08em tracking, 8px radius, 150ms transitions.**
- `primary` = navy bg, cream text. **Navy, not red.**
- `accent` = brand red bg, white text. Reserved for one-off emphasis.
- `secondary` = white bg, ink-1 text, line border, 0.04em tracking.
- `ghost` = transparent, ink-2 text, no shadow, 0.04em tracking.
- `danger` = status danger bg.
- Sizes: `sm` 6×12 11.5px · `md` 9×16 13px · `lg` 11×20 13.5px.

### Badges
- **Dot-and-pill** always. Pill radius, 3px×10px, 11px Montserrat 700 uppercase 0.06em.
- Variants: neutral, `navy`, `success`, `warning`, `danger`, `info`.
- Each paired with its status-light bg at ~12% tint.

### Cards
- White surface, `1px #E5DED2` border, **14px** radius, `shadow-card`.
- Optional **4px left-border accent** for status (red / navy / green / amber). Never full tint fills.
- `card-head` is a gradient wash (surface-2 → surface-1) with an uppercase sans title and italic serif meta on the right.

### Inputs
- Label: Montserrat 600, 11px, **0.14em tracking**, uppercase.
- Field: Source Serif 4 14px, **10px radius**, white bg, line border.
- **Focus ring: brand red @ 18% fill + 60% border.** The one place brand red is allowed as a fill tint.

### Tables (`.tbl`)
- `thead th`: surface-2 bg, Montserrat 700 10.5px uppercase 0.16em, ink-2.
- `tbody td`: 13.5px serif, 10×14 padding, line bottom border.
- Hover row: surface-2.
- Numeric cells: `.num` → Montserrat 600, tabular-nums, right-aligned.

### Hero
- Single per page. `navy → navy-700` gradient, **red diagonal triangle** bleeding off top-right (`clip-path: polygon(0 100%, 100% 0, 100% 100%)`, 88% opacity).
- Serif italic H1 with sans-bold inline. Pills below with brand stats.
- `shadow-elev`.

### Editorial quote
- Source Serif 4 italic 15px, ink-2, **3px brand-red left border**, `rgba(255,30,0,0.04)` tinted bg.
- Footer: sans 600 11px uppercase 0.14em ink-3.

### Section divider
Sigil pattern: red italic serif `§ 01`, sans H2, italic meta right-aligned; `border-top: 1px dashed line-strong`, 64px top margin, 32px top padding.

### H-mark preamble
72×72px navy tile (56×56 on mobile) with the double-H SVG + italic serif paragraph to its right; cream bg, line border, 14px radius.

---

## Layout chrome

### Sidebar
- **248px fixed**, collapses below md.
- `bg: brand-navy`, text `cream @ 78%` (active `@ 100%`).
- **Active item:** `rgba(255,30,0,0.14)` background + 2px brand-red inset-left rule.
- Groups: Montserrat 800, 10px, 0.22em, cream @ 45%.
- Items: Montserrat 600, 12.5px, 8px padding, 8px radius.
- Icons: **1.8px stroke, round caps**, line-style. No filled icons, no duotone.

### TopBar
- Sticky, `z-30`, backdrop-blur.
- Breadcrumb: `Section / Page` — 11.5px uppercase.
- Status pill: Live / Syncing / Offline, dot-and-pill, status palette.

### Main column
- Max-width 1600px (dashboards) / 1120px (editorial).
- Horizontal padding: 16 / 24 / 32px responsive.

---

## Patterns / editorial moves

1. **Section sigil** — red italic `§ 01`, sans H2, italic meta, dashed top border.
2. **H-mark preamble** — 72px navy tile + italic-serif statement with sans-bold inline, cream bg.
3. **Sans-bold inside serif italic** — the signature move (see Typography).
4. **Diagonal red accent** — only on the single hero per page. Not a general decoration.
5. **Skeletons on sand** — loading states use `#EDE4D6`, never gray. Shimmer in cream.
6. **Tabular numerics** — every number uses `font-variant-numeric: tabular-nums`.

---

## Ground rules (non-negotiable)

- **Start from `src/components/ui/`.** Never hand-roll card styles; if the kit lacks it, add it to the kit.
- **Warm paper, warm sand, warm cream.** Never `#F5F5F5` or cool grays.
- **No emoji in product UI.** Line icons only, 1.8px stroke, round caps.
- **Numbers are the hero** — Montserrat 800/900, tabular-nums, tight tracking.
- **No decorative gradients** — only two exist: navy→navy-700 hero, and the subtle card-header wash.
- **Ship dark mode from day one** via surface/content tokens. Dark = navy-black `#0B1820`, never pitch black.
- **Red earns its appearance** — one thing per screen.
- **Never flood red as a background.** Red is a 3–4px border, a single button, or the hero diagonal. Period.
- **Never use brand red as a status.** Brand red = identity; `#C31B00 danger` = state.

---

## Implementation notes for this repo

- Tailwind v4 — tokens live in `app/globals.css` under `:root` + `@theme inline`, **not** a `tailwind.config.ts`.
- Existing shadcn components (`components/ui/*`) use the generic `--primary`/`--secondary`/… tokens — those are remapped to the Harbinger palette so components auto-inherit the new look. Component-level typographic treatments (uppercase buttons, editorial card headers) are applied gradually per screen.
- Fonts are loaded via `next/font/google` in `app/layout.tsx` and exposed as `--font-sans` (Montserrat) and `--font-serif` (Source Serif 4). Body defaults to serif; `h1–h4` default to sans.
- The brief's full visual reference is **`Harbinger Design Brief _standalone_.html`** (untracked; keep as a local working reference, do not commit).
