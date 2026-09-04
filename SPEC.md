# BMW MS41 Log Analyzer — Technical Specification

> Status: draft v3 for review · Local single-user web app · Stack: **Node.js backend + web UI**, **PostgreSQL in Docker**.
> Grounded in a full pass over the sample logs, a **completed reverse-engineering spike of the Innovate boost binary** (§3.2), **and** research into the BMW MS41 / RomRaider / Innovate tuning community (see §12 Sources).
> Target car for first build: **M50 block + M52 head** (BMW hybrid) on MS41.

---

## 1. Goal

Upload a **batch** of logs (one datalogging session), analyze it automatically, and — because
batches arrive repeatedly over time — **compare each new session against the car's previous
sessions** to surface what changed and what's interesting. An **AI layer** turns the computed
numbers into plain-language findings, cross-session interpretation, and prioritized recommendations.

Logs belong to a **car**; multiple cars are supported so their sessions never mix.

Core capabilities:
1. Manage **cars** (create with turbo yes/no + configurable AFR targets).
2. Ingest a mixed batch (RomRaider CSV + Innovate `.log.txt`) into one car.
3. Parse both formats into one canonical model; extract boost from the Innovate binary.
4. Run reworked analysis algorithms that hunt for *interesting* information, not just ranges.
5. **Session-difference engine** — compare a session against the car's history.
6. **AI analysis** over the computed results (per-session narrative, diff interpretation, chat Q&A).
7. Persist all sessions per car as history + trends.

---

## 2. Vehicle context (why the defaults below are what they are)

The toolchain is **RomRaider + OpenMS41** on a **Siemens MS41.x** ECU (BMW M52/S52). The MS41's
own knock control writes a **knock-correction / knock-learning** value per RPM×load cell, and runs
**closed-loop** fuel trims (LTFT/STFT) around stoich at part throttle, going **open-loop** at WOT.
This is exactly what the algorithms below exploit. [§12: OpenMS41, RomRaider]

---

## 3. Input data — ground truth from the sample batch

### 3.1 RomRaider CSV (`romraiderlog_*.csv`)
- **latin-1**, delimiter **`;`**, decimal **`,`**, ~**12.5 Hz**. Headers carry junk dots + units.
- 18 columns, identical schema across all 9 sample files.

| Raw header | key | unit | notes |
|---|---|---|---|
| Time (msec) | `time_ms` | ms | |
| ECT / IAT | `ect` / `iat` | °C | temps |
| IGN | `ign_adv` | °BTDC | advance; negative = retard |
| IPW | `ipw` | ms | injector pulse width |
| Load | `load` | mg/stroke | **primary load axis** |
| MAF | `maf` | kg/h | |
| RPM | `rpm` | rpm | **primary speed axis** |
| TPS | `tps` | % | **maxes ~74.5% at WOT — never 100** |
| IACV | `iacv` | % | idle valve |
| IdleFT1 | `idle_ft1` | ms | |
| LTFT1 / STFT1 | `ltft1` / `stft1` | % | fuel trims |
| V_MAF / V_O2_Front | `v_maf` / `v_o2` | V | |
| Knock (° Cor) | `knock_corr` | ° | **0 = none, negative = timing pulled** |
| Innovate PSB-1 CH3 (PSI) | `boost_psi` | psi | **all zeros in CSV — boost lives in the .log.txt** |
| Innovate Wideband AFR | `afr` | AFR | real wideband |

### 3.2 Innovate LogWorks `.log.txt` (binary, magic `LW2.0`) — **DECODE CONFIRMED**
Where **real boost** lives. The reverse-engineering spike is done and boost is proven recoverable:
- **Container:** chunked. An `inpt` chunk defines 4 channels (`PSB_1_O2`=AFR, `PSB_1_RPM`=RPM,
  `PSB_1_BOOST`=PSI, `PSB_1_OnOFF`) each with gauge calibration floats (verified `14.7` stoich, `5.0`,
  `7.35`, `22.39`). Channel defs appear as a full block up front and a short re-declaration near EOF.
  Sample data lives in `cont` blocks delimited by `sesf`/`cont` markers (with per-block timestamp floats).
- **Sample encoding — verified:** samples are **10-bit raw values (0–1023) as little-endian uint16**.
  Proof: **98.0%** of words in the sample region are ≤1023; the ~2% above are markers/timestamps.
  `1023` = pegged/rail. Storage is **planar** (per-channel blocks), not interleaved.
