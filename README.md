# speedTech

Web app for analyzing **BMW MS41** engine datalogs (RomRaider CSV + Innovate LogWorks boost logs),
comparing each datalogging session against a car's history, and surfacing **AI-assisted** tuning insights.

Target build: **M50 block + M52 head** on a Siemens MS41 ECU.

## What it does
- Manage **multiple cars** (extensible engine/ECU registry; pick engine + forced-induction at creation; everything configurable).
- Upload a **batch of logs** per car and analyze it: knock intelligence, AFR-error maps, MAF/fuel-trim scaling, ignition & boost analysis.
- Extract **real boost** from Innovate `.log` binaries (10-bit decode — reverse-engineered, see spec §3.2) and time-align to the ECU CSV.
- **Session-difference engine** — compare a new session vs the car's history on the RPM×Load grid, flag regressions/improvements/trends.
- **AI layer** — plain-language session narrative, diff interpretation, prioritized recommendations, and chat Q&A over the computed results.

## Stack
- **Backend:** Node.js + TypeScript (Express/Fastify)
- **Database:** PostgreSQL (Docker) — `docker compose up`
- **Frontend:** React + Vite + TypeScript
- **AI:** `@anthropic-ai/sdk` (optional; all deterministic analysis works without it)

## Status
Specification complete — see [`SPEC.md`](SPEC.md). Implementation starts at milestone **M0** (scaffold).

## Repository layout (planned)
```
SPEC.md              # full technical specification
logs/                # sample datalogs used as test fixtures
docker-compose.yml   # postgres + app  (M0)
backend/             # Node + TS API, parsers, analysis, diff, AI  (M0+)
frontend/            # React + Vite UI  (M4)
```
