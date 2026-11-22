# Good Prompts — delivery outcomes

- [x] Build a full-viewport, responsive hero in plain HTML, CSS and vanilla JavaScript with Inter, off-white `#f7f7f5`, near-black text, bracket-and-dash brand mark and a black pill primary CTA with a soft rainbow underglow. Use the supplied Kindred prompt for visual design while replacing its content with the accurate Good Prompts brief.
- [x] Render two reaching hands on a canvas using the exact supplied image URL (with the local `hands.png` sheet as a fallback if it fails to load), dot-matrix scanlines, the supplied grid and luminance algorithm, slow drifting/breathing/rolling and staggered glitch dissolves between poses. Respect reduced-motion preferences and support portrait screens.
- [x] Explain the product in short, plain language: tagline; one-click or Option+Shift+R / Alt+Shift+R rewrite; in-place replacement; visible guesses; clicking again restores the original; and the user presses Send.
- [x] Describe restraint and privacy accurately: no invented facts, bracketed blanks for missing facts, only audience/format/length/tone as editable guesses, no prompt padding or expert openers, clear prompts and short follow-ups untouched, no page access until a click, only the text box read and not conversations or AI answers, and planned non-storage of prompts.
- [x] Provide an honest early-access waitlist with persistent email signup and clear feedback; do not imply Chrome Web Store availability.
- [x] State a working personal build exists, it has not been tested on live sites, the beta is planned to be free and later pricing is undecided; use a clearly marked contact placeholder.
- [x] Avoid invented testimonials, user counts, metrics, partner logos, awards, endorsements and implications of affiliation with AI providers.

## Changes after review (21 Nov 2026)

- [x] Hands load from the supplied remote image. If that image fails to load, the page falls back to `hands.png`, a simpler drawn sheet in the same 2x2 layout that is served by this site. Keep both.
- [x] Added a before-and-after example pop-up, opened from "See an example" under the main button. It is labelled as written by hand.
- [x] Sign-up protection in `server.js`: a hidden trap field (`hp_confirm`), a per-visitor limit and an hourly cap on `/api/waitlist`.
- [x] Added `privacy.html` at `/privacy`, linked from the page, the Privacy pop-up and the waitlist pop-up.
- [x] Small text raised to 11.5px or larger and greys darkened to a contrast of at least 4.5:1.
- [x] The dots now fade out around the words (measured from the page layout), and on portrait screens the hands sit in the gap between the copy and the footer, so dots never cover text.
- [x] Contact email filled in on `public/index.html` and `public/privacy.html`.
- [ ] On Vercel, add a Neon Postgres database (sets `DATABASE_URL`) and confirm a test sign-up is saved.
- [x] Product name set to "Good Prompts" (earlier names: "Promptimizer", then "Senno").
