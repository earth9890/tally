# Tally — Design System

Imported from the Claude Design project *"Tally time tracking app design"*
(`Tally.dc.html`). Warm, developer-friendly time tracker built on Vercel's
**Geist** type system. This doc is the source of truth for the app's visual
language; `src/renderer/styles.css` implements it as CSS tokens.

## Brand

- **Name:** Tally — *"Time, tallied."*
- **Mark:** four vertical strokes + a diagonal slash — the universal tally for
  five. Reads as *counting*, works down to 16px, needs no wordmark on the menu
  bar. Honey-gradient macOS squircle (`border-radius: 24%`), white strokes;
  on dark, ink squircle with honey strokes.
- **Wordmark:** Geist 600, `letter-spacing: -1.6px`.

## Type

| Role | Font | Notes |
|------|------|-------|
| UI & prose | **Geist Sans** | weights 400/500/600 |
| Data, time, numbers, money | **Geist Mono** | `--num`; tabular feel for durations, %, `$` |

Both bundled locally (`@fontsource-variable/geist`, `-geist-mono`) — no CDN.

## Color

Warm neutrals + a single honey accent + a categorical set.

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--ink` | `#1C1917` | `#F5F1EA` | primary text |
| `--muted` | `#57534E` | `#8A8578` | secondary text |
| `--faint` | `#A8A29E` | `#6C6A63` | labels, captions |
| `--paper` (canvas) | `#E9E3D7` | `#1A1815` | window backdrop |
| `--bg` (content) | `#FDFBF7` | `#1A1815` | main scroll area |
| `--sidebar` | `#FAF7F2` | `#201D19` | left rail |
| `--panel` (card) | `#FFFFFF` | `#232019` | cards |
| `--border` | `rgba(28,25,23,.09)` | `rgba(255,255,255,.08)` | hairlines |
| `--accent` (honey) | `#F59E0B` | `#F59E0B` | brand, primary, "productive" |
| `--accent-soft` | `#FDEFCF` | `rgba(245,158,11,.16)` | active nav, soft fills |
| `--hero` | `#1C1917` | `#111014` | dark "tracked today" card |

**Categorical** (charts, app/category bars): honey `#F59E0B` · teal `#00AC96`
· purple `#8B7CF6` · coral `#F2765F` · green `#2F9E44`.

Productivity semantics: **productive = honey**, neutral = warm grey, unproductive = coral.

## Shape & depth

- Radii: `--r: 16px` (cards), `--r2: 12px` (inner cards), `--r3: 9px` (controls, nav).
- Shadows: barely-there — `0 2px 2px rgba(0,0,0,.04)`; the dashboard shell gets
  one soft lift `0 20px 50px -24px rgba(0,0,0,.25)`. No glow, no glass.
- Hairline borders do the separating, not shadows.

## Layout

- **Left sidebar** (220px): brand, icon nav (Dashboard · Timeline · Apps ·
  Reminders · Settings), and a pinned **"Now tracking"** card at the bottom with
  the live session timer + Pause/Stop.
- **Main:** a 60px topbar (greeting + date, Day/Week toggle, Start/Pause,
  avatar) over a 12-column card grid on the warm `--bg`.
- **Hero:** dark ink card, big mono number ("Tracked today"), stat trio.
- Cards: white, hairline border, generous padding; bars use rounded 99px tracks
  with honey (productive) fills.

## Motion

Subtle only: the live "tracking" dot pulses (`tlpulse`, 2s), bars grow on load
with ease-out. Respects `prefers-reduced-motion`.
