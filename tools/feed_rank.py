#!/usr/bin/env python3
"""Rank a job feed against a candidate profile - deterministic, offline, stdlib.

A cheap first pass before `/rank`: `/rank` runs a scoring agent per posting
and is the real fit judgment, but it costs a model call each. This scores a
few hundred postings in a second so `/rank` (or a human) starts from the top
of the list instead of the middle.

Inputs (any mix, deduplicated by URL):
  --feed <file>      ats-boards-search JSON ({"meta":..., "results":[...]}),
                     e.g. job_scraper/feed/latest.json from the job-feed workflow
  --jobs-dir <dir>   a directory of one-posting-per-file JSON objects with
                     title/company/location/url/description and posted_at|date
  --profile <file>   candidate profile JSON: {"skills": {group: [skill, ...]},
                     "experience": [{"title", "start": "YYYY-MM", "end"}],
                     optional "years_experience" and "off_track" (title regex)}
                     Keep it outside the repo (or gitignored) - it is personal.

Output: JSON {"generated", "candidate_years", "jobs": [...]} sorted best first.

Scoring (0-100):
  skills   = (0.6 * matched/named + 0.4 * min(matched, 8)/8) * min(named, 4)/4
             over the technologies the posting names that the profile vocabulary
             knows - a posting naming one skill carries no signal
  then     - 15 when the title is outside the candidate's track (off_track)
           - capped recency deduction (0 / 3 / 7 / 12 / 18 points by age)
           - 25 when the title is above the candidate's level
           - 10 per year the stated requirement exceeds the candidate by more than 2
  verdict  "blocked" on a hard knockout (clearance, citizenship, PhD, a 3+ year
           experience gap), else strong >= 65, good >= 50, stretch below.

US-remote postings that require US work authorization are flagged, not blocked:
only the candidate knows their status.
"""

import argparse
import json
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

# Canonical skill -> regex alternatives. Matching is on word boundaries over the
# posting's description and title. Profiles name skills in lower case; a profile
# skill not in this table matches by its literal text.
VOCAB = {
    "python": r"python", "java": r"java(?!\s*script)", "go": r"golang|\bgo\b(?=[\s,/)])",
    "typescript": r"typescript", "javascript": r"javascript|\bjs\b", "sql": r"sql",
    "bash": r"bash|shell scripting", "c++": r"c\+\+", "rust": r"rust", "kotlin": r"kotlin",
    "scala": r"scala", "ruby": r"ruby", "c#": r"c#|\.net",
    "aws": r"aws|amazon web services", "gcp": r"gcp|google cloud", "azure": r"azure",
    "terraform": r"terraform", "lambda": r"lambda", "s3": r"\bs3\b", "dynamodb": r"dynamodb",
    "kms": r"\bkms\b", "iam": r"\biam\b", "bedrock": r"bedrock", "athena": r"athena",
    "docker": r"docker|container", "kubernetes": r"kubernetes|\bk8s\b|\beks\b|\bgke\b|\baks\b",
    "ci/cd": r"ci/cd|continuous integration|continuous delivery|ci pipelines?",
    "github actions": r"github actions", "jenkins": r"jenkins", "linux": r"linux",
    "spring boot": r"spring boot|spring", "react": r"react", "node.js": r"node\.?js|\bnode\b",
    "fastapi": r"fastapi", "spark": r"spark", "kafka": r"kafka", "postgresql": r"postgres",
    "elasticsearch": r"elasticsearch|opensearch", "redis": r"redis", "graphql": r"graphql",
    "grpc": r"grpc", "microservices": r"microservices?", "rest": r"rest(ful)?\s+api|rest\b",
    "distributed systems": r"distributed systems?", "system design": r"system design",
    "security": r"security", "observability": r"observability|monitoring",
    "datadog": r"datadog", "splunk": r"splunk", "llm": r"\bllms?\b|large language model|generative ai|genai",
    "machine learning": r"machine learning|\bml\b", "agents": r"agentic|ai agents?",
    "infrastructure as code": r"infrastructure[- ]as[- ]code|\biac\b",
    "fintech": r"fintech|payments?|banking|fraud",
}

