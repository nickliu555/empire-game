# Game Hub — Agent Instructions

Game Hub is a collection of multiplayer party games. Each game is played on a shared
**Host** screen (TV/laptop) while players join from their phones via QR code. This file
captures the conventions and checks that apply to **every game** — follow them without
being asked.

Games live in two mirrored places:
- **Server:** `server/<game>/` — `index.js` (Socket.IO namespace mounter + REST + page
  routes), `game.js` (state-machine class with a `PHASES` object), plus `profanity.js`
  and any data/logic files. Mounted in `server.js`; metadata in `games.js`.
- **Client:** `public/<game>/` — `host.html`, `join.html`, `player.html`, `js/{host,join,
  player}.js`, `css/{base,host,player}.css`. Shared UI in `public/shared/` (topbar, modal,
  iris transitions).

---

## When creating a NEW game — reference the existing games first

**Do not invent structure.** Copy the closest existing game and adapt it. For turn-based /
question-style games use **Herd Mind** (`server/herdmind`, `public/herdmind`) as the
template; for real-time games use **Soccer Head** / **Sling Soccer**.

Reuse these patterns verbatim:
- **Three-page flow:** `host` (projection + QR + lobby + view stack), `join` (name entry →
  redirects to `/play`), `player` (mobile controller). Copy the join/lobby flow from an
  existing game — QR via `/api/<game>/qr`, `query:status`, `player:join`/`player:reconnect`,
  host-absent + round-locked overlays, `localStorage` keys `<game>.playerId` etc.
- **One shared Socket.IO server:** never call `new Server(httpServer)` a second time —
  reuse `httpServer._triviaIo` and add your own `.of('/<game>')` namespace, or WebSocket
  upgrades crash the whole app.
- **Host presence grace, inactivity auto-reset, reconnection snapshots** (`host:auth` /
  `player:reconnect` return full current-phase state), and the **6-emoji reactions** system
  (cooldown + host mute) — carry them over.
- Register the game in `games.js` and mount it in `server.js` alongside the others.
- Add the new game to the **Games** list in `README.md` — a section with its emoji/name, a
  one-line pitch, and the numbered how-to-play steps, matching the format of the existing
  entries.

---

## ✅ Scalable UI — lists that grow with player count MUST scroll, never shrink or clip

Any UI that renders one element **per player or per round** (lobby chips, "players ready"
lists, per-round recaps, leaderboards, team lists) has to stay usable at **2 players and at
30+**. Before saying a screen is done, verify it with a large roster.

Rules:
- Items keep their **normal size** — never shrink text or truncate to fit more in.
- The list gets a **height cap + internal scroll**, so overflow scrolls instead of clipping
  or pushing other content off-screen. Keep any header (title/score/progress) pinned.

Recipe (host screens live inside an `overflow: hidden` centered stage):
```css
/* Simple: cap the list and let it scroll */
.some-list {
  display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;
  max-height: min(42vh, 380px);
  overflow-y: auto;
}
/* Header pinned + list absorbs overflow: make the view a fixed-height flex column */
#view-final { align-self: stretch; min-height: 0; }
.final-view { display: flex; flex-direction: column; height: 100%; min-height: 0; max-height: 100%; }
.final-view > *:not(.scroll-region) { flex: 0 0 auto; }   /* header stays */
.scroll-region { flex: 0 1 auto; min-height: 0; overflow-y: auto; }  /* scrolls */
```
**Gotcha:** a `flex: 1` container (e.g. `.host-main`) has default `min-height: auto`, so it
**grows to fit tall content** and defeats the cap. Give such flex ancestors `min-height: 0`.
Always test the scalable view at ~25 players in a wide (TV/laptop) window, confirming the
list scrolls and nothing is clipped top or bottom.

---

## ✅ Dynamic UI — any player/game-driven text MUST handle long & numerous content

Whenever a UI component's contents come from **player input or game state** (names, chat,
answers, guesses, award/tie lists, category labels, scores, joined lists like `A & B & C`,
counts, etc.) — i.e. the value isn't a fixed string you control — you **cannot assume it is
short or singular.** Always design for the worst case: a **maximally long value** (names are
capped but can hit the limit; answers/questions can be long), **many values at once** (every
player tying, a big roster), and **the two combined** (many long values joined together).

Rules:
- **Never let it overflow its container or the screen, and never silently clip/cut off**
  meaningful text. Pick an intentional strategy and apply it every time:
  - **Wrap** long words so they break instead of spilling out — `overflow-wrap: anywhere`
    (or `word-break: break-word`) on the text element, plus `min-width: 0` on the flex/grid
    **item** (flex/grid children default to `min-width: auto`, which refuses to shrink below
    their longest word and forces horizontal overflow).
  - **Scroll** when a region can hold many items — cap its height and `overflow-y: auto`
    (see the scalable-lists section above); vertical growth from wrapped text is then
    absorbed instead of pushing content off-screen.
  - **Ellipsis** only where a single line is truly intended and the full value is available
    elsewhere — `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0`.
    Don't ellipsis-away information the player needs to read.
  - For huge enumerations, prefer a summarised form (`A, B & 4 more`) over an unbounded list.
