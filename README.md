# MBA Radar

Daily management reading, mapped to MBA modules. Each article gets a summary, the theory from each
relevant module applied to it, and an exam-style question.

- `app/` is the web app (installable on iPhone and Mac, no build step). It displays `app/data/articles.json`.
- `collector/collect.py` runs once a day on GitHub Actions. It reads the feeds in `collector/sources.json`,
  asks Claude to choose and analyse the best articles for the modules in `collector/modules.json`,
  and rewrites `app/data/articles.json`.
- `.github/workflows/daily.yml` schedules the collector and publishes the app to GitHub Pages.

## Change what the app covers

- **Modules:** edit `collector/modules.json`. `focus` is what Claude reads to judge relevance, so describe
  the topics and theories your course actually teaches.
- **Sources:** edit `collector/sources.json`. Set `"read_page": false` for subscriber-only sites, so only
  the public abstract from the feed is used.
- **Articles per day and model:** repository variables `MBA_RADAR_MAX_NEW` (default 10) and
  `MBA_RADAR_MODEL` (default `claude-haiku-5-5`).

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
