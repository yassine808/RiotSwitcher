# TODO

## In-app "Support" link (PayPal)

Not implemented yet — this is only the plan.

- [ ] **Support entry in the app.** Add a small "Support the project" row to the About/Settings area that opens the PayPal page in the user's browser.
  - Link: `https://paypal.me/<handle>` — exact handle still to be confirmed.
  - Open it through the existing `window.api.openExternal(url)` bridge (`shell:openExternal` in `src/main/index.ts`), never `window.open` from the renderer.
  - Keep it plain: a link and one line of text, no tracking, no auto-open.
- [ ] **Show it on first launch.** After the first launch of a profile has started (not before, so the user sees value first), show a dismissible support card.
  - Store a `SupportPromptDismissed` / `SupportPromptLastShownMs` flag in the config so a dismissal is remembered per install.
  - Never show it while a switch/launch is running or while another modal is open.
- [ ] **Repeat at most once every 2 weeks.** When not dismissed, show again no sooner than 14 days after the last time it was shown.
  - Use the same flag: `now - SupportPromptLastShownMs >= 14 * 24 * 60 * 60 * 1000`.
  - Dismissing ("No thanks") stops it for good; clicking the link does not count as dismissal.
- [ ] Tests: first-launch show, 14-day gate, dismissal persistence, and no prompt during a launch.

Constraints:

- Nothing blocking: no modal over the first-run flow, no browser auto-open.
- PayPal is the only target; the URL must stay on `https://www.paypal.com/` or `https://paypal.me/`.