- This applies to **both host and player screens**, and to inline values (a name inside a
  sentence/heading) as much as to lists.
- **Verify with adversarial data before calling it done:** fill the value(s) to the max
  length, force the largest count (full roster / everyone tied), and confirm nothing
  overflows horizontally, nothing is clipped, and the layout doesn't break — at both small
  (phone) and wide (TV/laptop) viewports.

---

## ✅ Host-screen audio cues on state changes

The Host screen is across the room; people need an **audible cue when the game state
changes so they look up.** Every game must play sounds on notable transitions, e.g.:
- a player joins the lobby (ding),
- game start / countdown,
- a new turn/round/ranker/question begins ("look up!" cue),
- reveal / scoring,
- win vs lose at the end (distinct celebratory vs sad).

Use the existing Web Audio pattern (see any host.js): `getAudioCtx()` + `unlockAudio()`
(called on the Start click and first user gesture), then small oscillator helpers
(`playDing`, a rising arpeggio for new rounds, `playChime`, `playApplause`, `playSad`).
Call them from the host's render/transition functions. Confetti or similar visual flourish
on a big win is a plus.
Please reference the existing games as examples.

---

## ✅ Host screen must NEVER fall asleep

The Host screen sits on a TV/laptop across the room for the whole session, so it must stay
awake. **Every game's `host` page must acquire a screen Wake Lock** (and re-acquire it when
the tab becomes visible again) so the display never dims or sleeps mid-game. Do **not** add
wake locks to player pages — phones should be free to sleep normally.

Use the standard pattern (copy from any existing `host.js`, e.g. `public/trivia/js/host.js`):
```js
let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', function () { wakeLock = null; });
  } catch (e) { wakeLock = null; }
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && wakeLock === null) acquireWakeLock();
});
acquireWakeLock();
// Re-acquire after the first user gesture (some browsers reject the initial request)
document.addEventListener('click', function once() {
  document.removeEventListener('click', once);
  if (wakeLock === null) acquireWakeLock();
});
```
Feature-detect (`'wakeLock' in navigator`) and swallow rejections — the Wake Lock API isn't
universal, so it must degrade silently where unsupported.

---

## Mobile / touch (player pages)

- **Mobile-first & cross-browser:** player pages are used on real phones, so they must be
  fully **mobile-friendly** — responsive layouts (tiny phones → tablets), respect safe-area
  insets, comfortable tap targets, and no horizontal overflow. They must also **work across
  browsers** (Safari/iOS, Chrome, Firefox, Android): use only widely-supported web APIs,
  feature-detect anything newer and provide a fallback, and verify on a narrow viewport
  (not just a desktop window).
- Kill double-tap-zoom with `touch-action: manipulation` on `body.<page> *`; disabled
  buttons need `pointer-events: none` (iOS ignores touch-action on disabled controls).
- **Two-tap confirm** for destructive/final actions (arm → "Tap again to…" → confirm).
  Don't rely on a timed auto-revert to reset the arm if the user might deliberate — cancel
  the arm on a meaningful change instead, or the button feels like it "needs 3 taps".
- `showConfirm`/`showAlert`/`showToast` (shared modal) are **host-only** — player pages
  don't load `modal.js`, so guard with two-tap UX instead.

## CSS gotchas

- `min-height: 0` on `flex: 1` children so they don't grow past the viewport (see above).
- The `[hidden]` attribute loses to any class that sets `display` — add an explicit
  `.thing[hidden] { display: none }` when toggling via `el.hidden`.
- Host lobby: size panels from the grid (equal-height, QR shrinks to fit), never a fixed
  `vh`/`px` height on one panel.
- Static CSS is cached — when verifying a CSS change in the browser, cache-bust the
  stylesheet (`link.href = ...+'?v='+Date.now()`) or it may not reload.

## Testing — always, before claiming done

Test **every change thoroughly** — both **manually** (in the browser: host + a player) and
with **automated tests** (extend the integration harness). Never claim something is done on
code inspection alone.

1. `node -c` every new/changed `.js` (server **and** client). Curl returning 200 does not
   mean the client script parses; also grep for duplicate function names (a hoist collision
   passes `node -c` but silently breaks the page).
2. Add/extend a socket-level integration harness like `scripts/itest-<game>.js` and run it.
3. Verify in the browser (host + a player), including the **scalable view at ~25 players**
   and the **audio cues**. Reconnect each role mid-phase.
4. Clean up afterwards and **return the environment to its normal state**: kill any dev
   server, bots, or watchers you started so the port is free (e.g. `pkill -f "node
   server.js"`), and delete temporary test/bot scripts. **Never leave a server running on
   the app's port** — it blocks the user from starting and testing their own copy locally.

## House style

- Match the other games for consistency: toggles as segmented **On/Off**-style controls,
  reactions, topbar/settings, attribution footer, colour-variable theming per game.
- **Attribution footer** ("Developed by Nick Liu …") only shows on the **join and lobby**
  screens — never during gameplay. Keep it out of the Host match/final views and the player
  controller/eliminated/final views (hide it whenever the active view isn't the lobby/waiting one).
- Only implement what's asked; don't add unrequested features, comments, or docs.
- **Do not create markdown files to document changes** unless explicitly requested.