_HARD = [
    (re.compile(r"\b(?:security|secret)\s+clearance\b|\btop\s*secret\b|\bTS/SCI\b", re.I), "requires a security clearance"),
    (re.compile(r"\bU\.?S\.?\s+citizen(?:ship)?\s+(?:is\s+)?(?:required|only)\b|\bmust be a U\.?S\.? citizen\b", re.I), "requires US citizenship"),
    (re.compile(r"\bPh\.?D\.?\s+(?:is\s+)?required\b|\brequires?\s+a\s+Ph\.?D\b", re.I), "requires a PhD"),
]
_US_AUTH = re.compile(
    r"authori[sz]ed to work in the (?:U\.?S\.?|United States)|"
    r"(?:must|need to) (?:be )?(?:reside|located|based|live) in the (?:U\.?S\.?|United States)|"
    r"(?:will not|cannot|unable to) (?:provide |offer )?(?:visa )?sponsor", re.I)
_RANGE = re.compile(r"(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*\+?\s*years?", re.I)
_YEARS = re.compile(
    r"(\d{1,2})\s*\+\s*years?|(?:minimum|at least)\s*(?:of\s*)?(\d{1,2})\s*years?|"
    r"(\d{1,2})\s*years?\s+(?:of\s+)?(?:relevant\s+|professional\s+|industry\s+)?experience", re.I)
_ABOVE = re.compile(r"\b(principal|distinguished|fellow|director|head\s+of|vp)\b", re.I)
_STAFF = re.compile(r"\b(staff|lead|architect)\b", re.I)
# Role families a backend / cloud / platform engineer is rarely shortlisted for,
# however much of the stack overlaps. Override with "off_track" in the profile.
OFF_TRACK = r"data scientist|mobile|\bios\b|android|front[- ]?end|designer|\bux\b|research scientist|hardware|firmware|sales engineer|solutions? engineer"
_CANADA = re.compile(
    r"canada|\bcan\b|toronto|vancouver|montr[eé]al|ottawa|calgary|edmonton|waterloo|kitchener|"
    r"mississauga|winnipeg|halifax|victoria|quebec|qu[eé]bec|ontario|british columbia|alberta|"
    r"nova scotia|manitoba|saskatchewan|,\s*(on|bc|qc|ab|ns|mb|sk|nb|nl|pe)\b", re.I)
_JUNIOR = re.compile(r"\b(junior|intern|new grad|entry[- ]level|associate)\b", re.I)


def compile_vocab(profile_skills):
    pats = {k: re.compile(rf"(?<![\w]){v}", re.I) for k, v in VOCAB.items()}
    for s in profile_skills:
        if s not in pats:
            pats[s] = re.compile(rf"(?<![\w]){re.escape(s)}(?![\w])", re.I)
    return pats


def candidate_years(profile, today):
    total = 0.0
    for e in profile.get("experience") or []:
        if "intern" in (e.get("title") or "").lower() or not e.get("start"):
            continue
        try:
            sy, sm = (int(x) for x in e["start"].split("-")[:2])
            end = e.get("end") or "present"
            ey, em = (today.year, today.month) if end.lower() in ("present", "current") else (int(x) for x in end.split("-")[:2])
            total += max(0.0, ((ey - sy) * 12 + (em - sm)) / 12)
        except (ValueError, AttributeError):
            continue
    return round(total, 1)


def required_years(text):
    lows, masked = [], text or ""
    for m in _RANGE.finditer(masked):
        lows.append(int(m.group(1)))
    masked = _RANGE.sub(" ", masked)
    found = [int(g) for m in _YEARS.finditer(masked) for g in m.groups() if g]
    found = [n for n in found + lows if 1 <= n <= 20]
    return max(found) if found else None


def recency_penalty(posted, today):
    if not posted:
        return 7
    try:
        age = (today - date.fromisoformat(posted[:10])).days
    except ValueError:
        return 7
    for limit, pts in ((7, 0), (14, 3), (30, 7), (60, 12)):
        if age <= limit:
            return pts
    return 18


