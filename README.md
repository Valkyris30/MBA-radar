# MBA Radar

Daily management reading, mapped to MBA modules. Each article gets a summary, the theory from each
relevant module applied to it, and an exam-style question.

- `app/` is the web app (installable on iPhone and Mac, no build step). The radar and the Today tab show the
  latest edition. `app/data/articles.json` holds the last 7 days with their full study notes;
  `app/data/archive.json` keeps older articles as links only, for a year. Saved notes stay on the device.
- `collector/collect.py` runs once a day on GitHub Actions. It reads the feeds in `collector/sources.json`,
  asks Claude to choose and analyse the best articles for the modules in `collector/modules.json`,
  and rewrites `app/data/articles.json`.
- `collector/maritime.py` writes the Maritime desk: a morning brief for forwarders, shipping agents and
  importers, and a briefing note per story, placed on the countries in `collector/maritime_config.json`
  (focus markets: Morocco, the UK, Spain, France and the Netherlands get 60% of the 20 daily notes). The 101 sources are in
  `collector/maritime_sources.json`; `"filter": true` keeps only items about ports, shipping, customs or
  trade from general news sites. Output: `app/data/maritime.json` and `app/data/maritime-archive.json`.
- `collector/freight.py` feeds the Freight desk (`app/freight.js`): a 3D globe with the sea route and a ship
  sailing it, and an indicative cost per container. Each morning it reads the public indices (Freightos FBX,
  Xeneta XSI-C, Drewry WCI) and exchange rates, then has Claude search the web, on a rotation, for what no
  free index covers: other lanes, terminal handling charges at the main ports, and carriers' announced
  surcharges. Every figure keeps its source. Ports, lanes, carriers and container factors are in
  `collector/freight_config.json`; sea routes are built once with `collector/build_routes.py` (needs
  `pip install searoute`). Research volume: repository variables `FREIGHT_LANES_PER_DAY`,
  `FREIGHT_PORTS_PER_DAY`, `FREIGHT_CARRIERS_PER_DAY` (about $0.01 per web search). The app lists only port
  pairs with a rate; ports without a researched tariff show an approximation averaged from researched ports
  nearby. It also shows Brent (US EIA) and the EU carbon allowance price (EEX auctions), and each voyage's
  CO2e per container from the GLEC Framework v3.1 trade-lane intensities, with the EU ETS cost.
- `.github/workflows/daily.yml` runs the three collectors each morning and publishes the app to GitHub Pages.

## Change what the app covers

- **Modules and theories:** edit `collector/modules.json`. `focus` is what Claude reads to judge relevance,
  and `theories` is the list it draws on first when it applies theory to an article, so replace both with
  what your course actually teaches.
- **The module you are studying now:** put `"current": true` on one module in `collector/modules.json`.
  It gets 40% of each edition (repository variable `MBA_RADAR_FOCUS_SHARE`), every other note looks for
  a link to it, and the app marks it "studying now". Give it `units` (the course outline) and the notes
  will say which unit each theory belongs to. Move the flag when you start the next module.
- **Sources:** edit `collector/sources.json`. `"lean"` names the module a source mostly serves. Set `"read_page": false` for subscriber-only sites, so only
  the public abstract from the feed is used.
- **Articles per day and model:** repository variables `MBA_RADAR_MAX_NEW` (default 10) and
  `MBA_RADAR_MODEL` (default `claude-haiku-5-5`).
- **Full text first:** the collector tries three times as many articles as it publishes and uses the
  ones it can read in full first. At most 3 notes per edition come from an abstract alone, unless
  there are not enough full-text articles that day.

## Run it yourself

Preview the app locally:

```bash
ruby -run -e httpd app -p 8123
```

Check the feeds without calling the API:

```bash
python3 collector/collect.py --dry-run
```

## Pause the collection

Daily collection is paused: the `schedule` lines in `.github/workflows/daily.yml` are commented
out, so no API credits are used. A push still republishes the app. To resume, remove the `#` on
those two lines and push, or click "Run workflow" once for a single edition.

## Secrets

The collector needs two repository secrets. Neither is ever stored in the code.

- `ANTHROPIC_API_KEY`: writes the notes and runs the freight research.
- `APP_KEY`: the device key (32 random bytes, base64url). Without it the workflow stops.

## Private access

The app's data files (`articles`, `archive`, `maritime`, `maritime-archive`, `freight`) are
compressed and encrypted with AES-256-GCM (`collector/vault.py`) before they are committed or
published. The public site and repository only hold ciphertext; the page itself shows a lock screen.

A device opens the app once its owner pastes the device key on the lock screen. The key stays in
that device's storage and is never sent anywhere. On an iPhone, the Home Screen app and Safari keep
separate storage, so paste the key inside the Home Screen app.

- **Key file:** `.private/device-key.txt` on the Mac that set this up (ignored by Git).
- **Change the key** (for example if it leaks): run `python3 collector/vault.py new-key`, put the new
  value in the `APP_KEY` secret and in the key file, then run the workflow once. The collector can
  no longer open the old files, so restore them first with `APP_KEY=<old key> python3
  collector/vault.py open FILE` or let the archives start again. Every device then asks for the new key.
- **Read a file locally:** `APP_KEY=<key> python3 collector/vault.py open app/data/freight.json`
  (needs `pip install cryptography`).
- Static files stay readable: `ports.json` and the sea routes hold no edition content.
- Editions published before the lock remain in the Git history.
