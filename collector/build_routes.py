#!/usr/bin/env python3
"""Build the sea routes shown on the Freight globe.

Run once, and again only when ports are added to freight_config.json:

    pip install searoute
    python collector/build_routes.py

It writes app/data/ports.json and one file per origin port in app/data/routes/, holding the
route to every other port along real shipping lanes (the MARNET network used by Eurostat's
SeaRoute). Besides the shortest route, it stores the realistic alternatives: around the Cape of
Good Hope when the shortest route crosses the Red Sea (many carriers still avoid it), and a route
that avoids the Panama Canal when the shortest one uses it.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import searoute as sr

HERE = Path(__file__).resolve().parent
APP = HERE.parent / "app" / "data"
DEFAULT = ["northwest"]
AVOID_RED_SEA = ["northwest", "babalmandab", "suez", "panama"]
AVOID_PANAMA = ["northwest", "panama"]
TOLERANCE = 0.015  # degrees (about 1.5 km); drops only points that do not change the line's shape


def simplify(points: list[list[float]], tol: float) -> list[list[float]]:
    """Douglas-Peucker on lon/lat, enough to keep files small without visible loss on a globe."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = points[a], points[b]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy) or 1e-12
        best, idx = 0.0, None
        for i in range(a + 1, b):
            x, y = points[i]
            d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(points, keep) if k]


def unwrap(points: list[list[float]]) -> list[list[float]]:
    """Keep longitudes continuous across the 180th meridian (Pacific crossings), within -180..540,
    so no segment jumps 360 degrees. The globe draws each segment as a straight lat/lon line."""
    out = []
    for x, y in points:
        x = ((x + 180) % 360) - 180
        if out:
            while x - out[-1][0] > 180:
                x -= 360
            while x - out[-1][0] < -180:
                x += 360
        out.append([x, y])
    return out


def route(o: dict, d: dict, restrictions: list[str]) -> dict | None:
    try:
        r = sr.searoute([o["lon"], o["lat"]], [d["lon"], d["lat"]], units="naut",
                        restrictions=restrictions, return_passages=True)
    except Exception as err:  # an unreachable pair must not stop the build
        print(f"  {o['code']} -> {d['code']}: {err}")
        return None
    # The route runs on the shipping-lane network from the lane point nearest each port. It is not
    # joined to the port by a straight line, which could cut across land (Sohar, Khalifa, Hamad...).
    line = unwrap(r["geometry"]["coordinates"])
    line = [[round(x, 2), round(y, 2)] for x, y in simplify(line, TOLERANCE)]
    return {
        "nm": round(r["properties"]["length"]),
        "via": r["properties"].get("traversed_passages") or [],
        "path": line,
    }


def main() -> None:
    config = json.loads((HERE / "freight_config.json").read_text(encoding="utf-8"))
    ports = config["ports"]
    out_dir = APP / "routes"
    out_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    for o in ports:
        routes = {}
        for d in ports:
            if d["code"] == o["code"]:
                continue
            main_route = route(o, d, DEFAULT)
            if not main_route:
                continue
            alts = []
            if "babalmandab" in main_route["via"] or "suez" in main_route["via"]:
                alt = route(o, d, AVOID_RED_SEA)
                if alt and "south_africa" in alt["via"]:
                    alts.append({"id": "cape", **alt})
            if "panama" in main_route["via"]:
                alt = route(o, d, AVOID_PANAMA)
                if alt and alt["nm"] < main_route["nm"] * 1.8:
                    alts.append({"id": "nopanama", **alt})
            if alts:
                main_route["alts"] = alts
            routes[d["code"]] = main_route
        text = json.dumps(routes, separators=(",", ":"))
        (out_dir / f"{o['code']}.json").write_text(text, encoding="utf-8")
        total += len(text)
        print(f"{o['code']}: {len(routes)} routes, {len(text) // 1024} KB")
    public = [{k: p[k] for k in ("code", "name", "country", "flag", "region", "lon", "lat")}
              | {"focus": bool(p.get("focus")), "research": bool(p.get("research"))} for p in ports]
    static = {"ports": public, "regions": config["regions"], "carbon": config["carbon"], "euEts": config["eu_ets_countries"]}
    (APP / "ports.json").write_text(json.dumps(static, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Done: {len(ports)} ports, {total // 1024} KB of routes")


if __name__ == "__main__":
    main()