- **Raw→physical:** linear map over each channel's stored calibration range. Validated on AFR
  `[7.35, 22.39]`: raw `517→14.95, 481→14.42, 472→14.29` (sane cruise AFR), `1023→22.39` (decel/rail).
  BOOST/RPM/OnOFF use their own ranges from their defs. In Node: `buf.readUInt16LE(off)` per sample.
- **Time-align to a CSV** by cross-correlating a shared channel (RPM preferred, AFR fallback), then
  resample boost onto the CSV time axis. Alignment carries a confidence score + manual-offset override.
- Remaining production work (small): map each `cont` block to its channel, apply per-channel calibration,
  emit `{afr, rpm, boost_psi, on}` series. Reference decoder from the spike: `scratchpad/analyze.py` approach. [§12: Innovate/LogWorks manual]

### 3.3 Sample-batch findings (calibrate thresholds)
- WOT ⇒ TPS relative (≥90% of session max, or ≥65% absolute), because TPS tops ~74.5%.
- Knock in the sample clusters at **1300–1600 rpm, part-throttle, load ~190 mg/stroke**, peak **−1.1°**.
- AFR 10.2–20.3; **20.3 spikes = decel fuel-cut (normal)**, 10.2 = cold/accel enrichment.
- CSV boost is meaningless; trust boost only from `.log.txt`.

---

## 4. Multi-car model & configuration

**Everything is configurable.** A **Car** owns all its sessions so nothing mixes. The create flow is a
guided form driven by an **extensible engine/ECU registry**, so the app grows to new car models over time
without code changes — you add a registry entry, not a branch.

**Create-car flow (UI):**
1. Name the car.
2. **Select engine** from the registry (e.g. *M50 block + M52 head*, *M52B28*, *S52*, …) — or "Custom".
   The registry entry seeds sensible defaults (redline, load/RPM axes, displacement, ECU).
3. **Forced induction? yes/no** (+ type: turbo/supercharger) → seeds AFR-target defaults.
4. Review/override **every** default (AFR targets, tolerances, WOT threshold, knock thresholds, trim
   threshold, table axes). Nothing is hard-coded per car; the registry only provides starting points.
5. Save → the car appears; you can now add log sessions to it.

**Engine/ECU registry (extensible catalog):**
```
EngineProfile            # data, not code — add rows to support new builds
  id, label              # "m50b25_m52head", "M50 block + M52 head"
  displacement_cc, cylinders, ecu_default   # "MS41.1"
  redline_default, rpm_axis_default[], load_axis_default[]
  notes                  # e.g. hybrid build quirks
```
First registry entry ships as **M50 block + M52 head / MS41** (the target car). Adding an M52B28, S52,
or a boosted build is a new registry row + optional custom axes.

```
Car
  id, name
  engine_profile_id -> EngineProfile     # selected at creation
  engine_label, ecu                      # copied+editable snapshot
  forced_induction: {enabled: bool, type: turbo|supercharger|none}   # asked at creation
  config:                                # all editable, seeded from profile + induction
    afr_target_wot        # default NA 13.0 (λ0.88) | turbo 11.8 (λ0.80)
    afr_target_cruise     # default 14.7 (closed loop), leaner allowed
    afr_tolerance         # default ±0.3 AFR before flagging
    wot_tps_pct           # relative WOT threshold, default 90% of session max
    knock_warn_deg        # default -0.5  (any retard beyond = event)
    knock_crit_deg        # default -3.0  (serious)
    trim_scale_threshold  # default ±5%   (scale MAF beyond this)
    rpm_axis[], load_axis[]  # fuel/timing table breakpoints -> the cell grid
    redline
```

**AFR-target defaults by induction type** [§12: HP Academy, OpenMS41]:

| condition | NA (λ) | NA (AFR) | Turbo (λ) | Turbo (AFR) |
|---|--:|--:|--:|--:|
| WOT power | 0.86–0.90 | 12.5–13.2 | 0.78–0.82 | 11.5–12.0 |
| cruise/closed-loop | ~1.00 | 14.7 | ~1.00 | 14.7 |
| light-cruise economy | up to 1.05 | ~15.4 | near stoich | ~14.7 |

The **rpm_axis × load_axis** grid is the car's fuel/timing-table breakpoints. **Every map and every
cross-session comparison is expressed on this grid** — the same trick MegaLogViewer HD uses to bin AFR
error onto the VE table's own axes. [§12: MegaLogViewer HD]

---

## 5. Canonical data model

```
LogFile: id, session_id, filename, source_type, sample_rate_hz, duration_s, row_count,
         channels{key->float[]}, present_channels[], dead_channels[]
Session: id, car_id, uploaded_at, label, logfiles[], derived{...}, findings[], ai{...}
```
A **Session** = one uploaded batch for a car (a CSV + its aligned `.log.txt` merge into one session).

