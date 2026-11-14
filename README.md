# MBA Radar

Daily management reading, mapped to MBA modules. Each article gets a summary, the theory from each
relevant module applied to it, and an exam-style question.

- `app/` is the web app (installable on iPhone and Mac, no build step). The radar and the Today tab show the
  latest edition. `app/data/articles.json` holds the last 7 days with their full study notes;
  `app/data/archive.json` keeps older articles as links only, for a year. Saved notes stay on the device.
- `collector/collect.py` runs once a day on GitHub Actions. It reads the feeds in `collector/sources.json`,
  asks Claude to choose and analyse the best articles for the modules in `collector/modules.json`,
  and rewrites `app/data/articles.json`.
- `.github/workflows/daily.yml` schedules the collector and publishes the app to GitHub Pages.

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

## Secrets

The collector needs one repository secret, `ANTHROPIC_API_KEY`. It is never stored in the code.
