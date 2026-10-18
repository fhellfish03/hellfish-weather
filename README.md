# HellFish Weather

Personal weather app for Fort Oglethorpe, Clearwater and Queen Creek.

- `index.html` is the whole app. Open the GitHub Pages address on your phone and use Chrome's **Install app** or **Add to Home screen**.
- `.github/workflows/record.yml` runs `scripts/record.mjs` every 3 hours. It saves each morning's forecast, what actually happened (high and low from the KCHA, KPIE and KIWA airport stations), rain, Fort Oglethorpe soil temperature, and the hurricane center storm list into `data/`.
- The app reads `data/` for the Records card (forecast scorecard and season log) and the Tropics card.

To update the app, replace `index.html` and commit. Don't edit files in `data/` by hand; the recorder owns them.