def score(job, pats, have, years, today, off_track):
    text = f"{job['title']}\n{job.get('description') or ''}"
    named = sorted(k for k, p in pats.items() if p.search(text))
    matched = [k for k in named if k in have]
    n, m = len(named), len(matched)
    skills = 0.0 if n == 0 else (0.6 * m / n + 0.4 * min(m, 8) / 8) * min(n, 4) / 4
    pct = round(skills * 100)
    reasons, blocked = [], False

    for rx, why in _HARD:
        if rx.search(text):
            reasons.append(why)
            blocked = True
    req = required_years(job.get("description"))
    if req is not None and years:
        gap = req - years
        if gap >= 3:
            reasons.append(f"asks for {req}+ years, you have {years:g}")
            blocked = True
        elif gap > 0:
            reasons.append(f"asks for {req}+ years (stretch from {years:g})")
            pct -= 10 * max(0, round(gap) - 2)
    title = job["title"]
    if _ABOVE.search(title):
        reasons.append("title is above senior level")
        pct -= 25
    elif _STAFF.search(title) and years and years < 7:
        reasons.append("staff/lead title - a stretch at your years")
        pct -= 8
    if off_track.search(title):
        reasons.append("role family outside your track")
        pct -= 15
    if _JUNIOR.search(title):
        reasons.append("junior/associate title - below your level")
        pct -= 20
    pct -= recency_penalty(job.get("date"), today)
    pct = max(0, min(100, pct))

    flags = []
    if job.get("region") == "us-remote" and _US_AUTH.search(text):
        flags.append("needs US work authorization / residency")
    verdict = "blocked" if blocked else "strong" if pct >= 65 else "good" if pct >= 50 else "stretch"
    return {"pct": pct, "verdict": verdict, "matched": matched,
            "missing": [k for k in named if k not in have], "reasons": reasons,
            "flags": flags, "required_years": req}


def normalise(raw, source):
    loc = raw.get("location") or ""
    region = raw.get("region")
    if not region:
        low = loc.lower()
        region = "canada" if _CANADA.search(low) else "us-remote"
    return {
        "id": raw.get("id"), "title": (raw.get("title") or "").strip(),
        "company": raw.get("company") or "", "location": loc or None,
        "date": (raw.get("date") or raw.get("posted_at") or None),
        "url": raw.get("url"), "region": region, "sector": raw.get("sector") or "tech",
        "salary": raw.get("salary") or raw.get("comp"), "description": raw.get("description") or "",
        "source": source,
    }


def load(args):
    jobs = []
    for f in args.feed or []:
        d = json.loads(Path(f).read_text(encoding="utf-8"))
        jobs += [normalise(j, "ats-boards-search") for j in d.get("results", [])]
    for dname in args.jobs_dir or []:
        for p in sorted(Path(dname).glob("*.json")):
            try:
                raw = json.loads(p.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            if isinstance(raw, dict) and raw.get("title") and raw.get("status", "open") == "open":
                jobs.append(normalise(raw, Path(dname).name))
    seen, out = set(), []
    for j in jobs:
        key = j["url"] or f"{j['company']}|{j['title']}|{j['location']}"
        if key in seen or not j["title"]:
            continue
        seen.add(key)
        out.append(j)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--feed", action="append")
    ap.add_argument("--jobs-dir", action="append")
    ap.add_argument("--profile", required=True)
    ap.add_argument("--out", help="write JSON here instead of stdout")
    ap.add_argument("--keep-description", action="store_true", help="keep full descriptions in the output")
    ap.add_argument("--today", help="YYYY-MM-DD, for reproducible runs")
    args = ap.parse_args(argv)
    if not args.feed and not args.jobs_dir:
        ap.error("give at least one --feed or --jobs-dir")

    today = date.fromisoformat(args.today) if args.today else date.today()
    profile = json.loads(Path(args.profile).read_text(encoding="utf-8"))
    have = {s.lower() for group in (profile.get("skills") or {}).values() for s in group}
    pats = compile_vocab(have)
    # A stated figure wins: date arithmetic cannot see part-time or overlapping work.
    years = float(profile.get("years_experience") or candidate_years(profile, today))
    off_track = re.compile(profile.get("off_track") or OFF_TRACK, re.I)

    ranked = []
    for j in load(args):
        j["score"] = score(j, pats, have, years, today, off_track)
        if not args.keep_description:
            j["description"] = (j["description"] or "")[:400]
        ranked.append(j)
    order = {"strong": 0, "good": 1, "stretch": 2, "blocked": 3}
    # Verdict band, then score, then newest first.
    ranked.sort(key=lambda j: (order[j["score"]["verdict"]], -j["score"]["pct"],
                               -int((j["date"] or "0000-00-00")[:10].replace("-", ""))))

    out = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "candidate_years": years, "count": len(ranked), "jobs": ranked}
    text = json.dumps(out, indent=1, ensure_ascii=False)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        counts = {v: sum(1 for j in ranked if j["score"]["verdict"] == v) for v in order}
        print(f"ranked {len(ranked)} jobs -> {args.out}: " + ", ".join(f"{v} {n}" for v, n in counts.items()))
    else:
        sys.stdout.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