---

## 6. Reworked per-session algorithms — hunting for *interesting* information

Shared toolkit: EWMA smoothing; IQR/z-score outliers; **event clustering with hysteresis**;
**RPM×Load binning** onto the car's grid; **calculated fields** (RPM/sec, boost from Innovate, PW,
estimated VE). Every value that isn't from a `present` channel is skipped, not analyzed as 0.

**A. Segmentation & calculated fields.** Split into `idle | cruise | pull | decel`. A *pull* = sustained
relative-WOT with rising RPM; *decel* = closed throttle + falling RPM + AFR pegged lean (⇒ **fuel-cut,
excluded from lean flags**). Derive `rpm_per_sec`, boost trace, injector duty.

**B. Knock intelligence** (headline safety). Not just "count":
- Cluster `knock_corr ≤ knock_warn_deg` into events (start/end/peak, and rpm/load/ign/afr/ect/iat at onset).
- **Cell repeatability test** — knock in only 2–3 isolated cells across the session = likely *noise* (normal
  even on a healthy tune); the same cell repeatedly = a *real* hotspot. Report each with a noise/real label. [§12: RomRaider]
- **Knock-vs-timing correlation** — if the ECU pulls ≥6–7° while AFR is on target, flag *"timing too
  aggressive here,"* distinct from *"lean-driven knock"* (knock while AFR is lean ⇒ fix fuel first). [§12: HP Academy]
- Knock heatmap over the grid; worst-cell ranking by severity = peak × duration × repeat-count.

