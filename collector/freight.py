#!/usr/bin/env python3
"""MBA Radar, freight desk.

Runs once a day after the other collectors (GitHub Actions) and writes app/data/freight.json:

  * public container freight indices, read every day straight from the publishers' pages:
    Freightos Baltic Index (FBX, daily), Xeneta Shipping Index (XSI-C, daily) and
    Drewry World Container Index (WCI, weekly);
  * exchange rates (open.er-api.com, daily);
  * market prices: Brent crude (US Energy Information Administration, daily spot) and the EU carbon
    allowance (EEX primary auction results, each auction day), for the voyage's carbon cost;
  * web research by Claude, on a rotation, for what no free index covers: spot rates on other
    lanes (Asia to the Gulf, Morocco to North Europe...), terminal handling charges at each port,
    and the surcharges and rate increases each carrier has announced. Every figure keeps the
    pages it came from; nothing is estimated.

    python collector/freight.py            # full run, needs ANTHROPIC_API_KEY
    python collector/freight.py --dry-run  # indices and exchange rates only, no API call, nothing written

Settings (environment variables, all optional):
    MBA_RADAR_MODEL          model for extraction                       (default claude-haiku-5-5)
    FREIGHT_RESEARCH_MODEL   model that searches the web                (default: same as MBA_RADAR_MODEL)
    FREIGHT_LANES_PER_DAY    lanes researched per run                   (default 2)
    FREIGHT_PORTS_PER_DAY    ports researched per run                   (default 3)
    FREIGHT_CARRIERS_PER_DAY carriers researched per run                (default 1)
    FREIGHT_MAX_SEARCHES     web searches allowed per research question (default 3)
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import io
import json
import os
import re
import sys
import zipfile
from pathlib import Path

import collect as base

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent / "app" / "data" / "freight.json"

MODEL = base.MODEL
RESEARCH_MODEL = os.environ.get("FREIGHT_RESEARCH_MODEL") or MODEL
LANES_PER_DAY = int(os.environ.get("FREIGHT_LANES_PER_DAY", "2"))
PORTS_PER_DAY = int(os.environ.get("FREIGHT_PORTS_PER_DAY", "3"))
CARRIERS_PER_DAY = int(os.environ.get("FREIGHT_CARRIERS_PER_DAY", "1"))
MAX_SEARCHES = int(os.environ.get("FREIGHT_MAX_SEARCHES", "3"))
WEB_SEARCH_PRICE = 0.01   # USD per search, for the cost line in the log

# Models that take the newer web search tool; the others use the basic version.
DYNAMIC_SEARCH_MODELS = ("claude-fable", "claude-mythos", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7",
                         "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6")

log = base.log
clean = base.clean
UTC = base.UTC

FBX_URL = "https://fbx.freightos.com/"
XSI_URL = "https://www.xeneta.com/xsi"
WCI_URL = "https://www.drewry.co.uk/supply-chain-advisors/supply-chain-expertise/world-container-index-assessed-by-drewry"
FX_URL = "https://open.er-api.com/v6/latest/USD"
BRENT_URL = "https://www.eia.gov/dnav/pet/hist/RBRTED.htm"
EUA_PAGE = "https://www.eex.com/en/market-data/environmental-markets/eua-primary-auction-spot-download"
EUA_REPORT = "https://public.eex-group.com/eex/eua-auction-report/emission-spot-primary-market-auction-report-{year}-data.xlsx"

XSI_LANES = {
    "Far East → N. Europe": ("FE", "NEU"), "N. Europe → Far East": ("NEU", "FE"),
    "Far East → US West Coast": ("FE", "USWC"), "US West Coast → Far East": ("USWC", "FE"),
    "N. Europe → US East Coast": ("NEU", "USEC"), "US East Coast → N. Europe": ("USEC", "NEU"),
    "Far East → S. America East Coast": ("FE", "SAEC"), "N. Europe → S. America East Coast": ("NEU", "SAEC"),
}
WCI_LANES = {
    "shanghai-rotterdam": ("FE", "NEU"), "rotterdam-shanghai": ("NEU", "FE"),
    "shanghai-genoa": ("FE", "MED"), "genoa-shanghai": ("MED", "FE"),
    "shanghai-los angeles": ("FE", "USWC"), "los angeles-shanghai": ("USWC", "FE"),
    "shanghai-new york": ("FE", "USEC"), "new york-rotterdam": ("USEC", "NEU"), "rotterdam-new york": ("NEU", "USEC"),
}


def iso(d: dt.datetime) -> str:
    return d.isoformat().replace("+00:00", "Z")


def page_lines(url: str) -> list[str]:
    status, body, charset = base.http_get(url)
    if status != 200 or not body:
        log(f"  {url} returned {status}")
        return []
    text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", body.decode(charset, "replace"), flags=re.S | re.I)
    text = html.unescape(re.sub(r"<[^>]+>", "\n", text))
    return [line.strip() for line in text.splitlines() if line.strip()]


def money(text: str) -> float | None:
    m = re.search(r"\$\s?([\d,]+(?:\.\d+)?)", text or "")
    return float(m.group(1).replace(",", "")) if m else None


def pct(text: str) -> float | None:
    m = re.search(r"([↑↓+\-—]?)\s*([\d.]+)%", text or "")
    if not m:
        return None
    sign = -1 if m.group(1) in ("↓", "-") else 1
    return round(sign * float(m.group(2)), 2)


# ── Public indices ──────────────────────────────────────────────────────────

def fetch_fx() -> dict | None:
    status, body, _ = base.http_get(FX_URL)
    try:
        data = json.loads(body) if status == 200 else {}
    except json.JSONDecodeError:
        data = {}
    if data.get("result") != "success":
        log("  exchange rates unavailable")
        return None
    return {"base": "USD", "date": data.get("time_last_update_utc", ""), "rates": data.get("rates", {}),
            "source": "https://www.exchangerate-api.com"}


def fetch_fbx(config: dict, today: str) -> list[dict]:
    """The FBX page embeds the latest value of each lane as {"label":"FBX11","value":"$3,374","change":"-0.96%"}."""
    status, body, charset = base.http_get(FBX_URL)
    if status != 200:
        log(f"  FBX page returned {status}")
        return []
    text = body.decode(charset, "replace")
    out = []
    for label, value, change in re.findall(r'"label":"(FBX\d\d)","value":"([^"]+)","change":"([^"]*)"', text):
        lane = config["index_lanes"].get(label)
        v = money(value)
        if lane and v:
            out.append({"from": lane[0], "to": lane[1], "source": f"Freightos Baltic Index {label}", "value": v,
                        "unit": "FEU", "change": pct(change), "changePeriod": "vs previous release", "date": today, "url": FBX_URL})
    log(f"  FBX: {len(out)} lanes")
    return out


def fetch_xsi() -> list[dict]:
    lines = page_lines(XSI_URL)
    out = []
    try:
        start = next(i for i, l in enumerate(lines) if l.startswith("XSI-C trade lane prices"))
    except StopIteration:
        log("  XSI: table not found")
        return out
    date = lines[start + 1] if start + 1 < len(lines) else ""
    i = start
    while i < min(len(lines), start + 120):
        lane = XSI_LANES.get(lines[i])
        if lane and i + 5 < len(lines) and lines[i + 2].startswith("$"):
            out.append({"from": lane[0], "to": lane[1], "source": f"Xeneta XSI-C {lines[i]}", "value": money(lines[i + 2]),
                        "unit": "FEU", "change": pct(lines[i + 4]), "changePeriod": "7 days", "date": date, "url": XSI_URL})
            i += 6
        else:
            i += 1
    log(f"  XSI: {len(out)} lanes ({date})")
    return out


WCI_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["assessment_date", "composite", "lanes", "outlook"],
    "properties": {
        "assessment_date": {"type": "string"},
        "composite": {"type": "number"},
        "lanes": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["route", "usd_per_40ft", "change_pct"],
            "properties": {
                "route": {"type": "string", "enum": sorted(WCI_LANES)},
                "usd_per_40ft": {"type": "number"},
                "change_pct": {"type": "number"},
            }}},
        "outlook": {"type": "string"},
    },
}


def fetch_wci(claude) -> tuple[list[dict], dict | None]:
    """Drewry publishes the WCI as a written assessment; Claude reads the figures out of it."""
    lines = page_lines(WCI_URL)
    try:
        start = next(i for i, l in enumerate(lines) if l.startswith("World Container Index -"))
    except StopIteration:
        log("  WCI: assessment not found")
        return [], None
    text = "\n".join(lines[start:start + 80])[:12000]
    answer = claude.ask(
        "You extract figures from Drewry's weekly World Container Index assessment. Use only numbers stated in the "
        "text. Include a route only when the text gives its rate in US$ per 40ft; the change is the week-on-week "
        "percentage, negative for a fall and 0 when unchanged. The outlook is one or two sentences paraphrasing "
        "what Drewry expects next, including any surcharges it mentions.",
        f"<assessment>\n{text}\n</assessment>", WCI_SCHEMA, "low")
    if not answer:
        return [], None
    out = [{"from": WCI_LANES[l["route"]][0], "to": WCI_LANES[l["route"]][1],
            "source": f"Drewry WCI {l['route'].title().replace('-', ' to ')}", "value": round(l["usd_per_40ft"]),
            "unit": "FEU", "change": round(l["change_pct"], 1), "changePeriod": "1 week",
            "date": clean(answer["assessment_date"], 40), "url": WCI_URL}
           for l in answer.get("lanes", []) if l.get("route") in WCI_LANES and 50 <= l.get("usd_per_40ft", 0) <= 40000]
    summary = {"date": clean(answer["assessment_date"], 40), "composite": answer.get("composite"),
               "outlook": clean(answer.get("outlook"), 600), "url": WCI_URL}
    log(f"  WCI: {len(out)} lanes ({summary['date']})")
    return out, summary


# ── Market prices ───────────────────────────────────────────────────────────

MONTHS = {m: i for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def fetch_brent() -> dict | None:
    """Daily Brent spot price, from the EIA weekly table (one row per week, Monday to Friday)."""
    status, body, charset = base.http_get(BRENT_URL)
    if status != 200:
        log(f"  Brent: EIA returned {status}")
        return None
    text = body.decode(charset, "replace")
    days = []
    for label, cells in re.findall(r"<td class='B6'>\s*([^<]+?)\s*</td>(.*?)</tr>", text, re.S):
        m = re.search(r"(\d{4})\s+([A-Z][a-z]{2})-\s*(\d+)", html.unescape(label).replace("\xa0", " "))
        if not m:
            continue
        start = dt.date(int(m.group(1)), MONTHS[m.group(2)], int(m.group(3)))
        values = re.findall(r"<td class='B3'>([^<]*)</td>", cells)
        for i, v in enumerate(values):
            v = html.unescape(v).replace("\xa0", "").strip()
            if v:
                days.append((start + dt.timedelta(days=i), float(v)))
    if not days:
        log("  Brent: no figure found")
        return None
    (date, price), prev = days[-1], days[-2][1] if len(days) > 1 else None
    log(f"  Brent: ${price} on {date}")
    return {"name": "Brent crude, spot", "value": price, "unit": "USD/bbl", "date": date.isoformat(),
            "change": round((price / prev - 1) * 100, 2) if prev else None, "source": "US EIA", "url": BRENT_URL}


def fetch_eua(year: int) -> dict | None:
    """EU carbon allowance price: the clearing price of the latest EEX primary auction."""
    for y in (year, year - 1):
        url = EUA_REPORT.format(year=y)
        status, body, _ = base.http_get(url, limit=20_000_000)
        if status == 200 and body[:2] == b"PK":
            break
    else:
        log("  EUA: auction report unavailable")
        return None
    try:
        z = zipfile.ZipFile(io.BytesIO(body))
        shared = [re.sub(r"<[^>]+>", "", x) for x in re.findall(r"<si>(.*?)</si>", z.read("xl/sharedStrings.xml").decode("utf-8"), re.S)]
        sheet = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
    except (zipfile.BadZipFile, KeyError) as err:
        log(f"  EUA: report could not be read ({err})")
        return None
    auctions = []
    for row in re.findall(r"<row[^>]*>(.*?)</row>", sheet, re.S):
        cells = {}
        for col, kind, val in re.findall(r'<c r="([A-Z]+)\d+"([^>]*)>(?:<f>.*?</f>)?<v>([^<]*)</v>', row):
            cells[col] = shared[int(val)] if 't="s"' in kind else val
        try:
            if cells.get("F") == "successful" and cells.get("G"):
                auctions.append((dt.date(1899, 12, 30) + dt.timedelta(days=int(float(cells["B"]))), float(cells["G"])))
        except ValueError:
            continue
    if not auctions:
        log("  EUA: no auction found")
        return None
    auctions.sort()
    (date, price), prev = auctions[-1], auctions[-2][1] if len(auctions) > 1 else None
    log(f"  EUA: €{price}/t on {date}")
    return {"name": "EU carbon allowance (EUA)", "value": price, "unit": "EUR/tCO2", "date": date.isoformat(),
            "change": round((price / prev - 1) * 100, 2) if prev else None, "source": "EEX primary auction", "url": EUA_PAGE}


# ── Web research ────────────────────────────────────────────────────────────

RESEARCH_SYSTEM = """You research container shipping costs for freight forwarders and importers. Today is {today}. \
Search the web for the figures asked for, preferring official carrier, terminal and port tariff pages and recent \
trade press, and read what the pages actually say. Report only figures you found, with the page each came from and \
the date it applies to; prefer figures from the last three months and say how old each one is. If you cannot find a \
figure, say so plainly. Never estimate, extrapolate or fill a gap from general knowledge."""

EXTRACT_SYSTEM = """You turn a research note into structured data. Use only figures stated in the note, keep their \
currency and unit, and leave a field null when the note does not give it. Sources must be copied from the list of \
pages the research used; never add another URL. Write in plain British English."""

NUM = {"anyOf": [{"type": "number"}, {"type": "null"}]}
STR = {"type": "string"}


def obj(**props) -> dict:
    return {"type": "object", "additionalProperties": False, "required": list(props), "properties": props}


LANE_SCHEMA = obj(found={"type": "boolean"}, low=NUM, high=NUM, unit={"type": "string", "enum": ["TEU", "FEU"]},
                  currency=STR, as_of=STR, basis=STR, sources={"type": "array", "items": STR}, notes=STR)
PORT_SCHEMA = obj(
    found={"type": "boolean"}, currency=STR,
    thc_export_20=NUM, thc_export_40=NUM, thc_import_20=NUM, thc_import_40=NUM,
    other_charges={"type": "array", "items": obj(name=STR, amount=NUM, currency=STR, per=STR,
                                                   applies={"type": "string", "enum": ["export", "import", "both"]})},
    free_days=NUM, storage_per_day_20=NUM, storage_per_day_40=NUM,
    tariff_of=STR, effective=STR, sources={"type": "array", "items": STR}, notes=STR)
CARRIER_SCHEMA = obj(
    items={"type": "array", "items": obj(kind={"type": "string", "enum": ["GRI", "PSS", "surcharge", "other"]},
                                          name=STR, amount=STR, trades=STR, effective=STR)},
    summary=STR, sources={"type": "array", "items": STR})


def search_tool(max_uses: int) -> dict:
    kind = "web_search_20260209" if RESEARCH_MODEL.startswith(DYNAMIC_SEARCH_MODELS) else "web_search_20250305"
    return {"type": kind, "name": "web_search", "max_uses": max_uses}


class Researcher:
    def __init__(self, claude: base.Claude, today: str) -> None:
        self.claude = claude
        self.today = today
        self.searches = 0
        self.disabled = False

    def ask(self, question: str, schema: dict, searches: int = MAX_SEARCHES) -> dict | None:
        """Search the web, then extract structured figures from what was found."""
        if self.disabled:
            return None
        sdk, client = self.claude.sdk, self.claude.client
        messages = [{"role": "user", "content": question}]
        sources: dict[str, str] = {}
        texts: list[str] = []
        try:
            for _ in range(4):   # a server-side search loop can pause; resume it a few times at most
                response = client.messages.create(
                    model=RESEARCH_MODEL, max_tokens=8000, output_config={"effort": "medium"},
                    system=RESEARCH_SYSTEM.format(today=self.today), tools=[search_tool(searches)], messages=messages)
                usage = response.usage
                self.claude.tokens_in += usage.input_tokens or 0
                self.claude.tokens_out += usage.output_tokens or 0
                stu = getattr(usage, "server_tool_use", None)
                self.searches += getattr(stu, "web_search_requests", 0) or 0
                for block in response.content:
                    if block.type == "web_search_tool_result" and isinstance(block.content, list):
                        for r in block.content:
                            if getattr(r, "url", None):
                                sources.setdefault(r.url, getattr(r, "title", "") or r.url)
                    elif block.type == "text":
                        texts.append(block.text)
                if response.stop_reason == "pause_turn":
                    messages = [messages[0], {"role": "assistant", "content": response.content}]
                    continue
                if response.stop_reason == "refusal":
                    log("    research declined by the model")
                    return None
                break
        except sdk.BadRequestError as err:
            log(f"    web research is not available with {RESEARCH_MODEL} ({err.message}); skipping research this run")
            self.disabled = True
            return None
        except (sdk.APIStatusError, sdk.APIConnectionError) as err:
            log(f"    research request failed ({err}); skipping this item")
            return None

        note = "\n".join(texts).strip()
        if not note:
            return None
        listing = "\n".join(f"- {u} ({t})" for u, t in list(sources.items())[:30])
        data = self.claude.ask(EXTRACT_SYSTEM, f"Research note:\n{note}\n\nPages the research used:\n{listing or '- none'}",
                               schema, "low")
        if not data:
            return None
        data["sources"] = [{"url": u, "title": clean(sources[u], 120)} for u in data.get("sources", []) if u in sources][:5]
        return data


def stalest(keys: list[str], done: dict, count: int) -> list[str]:
    """Items never researched first, then the ones checked longest ago."""
    return sorted(keys, key=lambda k: (done.get(k) or {}).get("checkedAt", ""))[:max(0, count)]


def research_lane(r: Researcher, lane: dict, regions: dict) -> dict | None:
    q = (f"What is the recent spot ocean freight rate for a dry container from {regions[lane['from']]['name']} "
         f"to {regions[lane['to']]['name']} ({lane['hint']})? Look for weekly freight index reports (for example SCFI, "
         "CCFI, Drewry, Xeneta or Freightos market updates), trade press rate reports, forwarder market updates and carrier "
         "FAK or rate announcements from the last three months. A rate quoted for a nearby port on the same trade counts; "
         "say which port it is. Give the rate or range per 20ft or per 40ft in US dollars, its source and the date.")
    data = r.ask(q, LANE_SCHEMA, searches=max(MAX_SEARCHES, 5))
    if not data or not data.get("found") or not data.get("sources"):
        return {"found": False}
    for k in ("low", "high"):
        if data.get(k) is not None and not 30 <= data[k] <= 30000:
            data[k] = None
    if data.get("low") is None and data.get("high") is None:
        return {"found": False}
    return {k: data[k] for k in ("found", "low", "high", "unit", "currency", "as_of", "basis", "sources", "notes")}


def research_port(r: Researcher, port: dict) -> dict | None:
    q = (f"What are the current terminal handling charges (THC) for containers at the port of {port['name']} "
         f"({port['country']}, UN/LOCODE {port['code']}), for export and for import, per 20ft and per 40ft dry "
         "container, as published in a major carrier's local charges tariff or by the terminal? Also list other "
         "standard local charges a shipper or consignee pays there (for example ISPS security, documentation or bill "
         "of lading fees, port or infrastructure fees, EU ETS surcharges), and the daily storage or demurrage charge per "
         "container once the free days at the terminal are used up, with the number of free days. Give amounts, currency "
         "and the date they apply from.")
    data = r.ask(q, PORT_SCHEMA)
    if not data or not data.get("found") or not data.get("sources"):
        return {"found": False}
    keep = ("found", "currency", "thc_export_20", "thc_export_40", "thc_import_20", "thc_import_40",
            "free_days", "storage_per_day_20", "storage_per_day_40", "other_charges", "tariff_of", "effective", "sources", "notes")
    data["other_charges"] = [c for c in data.get("other_charges", []) if c.get("name") and c.get("amount") is not None][:8]
    return {k: data.get(k) for k in keep}


def research_carrier(r: Researcher, carrier: dict) -> dict | None:
    q = (f"What general rate increases (GRI), peak season surcharges (PSS) and other surcharges has {carrier['name']} "
         "announced for container shipping in the last six weeks or for the coming weeks, especially on Asia–Europe, "
         "Asia–Mediterranean, Europe–Middle East, North Africa and Morocco trades? Give amounts, trades and effective dates.")
    data = r.ask(q, CARRIER_SCHEMA)
    if not data or not data.get("sources"):
        return {"found": False}
    def real(v) -> bool:
        return bool(v) and str(v).strip().lower() not in ("null", "none", "n/a", "not stated")
    items = [{k: (v if real(v) else "") for k, v in i.items()} for i in data.get("items", []) if real(i.get("amount")) or real(i.get("name"))]
    return {"found": bool(items), "items": items[:10],
            "summary": clean(data.get("summary"), 600), "sources": data["sources"]}


# ── Main ────────────────────────────────────────────────────────────────────

def main() -> int:
    args = argparse.ArgumentParser(description="Collect today's freight indices and research.")
    args.add_argument("--dry-run", action="store_true", help="read indices and exchange rates only; no API call, nothing written")
    opts = args.parse_args()

    config = json.loads((HERE / "freight_config.json").read_text(encoding="utf-8"))
    now = dt.datetime.now(UTC).replace(microsecond=0)
    today = now.strftime("%d %b %Y")
    previous = base.load(OUTPUT)

    log("Reading public freight indices")
    fx = fetch_fx() or previous.get("fx")
    indices = fetch_fbx(config, today) + fetch_xsi()
    markets = {"brent": fetch_brent() or (previous.get("markets") or {}).get("brent"),
               "eua": fetch_eua(now.year) or (previous.get("markets") or {}).get("eua")}

    if opts.dry_run:
        for x in indices:
            log(f"  {x['from']:>4} > {x['to']:<4} {x['value']:>8,.0f} USD/FEU  {x['source']} ({x['date']})")
        log(f"  FX: {len((fx or {}).get('rates', {}))} currencies")
        log(f"  Markets: {json.dumps(markets)[:300]}")
        log("Dry run finished. Drewry WCI and web research need the API; nothing was written.")
        return 0

    if not os.environ.get("ANTHROPIC_API_KEY") and not os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        sys.exit("ANTHROPIC_API_KEY is not set. Add it as a repository secret (see README).")

    claude = base.Claude()
    wci, wci_summary = fetch_wci(claude)
    indices += wci
    if not indices:   # every publisher page failed: keep yesterday's figures rather than show nothing
        indices = previous.get("indices", [])
        log("  no index could be read today; keeping the previous figures")

    # Research on a rotation, stalest first. A first run does more to fill the tables quickly.
    research = previous.get("research") or {"lanes": {}, "ports": {}, "carriers": {}}
    lane_keys = [f"{l['from']}>{l['to']}" for l in config["research_lanes"]]
    port_keys = [p["code"] for p in config["ports"] if p.get("research")]
    carrier_keys = [c["id"] for c in config["carriers"]]
    filled = sum(len(research.get(k, {})) for k in ("lanes", "ports", "carriers"))
    boost = 3 if filled < (len(lane_keys) + len(port_keys) + len(carrier_keys)) / 3 else 1
    if boost > 1:
        log("  research tables are mostly empty: doing a larger first batch")

    r = Researcher(claude, today)
    lanes_by_key = {f"{l['from']}>{l['to']}": l for l in config["research_lanes"]}
    ports_by_code = {p["code"]: p for p in config["ports"]}
    carriers_by_id = {c["id"]: c for c in config["carriers"]}
    for key in stalest(lane_keys, research["lanes"], LANES_PER_DAY * boost):
        log(f"  researching lane {key}")
        found = research_lane(r, lanes_by_key[key], config["regions"])
        if found is not None:
            research["lanes"][key] = {**found, "checkedAt": iso(now)}
    for code in stalest(port_keys, research["ports"], PORTS_PER_DAY * boost):
        log(f"  researching port charges at {ports_by_code[code]['name']}")
        found = research_port(r, ports_by_code[code])
        if found is not None:
            research["ports"][code] = {**found, "checkedAt": iso(now)}
    for cid in stalest(carrier_keys, research["carriers"], CARRIERS_PER_DAY * boost):
        log(f"  researching surcharges announced by {carriers_by_id[cid]['name']}")
        found = research_carrier(r, carriers_by_id[cid])
        if found is not None:
            research["carriers"][cid] = {**found, "checkedAt": iso(now)}

    base.save(OUTPUT, {
        "version": 1,
        "generatedAt": iso(now),
        "model": MODEL,
        "fx": fx,
        "markets": markets,

        "indices": indices,
        "wci": wci_summary or previous.get("wci"),
        "containers": config["containers"],
        "carriers": config["carriers"],
        "researchLanes": [{"from": l["from"], "to": l["to"]} for l in config["research_lanes"]],
        "research": research,
    })
    log(f"Freight data saved: {len(indices)} index lanes, {r.searches} web searches "
        f"(about ${r.searches * WEB_SEARCH_PRICE:.2f}). API use: {claude.cost()}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