**C. AFR-error map** (the core tuning output, mirrors MLV's table generator):
- Per cell, compute **AFR error = measured − target** (target from car config: cruise vs WOT branch).
- Exclude decel-cut and enrichment transients. Flag **lean-under-load** and **over-rich** cells beyond
  `afr_tolerance`. Report WOT-pull AFR per pull (min/mean) against `afr_target_wot`.

**D. MAF / fuel-trim scaling** (actionable):
- Distribution of LTFT/STFT; if **|LTFT+STFT| > trim_scale_threshold (±5%)**, recommend MAF rescale
  using **`New_airflow = Old_airflow × (1 + %total_trim/100)`**, reported per RPM/load region. [§12: HP Academy, HPtuners]
- Split idle vs cruise vs load trims (a vacuum-leak signature = big positive trim at idle only).

**E. Ignition-timing map** — bin `ign_adv` on the grid; surface the timing curve and abnormal retard
outside knock events.

**F. Boost analysis** (forced-induction cars, from Innovate) — peak boost, boost-vs-RPM spool curve,
spool rate (RPM/sec to target), overshoot/spike and tail-off detection, boost-vs-knock correlation.

**G. Sensor & data quality** — dead channels, out-of-range ECT/IAT/MAF, time gaps/dropouts, sample-rate
consistency, alignment confidence for merged boost.

**H. "Interesting findings" ranker** — every module emits typed findings
`{severity, code, cell, message, evidence}`; a ranker sorts by safety-criticality × confidence so the
session's headline is *the* thing worth knowing, not a wall of numbers.

**Per-session output:** `{ segments, events[], maps{afr_error,ign,knock,boost}, trims{...},
recommendations[], quality{...}, findings[] }` — this structured object is the single source of truth and
the **only** thing the AI layer sees (§8).

---

## 7. Session-difference engine — the whole cross-session algorithm

Goal: given a car's new session and its history, answer *"what changed, where, and does it matter?"*
Comparison is **by operating-condition cell, never by time**, so sessions of different length/route compare fairly.

**Step 1 — Normalize.** Reduce each session to per-cell aggregates on the car's grid:
`cell → {n, afr_mean, afr_err_mean, ign_mean, knock_peak, knock_events, boost_mean, trim_mean}`,
plus session scalars (max rpm, peak boost, worst knock, trim spread, pull count).

**Step 2 — Pick baseline.** One of: previous session · a pinned reference session · **rolling median of
last N** (default N=5). Configurable per comparison.

**Step 3 — Like-for-like guard.** Only compare a cell when **both** sides have ≥`min_samples` (default 8);
thin cells are shown as "insufficient data," never as a delta. Compare pull-derived metrics only against
other pulls.

**Step 4 — Per-cell delta + significance.** For each shared cell compute `Δ = new − baseline` for AFR,
timing, knock, boost. Significance via **effect size** (Δ normalized by pooled cell stdev) + a sample-count
gate, so sensor noise doesn't masquerade as change. Output delta heatmaps (AFR/timing/knock).

**Step 5 — Classify changes.**
- **Regression** — new knock cell absent from baseline; AFR leaned past tolerance under load; peak boost
  down; trims drifted wider.
- **Improvement** — knock cell cleared; AFR moved toward target; trims tightened.
- **Neutral drift** — within noise.

**Step 6 — Trend (multi-session).** Per cell/metric, fit a slope over the last N sessions (e.g. *"1400 rpm
knock worsening 3 sessions running"*, *"WOT AFR drifting lean +0.1/session"*). Surfaces slow problems a
single diff misses.

**Step 7 — Emit ranked diff findings** `{type, cell, metric, delta, significance, message}` → fed to the AI
layer for narration.

Everything here is deterministic and reproducible; the AI never computes the deltas, only explains them.

---

## 8. AI analysis layer

**Principle: the AI reasons over the computed structured results (§6/§7) + car config — never over raw log
rows.** That keeps it accurate (no arithmetic on 100k samples), cheap, and grounded. Claude API via the
Node **`@anthropic-ai/sdk`**; see the project's claude-api guidance for current model IDs.

**8.1 What the AI produces**
1. **Session narrative** — plain-language summary: health verdict, the 3–5 most interesting findings,
   what's safe / what needs attention.
2. **Diff interpretation** — turns §7's ranked deltas into *"since last session, knock at 4000 rpm is new
   and correlates with the timing you added — back it out 2°."* Distinguishes regression vs noise.
3. **Prioritized recommendations** — concrete next actions (MAF rescale % by region, AFR-target or timing
   tweaks), each **citing the metric/cell it came from** (no ungrounded advice).
4. **Chat Q&A** — user asks "why is it knocking in 2nd gear?" and the model answers from that session/car's
   computed features (retrieval over the structured store, not the CSV).

**8.2 Design & guardrails**
- Input = compact JSON: car config + session summary + top findings + diff findings (token-bounded; big
  maps sent as small flagged-cell lists, not full grids).
- Output = structured JSON (verdict, findings[], recommendations[]) **plus** prose, so the UI can render
  both and every recommendation links back to evidence.
- **Grounding rule:** the model must reference a concrete metric/cell for each claim; unsupported claims are
  dropped. Deterministic engine stays the source of truth — AI is interpretation, not calculation.
- Cache per-session AI output; re-run only when the session or baseline changes. Model tier configurable
  (a smaller model for narratives, a stronger one for diff reasoning / chat).
- Runs **local-first**: if no API key, the app still delivers all deterministic analysis; AI is additive.

---

## 9. Architecture

```
Browser UI ──create car / upload batch──► Node.js API (Express/Fastify, TypeScript)
   cars, sessions, reports,                 ├─ parsers (csv reader; lw2 boost decoder + align)
   diff view, trends, AI chat               ├─ analysis engine (per-session, §6)
                                            ├─ diff engine (§7)
                                            ├─ AI layer (@anthropic-ai/sdk)
                                            └─ PostgreSQL (in Docker)
```
- **Backend:** Node.js + TypeScript (Express or Fastify). Parsing/analysis in TS; heavy numeric work uses
  typed arrays. The LW2.0 decoder is trivial in Node (`Buffer.readUInt16LE`). File uploads via multipart.
- **Database:** **PostgreSQL running in Docker.** Ship a `docker-compose.yml` (postgres service + the
  Node app service). JSONB columns for `config`, `findings.evidence`, `ai_results.output`. Migrations via
  a light tool (e.g. node-pg-migrate / Prisma — TBD, keep it swappable).
- **Frontend:** SPA (React + Vite + TS) — grid **heatmaps** (AFR error, knock, timing, diff), **pull line
  charts**, **3D scatter** for correlation (mirrors MLV), a per-car **session timeline** for trends, an **AI panel**.
- **Runs locally** via `docker compose up`; no external services except the optional Claude API.

**Storage (PostgreSQL — sketch):**
```
engine_profiles(id, label, displacement_cc, cylinders, ecu_default, redline_default, axes_json, notes)
cars(id, name, engine_profile_id, engine_label, ecu, forced_induction_json, config_json)
sessions(id, car_id, uploaded_at, label, baseline_session_id)
logs(id, session_id, filename, source_type, duration_s, rows, sample_rate, present_channels[], dead_channels[])
cell_maps(session_id, map_type, rpm_bin, load_bin, n, mean, min, max)   -- afr_error/ign/knock/boost
events(id, session_id, type, t_start, t_end, peak, rpm, load, ign, afr, severity, noise_flag)
findings(id, session_id, scope, severity, code, cell, message, evidence_jsonb)
ai_results(id, session_id, kind, input_hash, output_jsonb, created_at)
```

**API (initial):**
`GET /engine-profiles` · `POST /engine-profiles` (extend the catalog) ·
`POST /cars` · `GET /cars` · `PATCH /cars/:id/config` ·
`POST /cars/:id/sessions` (upload → analyze) · `GET /sessions/:id` ·
`GET /sessions/:id/compare?baseline=prev|rolling|<id>` ·
`GET /cars/:id/trends?metric=worst_knock` ·
`POST /sessions/:id/ai` (narrate/diff) · `POST /sessions/:id/chat`.

---

## 10. Risks & open questions
1. ~~**LW2.0 sample decoding**~~ — **RESOLVED (spike done, §3.2):** 10-bit uint16, planar, linear calibration,
   validated on AFR. Only left: map each block→channel + per-channel calibration in the Node decoder.
2. **Time-alignment robustness** — RPM cross-correlation should be strong; needs confidence + manual override.
3. **AFR targets** — defaults per §4; must stay per-car configurable (done in model).
4. **Decel-fuel-cut exclusion** — must be reliable so it isn't flagged as lean.
5. **Cross-format file matching** when filenames don't correspond (9 CSV vs 3 log.txt in the sample).
6. **AI grounding/cost** — enforce evidence-citation + token bounds; keep AI optional.

---

## 11. Milestones
0. **M0** Scaffold: `docker-compose.yml` (Postgres + Node app), TS project, migrations, engine-profile registry seeded with *M50 block + M52 head / MS41*.
1. **M1** Cars (registry-driven create flow, full config) + CSV parsing → canonical model + dead-channel detection + tests on the 9 samples.
2. **M2** LW2.0 boost decoder (spike ✅ done) → port to Node, map blocks→channels, time-align to CSV, validate vs CSV AFR.
3. **M3** Reworked per-session analysis (§6) + grid maps + findings ranker.
4. **M4** UI (heatmaps, pull charts, per-car session list).
5. **M5** Session-difference engine (§7) + trends.
6. **M6** AI layer (§8) — narrative, diff interpretation, chat.

---

## 12. Sources (research)
- RomRaider — datalog/tuning basics, knock-as-noise heuristic: romraider.com, sites.google.com/site/openms41
- OpenMS41 — MS41 ECU tuning, closed/open loop, AFR ~13 target: sites.google.com/site/openms41
- HP Academy — NA vs turbo λ targets, MAF-scaling-from-trims, knock-vs-timing: hpacademy.com
- MAF scaling formula & ±5% trim rule: forum.hptuners.com, ecutek docs
- MegaLogViewer HD — histogram/table generator on VE axes, 3D scatter, calculated fields: efianalytics.com
- Innovate LogWorks — .log stores 10-bit raw + calibration: manual (exhaustgas.com/docserver/Docs/163.pdf)
- Automotive time-series anomaly detection (context for AI/diff): arXiv EngineAD 2603.25955; UniTO dissertation

---

## 13. Build handoff — implementing M0 + M1 on another machine

**M0 and M1 are intended to be built on a separate computer.** The repo is the single source of truth;
everything needed is committed. Steps to pick up the work:

**Prerequisites**
- Git, Node.js LTS (≥ 20), and Docker Desktop (for the PostgreSQL container).
- GitHub access to `enimarix/speedTech` (the repo is **private**).

**Get the code**
```bash
git clone https://github.com/enimarix/speedTech.git
cd speedTech
git config user.name "enimarix"
git config user.email "medenimarix@gmail.com"   # keep commit attribution consistent
```

**Scope to build there**
- **M0 — Scaffold:** `docker-compose.yml` (Postgres + Node app), TypeScript project, DB migrations,
  and the `engine_profiles` registry **seeded with "M50 block + M52 head / MS41"** (§4).
  Verify with `docker compose up` → Postgres reachable, Node app boots, migrations applied.
- **M1 — Cars + CSV parsing:** registry-driven create-car flow with full config (§4), the RomRaider CSV
  reader → canonical model (§3.1, §5) with dead-channel detection, and **tests against the 9 sample logs
  in `logs/`** (committed as fixtures). Expected parser results are documented per §3.3 (e.g. TPS maxes
  ~74.5%, boost dead in CSV, knock events present) — use them as assertions.

**Workflow**
- Branch per milestone (e.g. `feat/m0-scaffold`, `feat/m1-cars-csv`), PR into `main`.
- Keep `logs/` as test fixtures; do **not** commit real secrets — use `.env` (git-ignored) with `.env.example` checked in.
- M2's boost decoder is already de-risked (§3.2) — port the verified 10-bit/planar/calibration logic to Node when you reach it.
