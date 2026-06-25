# Organisation-Level Live-Ops Dashboard — Design Document

**Product:** qlerify-live (operational digital twin / process-intelligence platform)
**Level:** Third tier — one above the existing Workflow-Type Overview
**Audience:** COO, operations leaders, program directors running a heterogeneous portfolio of LIVE workflow types
**Date:** 2026-06-23

---

## 1. Executive summary

Build a **portfolio control tower**: a third dashboard level above the per-workflow-type overview that spans *multiple workflow TYPES at once* (hardware production, base-station maintenance, customer-implementation projects) and answers the questions a COO actually acts on — *Are we keeping our promises? Is work flowing or piling up? Where is the system bleeding time and money? Do we have the capacity to clear the backlog? Will we hit the promises still open?* The hard constraint is **heterogeneous roll-up**: a 28-step build and a 6-step maintenance job are only comparable once every indicator is normalized to a **%, ratio, or actual/expected index** — never raw day-counts.

The single highest-leverage *technical* move is to build the **derived per-`(workflowId, eventRef)` P50 `businessAt`-gap baseline** — a single `groupBy` over data that exists today — because it is the keystone that unlocks Cycle-Time Index, Aging-vs-percentile, At-Risk, Bottleneck over-run, Commitment Confidence and Slack *simultaneously*. Without it the board is just raw counts, which this product's own normalization rule forbids. The single highest-leverage *product* move is to shift from lagging OTIF to **forward-looking Commitment Confidence and Aging-WIP**, the only indicators that give a leader time to intervene *before* a miss locks in.

What is genuinely computable today is narrower than it first appears, and this document marks it honestly. The **EventLog spine** (`businessAt`, `eventRef`, `caseId`, `provenance`, `boundedContext`, `role`, `workflowId`, `organizationId`) plus per-workflow `linearOrder()` give us active counts, throughput, aging, rework loops, role-queue depth and provenance mix **today**. But three things the draft-era thinking assumed are *not* free: (a) every cross-workflow roll-up needs a **new multi-ontology-resolution path** because `getOntology()` is a process-global singleton swapped per active workflow; (b) **Commitment Confidence and At-Risk depend on the derived baseline AND a reliable per-instance commit date** — neither is a point-in-time free read, so they are P0 *only because we pull the baseline into P0*, and the commit-date question is a P0 *blocker*, not a refinement; (c) the **entire AI panel needs new instrumentation** — there is no actor-origin tag on `EventLog`, chat write-tools share the identical `genericStep` path as a human step-forward, and the PDP governs control-plane resource access only and is **never invoked on runtime/chat writes**, so "Guardrail Block Rate" requires *building the guardrail first*.

The product's unique differentiators — **provenance (simulated/recorded/live) as a first-class twin-trust score** and an **AI assistant that can write back** — still become dedicated panels no generic process-mining tool can show, but the AI panel is honestly sequenced behind its real prerequisites. Architecturally, the P0 slice is a new cross-workflow aggregation endpoint that resolves each workflow's ontology without globally swapping it, folds the org's `EventLog` into one normalized view, and renders as a new hash route (`#org`) in the existing vanilla-JS SPA.

---

## 2. The 2026 thesis

Seven shifts make an org-level live-ops dashboard the right thing to build *now*, each tied to a concrete indicator this product can compute:

- **From visibility to anticipation (control towers).** The defining 2026 control-tower narrative is "from visibility to orchestration": dashboards are judged on whether they *predict* a breach, not display a late flag after the fact. → **Commitment Confidence** (predicted on-time probability for OPEN work) and **Time-to-Commitment Slack** (buffer burned), computed by summing remaining-step expected durations (from the derived baseline) from the current `eventRef` and comparing to a commit date — *gated on the baseline + commit-date prerequisites below.*

- **Operational digital twins are now a named category (Gartner DTO, 2026).** A twin is only as good as its live coupling, so **data freshness / connector health** has become the #1 data-observability pillar — "a board that loads in 50ms on 6-hour-stale data is fast at being *wrong*." → **Twin-Trust / Provenance Mix** (`provenanceMeta().steps.real / total`, summed across workflows) and **Connector Freshness** (now − last pull per `boundedContext`).

- **Twin trust now includes conformance, not just freshness.** Beyond "is the feed recent" and "is it real vs simulated" sits "does the ingested data *conform* to the model." → **Data-Conformance** (% instances with a derivable `businessAt`, no orphaned events, realized path consistent with `linearOrder()`) — groundable today because `businessDateFromPayload()` can return `null` and a conformance test already exists.

- **Agentic AI acting under guardrails moves governance onto the dashboard.** With EU AI Act high-risk traceability rules landing Aug 2026 and Gartner warning ~40% of agentic projects get cancelled over weak risk controls, the AI panel must be a *governance ledger*. **Honest grounding:** today there is *no* guardrail on AI runtime writes (only a `confirmed:true` argument check) and *no* actor-origin tag — so this whole category is NEEDS CAPTURE and is sequenced behind building (a) actor-origin threading and (b) a PDP check on runtime writes. → **AI vs Human Action Share**, **Override/Reversal Rate**, **Guardrail Block Rate**.

- **Flow and value metrics over vanity counts.** 2026 PMO/lean practice has shifted from self-reported RAG to *derived, event-grounded* health, and from averages to **P50/P90 distributions** (the tail is where commitments break). → **Aging-WIP vs percentile bands**, **Flow Efficiency** (active vs wait), **Cycle-Time Index** (actual/expected) — all from `businessAt` gaps once the baseline exists.

- **Capacity is the COO's next question after every bottleneck.** "34 waiting on SAP PO approval" is half an answer; the next question is "how many approvers, what's their load, staffing or process problem?" `EventLog.role` carries the step role today. → **Role-Queue Depth & Load** — groundable now from existing data, no new capture.

- **Money-anchored roll-ups, but days-first.** Every gap is expected to carry a quantified impact with an owner — but until a rate table exists, lead with **overdue-DAYS and blast-radius** (both HAVE-NOW), not euros. → **Cost-of-Delay / Penalty Exposure** as a *later* layer; the flagship severity number is groundable days, not a fabricated €.

- **Cross-process structural risk (object-centric + dependency).** A heterogeneous portfolio's biggest risks are (a) a single shared node (PO, test rig, connector) whose failure cascades, and (b) a *structural* dependency where one type cannot start until another delivers. → **Disruption Propagation / Blast Radius** and **Cross-Type Dependency Readiness**.

---

## 3. Indicator taxonomy

Priority key: **P0** = thin-slice MVP (computable from data that exists today, *including the derived baseline which is pulled into P0*), **P1** = next, **P2** = later/advanced. Data key: **HAVE NOW** = computable from current `EventLog` + `linearOrder()`; **NEEDS BASELINE** = needs the derived P50 baseline (a P0 task, no new capture, pure aggregation); **NEEDS CAPTURE** = needs instrumentation/config that does not exist today.

### A. Portfolio Health & Throughput
*The top-of-board triage layer: scan N heterogeneous types in seconds, then drill.*

| Indicator | Question it answers | Computed from this product | Viz | Pri | Data |
|---|---|---|---|---|---|
| **Active instances per type** | How much live work, where? | Distinct `caseId` with ≥1 event, no terminal event, per workflow | Big number per card | P0 | HAVE NOW |
| **Throughput / completions per period** | Is output rising, flat, or collapsing? | Count instances reaching terminal `eventRef` (last in `linearOrder()`), bucketed by `businessAt` week | Weekly bars per type | P0 | HAVE NOW (per-wf ontology for terminal `eventRef`) |
| **Throughput Balance (started ÷ completed) + WIP-trend** | Is work flowing or piling up? | Arrivals = root-create events/wk; departures = terminal events/wk; ratio per type, with open-WIP-count sparkline | Dual-bar + ratio tile (red <1.0) | P0 | HAVE NOW |
| **Portfolio Health roll-up** | Which workflow TYPE needs attention now? | Transparent weighted blend of normalized components (Confidence, At-Risk %, Exception rate, Aging-vs-history); drill-able, not a black box | Traffic-light tile per type + master tile | P1 | NEEDS BASELINE (composes baseline-dependent inputs) |
| **Cycle-Time Index (actual ÷ expected, P50/P90)** | Which type drifts most from its own baseline? | Per completed instance: (last−first `businessAt`) ÷ derived baseline; P50/P90, never mean | Index bar (1.0 ref) cross-type | P1 | NEEDS BASELINE |

*Cut as overlap:* a separate "Net WIP change / Flow Load" tile — folded into Throughput Balance's WIP sparkline (two tiles, one question).

### B. Timeliness & SLA / Predictive Lateness
*The forward-looking core — where this dashboard earns its keep. Two hard prerequisites: the derived baseline (P0 task) and a reliable commit date (P0 blocker, Open Decision #2).*

| Indicator | Question | Computed | Viz | Pri | Data |
|---|---|---|---|---|---|
| **Aging-WIP vs own-history percentile** | Which instances do I act on this morning? | Open age = now − first `businessAt`; overlay that type's own 50/85/95 historical completion percentiles | Aging scatter (step × age) + oldest-20 | P0 | NEEDS BASELINE (same history pass) |
| **Commitment Data Coverage** | Can we even score our promises? | % open instances with a resolvable commit-date field (and qty) vs total — the denominator-trust meta-metric | "X% of open promises scorable" tile | P0 | HAVE NOW (once commit-field mapping is set) |
| **Commitment Confidence** | Which open promises are still keepable TODAY? | `predicted_finish = now + Σ baseline(remaining steps)`, inflated by observed slippage; confidence = P(finish ≤ commit_date) | Confidence-banded list + gauge | P1→P0 if baseline+commit land | NEEDS BASELINE + NEEDS CAPTURE (commit date) |
| **Predicted breaches next N days** | What's about to miss? | Open instances with confidence < threshold OR projected_finish > commit_date | "Promises at risk" counter + triage | P1 | NEEDS BASELINE + NEEDS CAPTURE |
| **Time-to-Commitment Slack (buffer burned)** | How late, how much cushion left? | commit_date − projected_p50_finish, in days AND % of original buffer. **This is the single forward framing** — Monte-Carlo is its implementation, not a peer indicator | Fever/buffer-burn chart per type | P1 | NEEDS BASELINE + NEEDS CAPTURE |
| **Portfolio OTIF (lagging)** | Did we keep promises that finished? | Terminal `businessAt` ≤ commit_date (on-time) AND delivered-qty ≥ ordered-qty (in-full); split late vs not-in-full | Gauge + miss-split bar | P1 | NEEDS CAPTURE (commit date HAVE-if-mapped; in-full qty closer to NEEDS CAPTURE) |

*Cut as overlap:* standalone "Monte-Carlo P85" indicator — it is the engine behind Confidence/Slack, not a third "will we hit it" number on the board.

### C. Risk, Exceptions & Disruption
*The daily action queue — ranked by impact, deduped to root cause.*

| Indicator | Question | Computed | Viz | Pri | Data |
|---|---|---|---|---|---|
| **Rework / loop rate** | Where is pure waste? | Back-edges in realized path: repeated `eventRef` for one `caseId`; rate = instances with ≥1 loop; intensity = avg repeats | Rework heatmap (type × step) | P0 | HAVE NOW |
| **Synthesis soft-fail rate** | Where did the *twin* fail to advance? | Instances with payload `{skipped,error}` soft-fail marker (`sim.ts` genericStep catch). **Explicitly NOT a business exception** — it means the simulator could not synthesize a command | Soft-fail trend per type | P0 | HAVE NOW (labelled honestly) |
| **At-Risk / Stuck rate** | Is the portfolio getting healthier or sicker? | % open where dwell-in-step > k×baseline OR cumulative age > Σ baseline(steps-so-far) OR predicted-late; trend | At-risk % trend (stacked area) | P1 | NEEDS BASELINE |
| **Stuck-cohort detection** | Systemic or one-off? | Group open instances by (workflow, `eventRef`); flag steps where ≥N stall simultaneously | "Systemic stalls" callout | P1 | NEEDS BASELINE (stall = dwell > baseline) |
| **Real exception / Test-fail rate** | Is the standard path actually failing? | Domain failure events (Test-context fail, error-typed event) ÷ active | Exception Pareto by type/source | P1 | NEEDS CAPTURE (no Test BC / error-typed event exists today) |
| **Disruption Propagation / Blast Radius** | Which ONE upstream problem hurts most? | On a disruption, join instances sharing a payload key (PO id, part, customer) across types; count + propagated delay-days | Ripple graph + "affects 9 / 3 customers / +18d" | P2 | NEEDS CAPTURE (shared-key join) |
| **Exception MTTD / MTTA / MTTR** | How fast do we absorb shocks? | onset (first breaching event) → ack (first action) → resolve (trajectory recovers); mean + P90 | Detect→ack→resolve funnel | P2 | NEEDS CAPTURE (onset + action log) |

### D. Flow Efficiency, Bottlenecks & Capacity
*Where the portfolio loses time, and whether it's a process or a staffing problem — the highest-ROI place to intervene. Deep flow analytics (CFD, wait-by-hand-off) live inside a single drill view, not as peer org indicators.*

| Indicator | Question | Computed | Viz | Pri | Data |
|---|---|---|---|---|---|
| **Role-Queue Depth & Load (capacity)** | Staffing problem or process problem? | Per `role` (`EventLog.role`, written by `sim.ts`): count of open instances whose current `eventRef` maps to that role = demand-on-role; crude load proxy | Role-load leaderboard per type + portfolio | P0 | HAVE NOW (`role` exists; current-step→role needs per-wf ontology) |
| **Bottleneck / Constraint Concentration** | Where is time lost across the portfolio? | Per (`eventRef`, `boundedContext`): in-flight queued × dwell-over-baseline, ranked across ALL types | Pareto leaderboard | P0 (waiting count) / P1 (over-run) | HAVE NOW for *waiting count*; over-run NEEDS BASELINE |
| **Flow Efficiency (active ÷ total)** | Slow, or just waiting? | Classify each inter-step `businessAt` gap active vs wait (role/BC transition heuristic + blocked/skipped markers); active ÷ total | Active/wait split bar per type | P1 | HAVE NOW (documented heuristic) |
| **Stage Dwell vs baseline** | Which stage + source system to attack? | Per step: `businessAt` dwell distribution vs baseline; delta + variance, attributed via `boundedContext` | Heatmap (stage × type), box/violin | P1 | NEEDS BASELINE |
| **Lead-time variability (CoV)** | Which process is out of *control* (not just slow)? | std-dev ÷ mean of cycle time per type/step | Box/violin + CoV badge | P1 | NEEDS BASELINE |
| **Flow drill (CFD + Wait-by-hand-off)** | One view for WIP+cycle+queue location | CFD per type (daily count per `eventRef` band) + inter-system wait waterfall | Stacked-area CFD + waterfall | P2 | HAVE NOW (in a drill, not the org board) |

### E. AI & Automation Activity (governance ledger)
*How much is the AI doing, is it right, can I trust it to keep acting. ENTIRE category is NEEDS CAPTURE — see grounding note. Sequenced behind two prerequisites: (i) actor-origin threading through `emit()`, (ii) a real PDP check on runtime writes.*

| Indicator | Question | Computed | Viz | Pri | Data |
|---|---|---|---|---|---|
| **AI vs Human Action Share (autonomy mix)** | How much work is the AI carrying? | State-changing events tagged `ai` (origin = `/chat` write-tools) ÷ total, by type/step | Stacked bar per type | P1 | NEEDS CAPTURE (no actor field on `EventLog`; must thread origin through `emit()`) |
| **Override / Reversal Rate** | Is the AI drifting out of its band? | `ai`-origin action negated/edited by a human on the same entity within window ÷ total AI actions | Trend + "top overridden" table | P1 | NEEDS CAPTURE (origin tag + entity-edit join) |
| **Autonomous (no-touch) completion rate** | Where is realized automation leverage? | Step-advances with only `ai`-origin events ÷ total advances, per type | Gauge per type | P2 | NEEDS CAPTURE |
| **Guardrail / Policy Block Rate** | Are guardrails catching risky actions? | Guardrail-denial events per 100 attempted AI writes, by reason. **Prerequisite: BUILD the guardrail** — today chat write-tools bypass the PDP entirely (only `confirmed:true` gates them); the PDP must first be invoked on runtime writes and emit on DENY | Small-multiples by reason | P2 | NEEDS CAPTURE (guardrail does not exist yet) |
| **AI Actions Awaiting Approval (queue depth/age)** | Is the AI bottlenecked on people? | Open proposals needing sign-off; oldest age; median decision time | Inbox strip (red if past SLA) | P2 | NEEDS CAPTURE (proposal/approval log) |
| **Action Traceability / Reversibility coverage** | EU-AI-Act audit-ready? | % AI actions whose trace carries {actor, reason, tool, provenance, reversal path}; % reversible | Coverage rings | P2 | NEEDS CAPTURE (no AI action is logged to `PlatAuditEvent` today) |

*Cut as vanity:* AI messages/tokens/sessions, flat "AI adoption %", Cycle-Time-Saved-by-AI as a headline (resurfaces only after baseline + actor tag both exist).

### F. Data Freshness, Conformance & Twin Trust (the meta-layer)
*Tells the COO how much to trust every other number on the board.*

| Indicator | Question | Computed | Viz | Pri | Data |
|---|---|---|---|---|---|
| **Twin-Trust / Provenance Mix** | How much is real vs simulated? | `provenanceMeta().steps.real ÷ total` per workflow, summed across portfolio. **Note:** reads ~0% real for a fresh org until adapters are wired — it is a real signal but uniformly "simulated" pre-integration | "X of N steps real" donut + matrix | P0 | HAVE NOW per-wf; **NEEDS-COMPUTE per-portfolio** (multi-ontology roll-up) |
| **Last-event freshness per source** | When did each feed last move? | now − max(`occurredAt`) per `boundedContext`. **The one legitimate use of `occurredAt`.** Shows "last event Nm ago"; CANNOT show SLA-breach red in P0 (no SLA config, and sim bunches `occurredAt` so idle ≠ dead) | Source strip "SAP · 4m ago" (no colour) | P0 | HAVE NOW (no colour) |
| **Data-Conformance** | Does ingested data fit the model? | % instances with derivable `businessAt` (`businessDateFromPayload` ≠ null), no orphaned events, realized path consistent with `linearOrder()` | Conformance % + offender list | P0 | HAVE NOW (`bus.ts` null path + conformance test) |
| **Connector Freshness (SLA-coloured)** | Is any feed silently stale? | now − real `lastPullAt` per source vs per-source SLA; red/green | Traffic-light strip | P1 | NEEDS CAPTURE (`lastPullAt` is interface-only, zero writers; `ingestPull` must write it) |
| **Connector / adapter health** | Is the pipe itself healthy? | `healthcheck()` state, last success, consecutive failures, ingest error rate | Connector status board | P1 | NEEDS CAPTURE (`healthcheck` exists, not persisted) |
| **Volume / event-rate anomaly** | Did a connector die quietly? | Rolling baseline of step-transition counts per type; flag drops > kσ | Anomaly feed | P2 | NEEDS CAPTURE (baselines + persistence) |

### G. Value / Cost of Delay
*Closes the loop from "on time" to "what it costs." Lead with DAYS; € is a later, config-gated layer — never the flagship number until a rate source exists.*

| Indicator | Question | Computed | Viz | Pri | Data |
|---|---|---|---|---|---|
| **Overdue-days at risk (the groundable severity)** | What's the exposure, in the unit we actually have? | Σ projected days beyond commit across open at-risk instances; blast-radius weighting | Days-at-risk headline + by-type bar | P1 | NEEDS BASELINE + commit date (no €) |
| **Contractual penalty exposure** | What does the COO escalate on? | Liquidated-damages schedule × at-risk late customer deliveries — materially sharper than generic carrying cost | Penalty-at-risk by customer/contract | P2 | NEEDS CAPTURE (penalty schedule config) |
| **Cost-of-Delay (carrying)** | What is lateness costing in €? | excess days × per-day carrying rate (config), per workflow; portfolio sum | Value-at-risk waterfall by type | P2 | NEEDS CAPTURE (rate config) |
| **Rework / COPQ split** | What share of cost is firefighting? | Cost attributable to rework/soft-fail steps ÷ total | Standard vs rework bar | P2 | NEEDS CAPTURE (rates) |

*Demoted / cut:* "Cost-to-Serve per instance" (textbook duration×rate ABC with no anchor in this product's data) — cut until a real rate source exists; it would produce numbers no finance team accepts.

**Cut as vanity everywhere** (do not build): total events fired, steps executed, instances touched, AI messages/tokens/sessions, flat "AI adoption %", raw variant counts without € ranking, mean-only cycle time, absolute day-counts compared across types.

---

## 4. Proposed dashboard layout for THIS product

New hash route `#org` (sits above `#` = workflow-type overview). Same visual language as the existing screens: sticky `bg-white/90 backdrop-blur` header, stone/amber palette, `STATUS_TONE` pills, `provChip()` SIM/REC/LIVE badges, bordered cards (`rounded-lg border border-stone-200 bg-white`), amber progress bars. `tenantBar()` breadcrumb becomes **Qlerify › [org] › Portfolio**. **Trend sparklines render only once the snapshot table exists (Phase 0 minimal job); until then the band shows point-in-time tiles, no squiggles** — sparklines over bunched-`occurredAt` recomputed-on-load would be meaningless.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  Qlerify  ▸  Ericsson Networks  ▸  Portfolio                       [subject] [⎋]   │ tenantBar()
├──────────────────────────────────────────────────────────────────────────────────┤
│  Portfolio Overview                                   [⟳ live]  [💬 Ask portfolio] │ sticky header
│  3 workflow types · 142 active instances · last event 12s ago                      │
├──────────────────────────────────────────────────────────────────────────────────┤
│  NORTH-STAR BAND  (normalized, cross-type — POINT-IN-TIME until snapshot job lands) │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐         │
│  │ Active /   │ │ Aging-WIP  │ │ Throughput │ │ Twin Trust │ │ Data Conf. │         │
│  │ Throughput │ │ vs history │ │ Balance    │ │  62% real  │ │   96%      │         │
│  │  142 live  │ │ 26 past85th│ │ 0.93 ⚠     │ │ SIM·REC·LIVE│ │ derivable  │        │
│  │  9/wk      │ │ amber      │ │ <1 = build │ │ donut       │ │ businessAt  │        │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘         │
│   (Commitment Confidence tile appears here the moment baseline + commit-date land)  │
├──────────────────────────────────────────────────────────────────────────────────┤
│  PORTFOLIO GRID — one card per workflow TYPE        [sort: aging ▾]                 │
│  ┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────┐│
│  │ ● Hardware Production     │ │ ● Base-Station Maint.    │ │ ● Customer Impl.     ││
│  │  Active        78         │ │  Active        41        │ │  Active      23      ││
│  │  Past-85th    24 ●        │ │  Past-85th     6         │ │  Past-85th    2      ││
│  │  Throughput  9/wk         │ │  Throughput 14/wk        │ │  Throughput 2/wk     ││
│  │  Cycle idx   1.34× (P90)* │ │  Cycle idx  1.02×*       │ │  Cycle idx  0.96×*   ││
│  │  Oldest: AIR-3239 +18d    │ │  Oldest: BTS-North-07 +3d│ │  Oldest: Cust-07 GoLive││
│  │  Top role-queue: SAP appr.│ │  Top role-queue: Field   │ │  Top role-queue: PM   ││
│  │  Twin: 14/28 real  SIM■■  │ │  Twin: 6/6 real  LIVE■   │ │  Twin: 2/12 real     ││
│  └──────────────────────────┘ └──────────────────────────┘ └──────────────────────┘│
│    (*Cycle idx / on-track-vs-at-risk render once baseline lands; raw N/M before)    │
├──────────────────────────────────────────────────────────────────────────────────┤
│  CROSS-PORTFOLIO EXCEPTION & DISRUPTION FEED   (deduped to root cause, ranked by    │
│  OVERDUE-DAYS + blast radius — groundable severity first, € never here)  [filter ▾] │
│  ──────────────────────────────────────────────────────────────────────────────── │
│  🔴 SAP PO approval — 34 waiting · 3 types · +210 over-run days (vs baseline)        │
│  🔴 AIR-3239 build kicked back to planning (rework loop ×2) · Hardware · +18d        │
│  🟠 Helix demand change → blast radius 9 instances / 2 customers · +18 delay-days     │
│  🟠 6 maintenance jobs aging past their own 85th percentile                          │
│        each row: [age] [owner-role] [→ open instance]                                │
├──────────────────────────────────────────────────────────────────────────────────┤
│  FLOW · BOTTLENECK · CAPACITY                                                        │
│  ┌─ Bottleneck + role-load leaderboard ────────┐ ┌─ Aging-WIP (all open) ─────────┐ │
│  │ Step (system)     waiting  over-run  role-ld │ │  age▲   . .  :  ·              │ │
│  │ SAP PO approval     34      210d*    2 appr. │ │  85th━━━━●━━━━━━━●━━━━━━ (red)  │ │
│  │ Test sign-off       11       64d*    1 eng.  │ │  50th────·──·──·───────         │ │
│  │ Helix build start    8       40d*    3 plan. │ │       step → (1..28)           │ │
│  └──────────────────────────────────────────────┘ └────────────────────────────────┘ │
│  ┌─ Flow efficiency (active vs wait, per type — P1) ────────────────────────────┐   │
│  │ Hardware Prod  ▓▓▓░░░░░░░░░░░░░░░  17% active · 83% wait (mostly SAP→Helix)    │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│    (*over-run vs baseline; waiting-count + role-load are HAVE-NOW)                   │
├──────────────────────────────────────────────────────────────────────────────────┤
│  AI ACTIVITY & TRUST    (greyed "needs instrumentation" until actor-origin lands)   │
│  ┌─ Autonomy mix (P1) ──┐ ┌─ Override (P1) ─────┐ ┌─ Guardrail / approvals (P2) ───┐ │
│  │ AI ▓▓▓░ 31% / Human   │ │ Override   4.2%     │ │ requires PDP-on-write (not built)│ │
│  │ needs origin tag      │ │ needs origin tag    │ │  + approval log                  │ │
│  └─────────────────────┘ └─────────────────────┘ └─────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────────────────┤
│  DATA FRESHNESS / CONNECTOR STRIP   (P0 shows "last event Nm ago"; SLA colour = P1) │
│  SAP · 4m ago   Helix · 1h ago   PRIM · —   MES · 30s ago   Test · 2h ago   Logi · — │
│       (click → adapter workbench #bc/<name>; red SLA colouring lands with lastPullAt)│
└──────────────────────────────────────────────────────────────────────────────────┘
       [💬 Ask portfolio]  ← org-scoped assistant (right sidebar, reuses chatPanel())
```

**North-star band (honest P0)** = Active/Throughput, Aging-WIP-vs-own-history, Throughput Balance, Twin Trust, Data-Conformance — the five things genuinely computable from `EventLog` + `linearOrder()` + the derived baseline today. Commitment Confidence joins the band the moment baseline + commit-date land. **Portfolio grid** = one card per workflow TYPE (raw N/M progress + role-queue head HAVE-NOW; cycle-idx and on-track/at-risk render once baseline lands). **Exception feed** = inbox deduped to root cause, ranked by overdue-DAYS + blast radius (not €). **Flow/Capacity** = bottleneck + role-load leaderboard (waiting-count and role-load HAVE-NOW; over-run after baseline) + aging scatter. **AI panel** = explicitly greyed until actor-origin instrumentation exists. **Freshness strip** = "last event N ago" now; SLA colour after `lastPullAt`.

---

## 5. Drill-down model

Three tiers; every KPI is a navigation handle, never a dead number.

```
#org  (NEW — portfolio control tower)
  │
  │  Portfolio grid card  ─────────────────────►  #  (existing Workflow-Type Overview)
  │     "Active 78" / role-queue head                "All <plural> in flight" table
  │
  │  North-star tile (Aging-WIP past-85th) ───────►  # pre-filtered to past-85th cohort
  │
  │  Exception feed row ──────────────────────────►  #case/<id>  (existing Instance Detail)
  │     "AIR-3239 +18d"                                28-step timeline + per-BC cards
  │
  │  Bottleneck / role-queue row ─────────────────►  #  filtered to instances stuck at that eventRef
  │     "SAP PO approval · 34 waiting"                 (cohort drill)
  │
  │  Aging-WIP dot ───────────────────────────────►  #case/<id>
  │
  │  Freshness strip chip ("SAP · 4m ago") ───────►  #bc/SAP  (existing adapter workbench)
  │
  └─ AI approval inbox (once it exists) ──────────►  #case/<id> with chat open + proposal context
```

Per-KPI link contract:
- **Portfolio grid card / role-queue head** → existing **Workflow-Type Overview** (`#`), active workflow switched via `currentWorkflowId`.
- **Aging-WIP past-85th / Predicted breaches / Commitment Confidence** → overview filtered to the at-risk cohort.
- **Exception feed / Aging-WIP dot / Oldest** → existing **Instance Detail** (`#case/<id>`) — the 28-step timeline already visualizes the disruption.
- **Bottleneck / role-queue row** → overview filtered to instances at that `eventRef` (cohort).
- **Freshness / Connector chip** → existing **Adapter workbench** (`#bc/<name>`).
- **AI approval inbox** → Instance Detail with `chatPanel()` open and the pending proposal in context.

---

## 6. Build plan, grounded in the codebase

### Phase 0 — Thin slice: cross-workflow aggregation + the derived baseline

**Goal:** a working `#org` page with an *honest* north-star band (Active/Throughput, Aging-WIP-vs-own-history, Throughput Balance, Twin Trust, Data-Conformance), portfolio grid, exception feed, and bottleneck+role-load leaderboard — every number computed from data that exists today, *including the derived baseline*.

**The three real Phase-0 risks the headline must not soft-pedal:**

1. **Multi-ontology resolution (the actual hard part).** `getOntology()` is a **process-global singleton swapped per active workflow**; `genericListInstances()` (`src/twin/sim.ts:305`) and `eventLogOrgWhere()` (`src/events/event-scope.ts`) are single-workflow-scoped via `currentWorkflowId()`. *Raw counts* (active, throughput-by-week, rework loops, role values) can come from a direct `prisma.eventLog.groupBy` keyed by `workflowId` (`EventLog` carries `workflowId` + `organizationId`, indexed `[workflowId, occurredAt]`, `prisma/schema.prisma`). But **progress, terminal-`eventRef` detection, `linearOrder()` length, current-step→role mapping, and `provenanceMeta()` all require each workflow's ontology** — and the codebase is *not* structured to load multiple ontologies without globally swapping the singleton. **P0 must build a new read-only multi-ontology-resolution path** that loads each workflow's `PlatOntology.currentContent` into a *local* structure (not the global) and maps `eventRef`→step-ordinal/role/BC per workflow. This is the central Phase-0 engineering task.

2. **Access control on the workflow list.** `GET /v1/workflows` (`src/platform/http/control-routes.ts:455`) is **org-admin-gated (`assertOrgAdmin`)**. The org dashboard is meant to be viewer-accessible (Open Decision #5). P0 needs **either a new viewer-scoped cross-workflow list endpoint or a relaxed gate** — this is a real access-control decision, not solved plumbing.

3. **Twin-Trust is per-workflow today, not portfolio.** `provenanceMeta()` (`src/twin/provenance.ts:79`) and `/sim/meta` compute over the *currently active* workflow. The portfolio donut **NEEDS-COMPUTE**: sum across workflows via the same multi-ontology path. (And it reads ~0% real until adapters are wired — present it as a real-but-pre-integration signal.)

**Phase-0 tasks:**

1. **New cross-workflow aggregation endpoint** `GET /org/portfolio/summary` (alongside `/sim/meta` in `src/http/routes.ts`), built on the multi-ontology-resolution path above and a viewer-scoped workflow list. Tenant scoping is automatic (RequestContext `organizationId` from auth; the new endpoint inherits it — no cross-org leakage).
2. **Derive the keystone baseline IN P0** (zero new capture, pure aggregation): a **rolling P50 of the `businessAt` gap per `(workflowId, eventRef)`** over completed instances. The chat prompt already defines per-step duration as `businessAt[i+1] − businessAt[i]` (`src/chat/system-prompt.ts:70-76`). Materialize it in a small cached map / `_app_meta`-style table keyed by `(workflowId, eventRef)`. **Guard survivorship bias** by including censored ages of still-open instances. This single `groupBy` unlocks Cycle-Time Index, Aging-vs-percentile, At-Risk, Bottleneck over-run, Commitment Confidence and Slack.
3. **Compute today, no new capture:** active count, throughput (terminal-`eventRef` by `businessAt` week), throughput balance + open-WIP sparkline, rework loops (repeated `eventRef`), synthesis soft-fail rate (payload `{skipped,error}` from `sim.ts` genericStep catch — **labelled as twin-synthesis failure, NOT business exception**), Aging-WIP vs the type's own derived percentiles, **role-queue depth** (`EventLog.role` + current-step→role), **Data-Conformance** (`businessDateFromPayload()` null rate per `bus.ts`, orphan/path checks via the existing conformance test logic), and **Twin-Trust** summed across workflows.
4. **Minimal daily-snapshot job IN P0** (small, cross-cutting): write one row per (org, day, KPI) so the north-star band can show *real* trends. Until it has accumulated history, **render point-in-time tiles with no sparklines** — do not draw trends over bunched-`occurredAt` recomputed-on-load data.
5. **Frontend** (`web/app.js`): add `#org` to `parseHash()`/`onHashChange()`, a `portfolioView()` returning the wireframe HTML (reuse `STATUS_TONE`, `provChip()`, card/table/progress patterns), `loadPortfolio()` hitting the new endpoint, a `render()` branch wrapping `tenantBar()` + `portfolioView()` + `chatPanel()`, and `bindPortfolio()` for `data-go` drill-downs. Poll every 5s (mirror the existing `/sim/cases` poll). Add an **"All workflows"** entry to the switcher in `tenantBar()` routing to `#org`.

### Phase 1 — Commit date, at-risk engine, flow, capacity, AI actor tagging

**Open Decisions #1 (baseline source) and #2 (commit-date/qty location) are P0 BLOCKERS for the predictive half** — frame them as prerequisites, not refinements. The baseline is built in P0; the commit-date *mapping* must be answered before any Confidence/OTIF/Slack number is honest.

- **Commit date (the gating capture).** `businessDateFromPayload()` (`src/events/bus.ts:94-128`) is a **name/type heuristic** that picks *any* date-ish field — it **cannot** distinguish a commitment/due date from a created-date. There is **no guarantee** a given model's payload even carries a promise date. Add a small **per-workflow config mapping** ("which payload field is the commitment date / ordered-qty / delivered-qty"), with the heuristic only as a last-resort fallback. Until this exists, OTIF/Confidence/Slack are uncomputable — surface **Commitment Data Coverage** (P0) so every downstream number is honestly scoped to the scorable subset.
- **At-risk engine (build it — it does not exist).** There is **no server-side at-risk computation today**; the `≥10-day` constant at `app.js:1754` is a **client-side timeline-gap display heuristic** in the detail view, *not* a classifier — lifting it does not give an engine. Build: flag open instance at-risk if `dwell_in_step > k×baseline(eventRef)` OR `cumulative_age > Σ baseline(steps-so-far)` OR `now + Σ baseline(remaining) > commit_date`. Tie at-risk to **predicted commit-date impact (severity)**, not any deviation, to avoid alert fatigue. `k` and the confidence threshold start as org config.
- **Flow efficiency / stage-dwell / CoV / over-run bottleneck:** all unlock from the P0 baseline + `businessAt` gaps + `boundedContext`; document the active-vs-wait classification heuristic (role/BC transition + explicit blocked/skipped markers).
- **Capacity beyond demand:** layer a real per-role capacity input (head-count config) onto the P0 role-queue depth to turn "demand-on-role" into true utilization.
- **AI actor-origin tagging — call it out as a discrete, early, cross-cutting workstream (it gates ALL of Section E).** `EventLog` has **no actor identity** — `emit()` (`src/events/bus.ts:130`) stamps `role` (a domain lane like Buyer/Planner, *not* human-vs-AI), `organizationId`, `workflowId`, but **no `actorPrincipalId` and no caller origin**. Chat write-tools (`src/chat/tools.ts`) call the **same** `genericStep`/`genericNewInstance`/`ingestPull` path as a human step-forward, so emitted rows are byte-identical. Origin must be **threaded from request context through `withScope` (or a new AsyncLocalStorage) into `emit()`, or stamped into `payload` by the chat tool** — this is real instrumentation, *not* the "no schema change needed" inference the draft implied. Once tagged: AI vs Human Share and Override Rate become computable.
- **Endpoints:** `GET /org/workflows/:id/analytics` (per-type KPIs), `GET /org/disruptions` (deduped feed), `GET /org/bottlenecks`, `GET /org/capacity`.

### Phase 2 — Predictive, AI governance (build-the-guardrail), freshness, dependency, value

- **Build the guardrail BEFORE its metric.** Today chat write-tools are gated **only** by a `confirmed:true` argument check; the PDP `authorize()` (`src/platform/pdp/index.ts`) governs **control-plane resource access only and is never invoked on runtime/chat writes**, and it **emits nothing on DENY**. "Guardrail Block Rate" therefore requires *first* inserting a PDP check on runtime writes, *then* emitting a guardrail-denial event. This is a substantial, previously-hidden prerequisite — sequence it explicitly.
- **AI governance ledger:** log AI proposals + accept/reject/revert outcomes; route AI-action traces to `PlatAuditEvent` (hash-chained, `src/platform/audit/index.ts` — currently wired only into control-plane authz/provisioning, **never** the chat write-tools or `genericStep`). Only then are Override Rate, Block Rate, Approval queue and Traceability coverage real.
- **Connector freshness (SLA-coloured):** wire the **already-defined-but-unwritten `AdapterConfig.lastPullAt`** (`src/packs/types.ts:79` — interface only, **zero writers**); have `ingestPull()` (`src/packs/ingest.ts`) write it and persist `healthcheck()` results. Add per-source freshness SLA config so the strip can turn red. (`AdapterMode.at` is written today but is "mode last changed," **not** a per-pull freshness signal — do not conflate.)
- **Real exception / Test-fail signal:** there is **no** Test bounded context and **no** error-typed/domain-failure event today; capturing genuine exceptions (distinct from synthesis soft-fails) is new instrumentation feeding Section C's exception Pareto and MTTD/MTTA/MTTR.
- **Cross-Type Dependency Readiness (program-director keystone):** model the structural interlock — a customer-implementation go-live that cannot start until N hardware-production instances deliver — as upstream-feeds-downstream readiness + cross-type critical path. NEEDS CAPTURE (a dependency declaration between workflow types).
- **Predictive:** Monte-Carlo P85 finish from per-`eventRef` historical `businessAt` distributions, surfaced **only** as the engine behind Confidence/Slack; multi-window burn-rate alerting.
- **Blast radius:** join instances on shared payload keys (PO id, part, customer) from the source snapshots already in `payload`.
- **Value layer (days-first, € last):** lead with overdue-days-at-risk (P1, from baseline + commit date); add penalty-schedule config for **Contractual penalty exposure**, then a per-day carrying-rate table for Cost-of-Delay. Label € as *directional operational estimate*; reconcile to SAP payload cost lines where present.

**Architectural guardrails throughout:** all timing math uses **`businessAt`, never `occurredAt`** (the synchronous `/sim/run-all` loop bunches `occurredAt` within milliseconds — `occurredAt` is legitimate *only* for last-event freshness). Never aggregate raw day-counts across types — normalize to %/ratio/index against each type's own baseline. Always show P50/P90, never mean-only. Gate/annotate every KPI with provenance so simulated steps aren't read as fact. Render no trend line before the snapshot table backs it. Tenant scoping is automatic via RequestContext `organizationId`.

---

## 7. Open decisions for the user

1. **Expected-duration baseline source (P0 — already built as derived).** Default: **derived rolling P50 of `businessAt` gaps per `(workflowId, eventRef)`** (zero config, existing data, with survivorship-bias censoring). Do you also want a **model-author override** (`overlay.json` per-step `+Nd` targets / contractual SLAs), and which wins when both exist?

2. **Commitment date + ordered/delivered quantity location (P0 BLOCKER — gates the entire predictive/OTIF half).** `businessDateFromPayload()` cannot semantically distinguish a promise date from a created-date, and no model is guaranteed to carry one. Is there a reliable payload field per workflow type, or do we add a per-workflow config mapping? Until answered, Confidence/OTIF/Slack cannot ship — only **Commitment Data Coverage** (how scorable the portfolio even is) can.

3. **AI actor-origin + guardrail (gates ALL of Section E, and is bigger than "tagging").** Confirmed against code: `EventLog` has **no actor field**, chat write-tools share the human `genericStep` path, the PDP is **never** invoked on runtime writes (only `confirmed:true` gates them), and `recordAudit` is **never** called from the chat/runtime path. So the AI panel needs (a) actor-origin threaded through `emit()` and (b) a real PDP-on-write guardrail before any autonomy/override/block-rate number exists. Do you want these built, and in which order?

4. **How are workflow TYPES registered and grouped?** The grid is "one card per workflow type." Is each `PlatWorkflow` a distinct *type*, or do multiple workflows share a type (needing a `type`/`template` label)? This decides whether the grid is 1:1 with workflows or rolls several into one type card.

5. **Org-dashboard access tier + assistant scope.** `GET /v1/workflows` is **org-admin-gated** — viewer access (Open Decision goal) needs a new viewer-scoped cross-workflow list endpoint or a relaxed gate. Should `#org` be viewer-readable with admin-gated sub-panels (AI governance, audit)? Should the org assistant get **cross-workflow tools** (`list_workflows`, `org_health_summary`) and may it **write across workflows**, or read-only at portfolio level with writes only after drilling into an instance?

6. **Scale / freshness budget.** For thousands of instances across dozens of workflows: compute portfolio KPIs **on-demand** (simpler, acceptable lag) or rely on the **periodic snapshot rows** (needed for real trends and to avoid the 50-round-trip activate-each-workflow scan — the multi-ontology path computes from a `groupBy` instead)? And what per-source **freshness SLA** turns a connector chip red (SAP minutes-stale OK; Test/MES seconds) — noting this is meaningful only once real `lastPullAt` is written, since sim-bunched `occurredAt` cannot distinguish a dead feed from an idle workflow?

---

## Sources (78)

- **20 Supply Chain KPIs & Metrics Every Leader Should Track in 2026 (3SC)** — <https://3scsolution.com/insight/supply-chain-kpis-metrics>  
  OTIF (stricter than OTD: on-time AND in-full), order cycle time, perfect order rate, fill rate, supplier OTD, cash-to-cash, supply-chain cost % — clean one-line definitions usable as KPI formulas.
- **Project Management / Executive Portfolio Dashboard guide 2026 (Rocketlane)** — <https://www.rocketlane.com/blogs/project-management-dashboard>  
  Execs use portfolio dashboards to simplify many metrics into a small set of interpretable signals for delivery decisions — supports the composite health roll-up and decision-first design.
- **UiPath Process Mining — Working with dashboards and charts** — <https://docs.uipath.com/process-mining/automation-cloud/latest/user-guide/working-with-dashboards-and-charts>  
  Defines Event throughput time (gap between consecutive event ends, incl. wait) vs Event cycle time (event start to end) from an event log — the exact basis for the dwell/wait-share and cycle-time decomposition here.
- **2026 Guide to Building KPI Dashboards that Highlight Lagging Departments (Sirion)** — <https://www.sirion.ai/library/contract-insights/kpi-dashboards-lagging-departments/>  
  Flag rising backlog aging, low on-time delivery, high exception rates; protect margin via budget variance, cost-to-serve trends, throughput bottlenecks — direct support for at-risk/aging, exception-rate, cost-to-serve and bottleneck indicators.
- **SLA Metrics To Track For Performance (EasyDesk) + 2026 SLA scorecard practice** — <https://easydesk.app/blog/sla-metrics>  
  2026 SLAs bundle multiple metrics into one real-time, filterable (priority/customer/channel) scorecard blending operational and experience indicators — basis for step-level SLA/commitment adherence.
- **Escalation Rate — KPI Definition, Formula & Benchmarks (KPI Depot)** — <https://kpidepot.com/kpi/escalation-rate>  
  Escalation rate = % of items escalated to a higher tier, target typically <5%; rising rate signals unresolved issues — gives the benchmark tripwire for the escalation/exception indicator.
- **Yield – First-Pass & Final Yield / KPI design (SG Systems Global)** — <https://sgsystemsglobal.com/glossary/yield-first-pass-final-yield/>  
  FPY is a lagging outcome to balance with leading predictive KPIs; start from the decision (sequence/release/escalate/approve) then build the KPI — supports decision-first design and in-full / first-pass framing.
- **What Is Cost To Serve? A Framework for Profitability (Coupa) / Easy Metrics** — <https://www.coupa.com/blog/cost-serve-framework-for-profitability-and-customer-excellence/>  
  Cost-to-serve = activity cost (materials, production, transport, warehousing, distribution) to meet a customer's requirements; reveals waste per customer — basis for the cost-to-serve-per-instance indicator.
- **Measuring AI ROI: The CFO's Five-Metric Dashboard for 2026 (C-Suite Strategy)** — <https://www.c-suite-strategy.com/measuring-ai-roi-the-cfos-five-metric-dashboard-for-2026-capital-review>  
  Names cost-to-serve delta, cycle-time compression on priority workflows, revenue/FTE, decision-quality and capital efficiency as the board metric set — supports cost-to-serve delta as a 2026 command-center trend.
- **Process Mining to Forecast the Future of Running Cases (Springer / ResearchGate)** — <https://link.springer.com/chapter/10.1007/978-3-319-08407-7_5>  
  Predictive process monitoring predicts remaining time, next event, risk of constraint violation and final outcome of RUNNING cases — the methodological basis for Commitment Confidence and predicted-breach at-risk flagging.
- **Top 50 Predictive Process Mining Use Cases (AIMultiple)** — <https://research.aimultiple.com/predictive-process-mining/>  
  Predictive/prescriptive analytics forecast delivery delays, compliance risk and bottlenecks before financial impact — confirms 2026 mainstreaming of forward-looking, intervene-early operational metrics.
- **COO Dashboard: Definition, Benefits and Examples (Toucan Toco)** — <https://www.toucantoco.com/en/blog/coo-dashboard-definition-benefits-and-3-examples>  
  A COO dashboard focuses on execution, efficiency, service levels and operational risk — whether processes are creating delays, cost increases, or customer issues; frames the four executive questions the indicator set answers.
- **Celonis — Process-analysis platform (Analyze Processes)** — <https://www.celonis.com/platform/process-analysis>  
  Vendor reference for the core org-level metric set: end-to-end flow visualization, bottleneck detection, conformance/deviation monitoring, and tying findings to value opportunities.
- **Celonis — Configuring an execution-gap list** — <https://docs.celonis.com/en/execution-gap-list.html>  
  Defines 'execution gaps' = auto-detected anomalies that impact a KPI, each with occurrences and current EUR impact — the model behind the value-at-risk / ranked-gap-list indicator.
- **Celonis — Setting up value tracking / Framing value opportunities** — <https://docs.celonis.com/en/setting-up-value-tracking.html>  
  Shows how framed value is computed from potential KPI improvement and tracked over a year — the canonical 'tie metrics to money' mechanism (value framework).
- **UiPath Process Mining — Conformance checking & custom throughput-time metrics** — <https://docs.uipath.com/process-mining/automation-cloud/latest/user-guide/conformance-checking>  
  Concrete definitions for conformance checking against a reference model and computing throughput time with datediff over event timestamps — directly portable to the step stream.
- **QPR — 5 Process Mining Examples (AP, O2C, IT, Audit, HR)** — <https://www.qpr.com/blog/5-process-mining-examples>  
  Money-tied outcomes per function: late-payment reduction, O2C throughput +60% / conformance 40%→80%, IT +25% touchless = EUR 1M/yr, HR median duration -90%. Good source for which KPIs map to cash.
- **AIMultiple — Process Mining trends, use cases & 2026 stats** — <https://aimultiple.com/process-mining-use-cases>  
  2026 trend + stat source: OCPM (object-centric) for cross-process aggregation, ~52% rework-time and ~43% bottleneck reductions, automation-enabler framing, 25% AI-integrated / 74% planning, agentic/prescriptive direction.
- **SiliconANGLE — Celonis process intelligence turns enterprise AI into ROI (Celosphere 2026)** — <https://siliconangle.com/2026/02/05/celonis-process-intelligence-enterprise-ai-roi-celosphere/>  
  2026 positioning: process intelligence as the execution/context layer for enterprise AI; 89% say AI ROI needs business context (rules/KPIs/benchmarks). Frames the value-realization-over-features trend.
- **Deloitte Global Process Mining Survey 2025 (cited via search)** — <https://www.celonis.com/insights/reports/process-optimization>  
  Adoption/value statistics: 80% agree process mining adds value, 59% now expect measurable cost savings (up from 46%). Used for the money-expectation trend; figure cited from search summary, not directly fetched.
- **IBM Multilevel / Object-Centric Process Mining (arXiv 2512.03906) & Intelligent Cross-Organizational Process Mining (arXiv 2407.11280)** — <https://arxiv.org/pdf/2512.03906>  
  Academic grounding for OCPM / multilevel mining and cross-organizational aggregation — basis for the cascading-disruption / blast-radius indicator across systems and instances.
- **Author knowledge (cutoff Jan 2026) — process-mining metric definitions**  
  Standard definitions of throughput/wait/work-time decomposition, rework/loop detection via back-edges, variant analysis, happy-path coverage, and WIP/aging — synthesized to map each KPI onto an event/step stream. Not from a single fetched URL.
- **Supply Chain Control Towers: From Visibility to Real-Time Orchestration in 2026 (FreightPulse)** — <https://freightpulsehq.com/blog/supply-chain-control-towers-orchestration-2026>  
  Fetched. Concrete numbers for predictive ETA (>90% accuracy, 8-24h horizon), disruption prediction with confidence, and exception-resolution generations (4-8h to 5-15min) plus 60-70% autonomous resolution and 8-15% exception baseline — basis for the velocity and at-risk indicators.
- **10 Best Supply Chain Control Tower Providers in 2026 (Locus)** — <https://locus.sh/blogs/best-supply-chain-control-tower-providers/>  
  Vendor-landscape view; predictive delay models cited at 85-92% accuracy at a 14-day horizon and supplier-portal lead-time-variability reductions — supports predicted-late and ETA framing.
- **Market Guide / Quick Answer: What Is a Digital Twin of an Organization? (Gartner)** — <https://www.gartner.com/en/documents/4004172>  
  Gartner's DTO definition: dynamic, operational-and-contextual-data model that connects to current state, responds to change, and simulates future states — validates the org-level twin as a recognized 2026 category. (Knowledge + search; full doc gated.)
- **Magic Quadrant for Digital Twin of an Organization Platforms (Gartner, 2026)** — <https://www.gartner.com/reviews/market/digital-twin-of-an-organization-platforms>  
  Confirms DTO became a formally evaluated market in 2026 (Magic Quadrant + Market Guide), with vendors arriving from process-mining and enterprise-architecture backgrounds.
- **Digital Twins in 2026: Simulation, Real-Time Control, and Industrial ROI (The Backend Developers)** — <https://thebackenddevelopers.substack.com/p/digital-twins-in-2026-simulation>  
  Frames 2026 digital twins as operational systems with bidirectional live-data coupling tuned for prediction and intervention — supports the feed-freshness / trust-the-twin and write-back-guardrail points.
- **What Is a Digital Twin of Operations? (Skan.ai)** — <https://www.skan.ai/blogs/what-is-a-digital-twin-of-operations>  
  Notes event-log-based tools capture only ~15-20% of actual work — the caution behind the snapshot-bias and feed-health pitfalls and the case for multi-source snapshots.
- **Ripple effect in the supply chain network: forward and backward disruption propagation (PMC)** — <https://pmc.ncbi.nlm.nih.gov/articles/PMC7546950/>  
  Foundational ripple-effect work distinguishing forward vs. backward propagation and network health — theoretical basis for the disruption-propagation / blast-radius index.
- **Investigating disruption propagation and resilience of supply chain networks: interplay of tiers and connections (Taylor & Francis, 2025)** — <https://www.tandfonline.com/doi/full/10.1080/00207543.2025.2470348>  
  Quantifies cascading delay through tiers (1.99 iterations at 2 tiers to 39.78 at 7) and non-linear chokepoint impact — supports modeling propagated delay-days, not just affected-count.
- **How AI models prevent SLA breaches in service management (2026) (monday.com)** — <https://monday.com/blog/service/ai-models-prevent-sla-breaches/>  
  Predictive breach-probability framing ('72% chance of breaching SLA') from backlog/capacity/history — the pattern adapted for per-instance on-time probability and time-to-breach.
- **Incident Management Metrics: MTTD / MTTA / MTTR definitions & formulas (InvGate)** — <https://blog.invgate.com/incident-management-metrics>  
  Clean definitions and formulas for MTTD/MTTA/MTTR adapted to operational exception management (detect-to-resolve velocity and the open-exception funnel).
- **Cycle time, throughput and aging WIP (Atlassian / Businessmap)** — <https://businessmap.io/kanban-resources/kanban-analytics/kanban-aging-wip>  
  Aging-WIP, throughput, cycle-time and bottleneck-by-stage flow concepts applied to exception aging, stage dwell-time, and throughput/cycle-time trend indicators.
- **7 Top Operations Dashboard Examples & Templates to Use in 2026 (FlyDash)** — <https://flydash.io/blogs/operations-dashboard-examples>  
  2026 ops-dashboard guidance emphasizing surfacing bottlenecks and flagging issues before escalation across heterogeneous operations — informs the bottleneck-concentration and portfolio-layout choices.
- **What Is OTIF? On-Time In-Full Meaning & Supply Chain Guide — FourKites** — <https://www.fourkites.com/blogs/maximizing-on-time-in-full-otif-in-the-supply-chain/>  
  OTIF = both on-time (delivery window) AND in-full (exact qty); both must hold per order. Walmart mandate escalated 75%→98%, anchoring the ~95%+ world-class benchmark.
- **Average Age of Work in Progress — Nave** — <https://getnave.com/blog/average-age-of-work-in-progress/>  
  Work-item age = start→now; average = sum of ages / item count. Aging WIP is a leading indicator of cycle-time blowups and bottlenecks; 70th-percentile = expedite/SLE line — the basis for the aging-WIP at-risk metric.
- **Impact of Lead Time Variability on Supply Chain Performance (DDMRP) — Patrick Rigoni** — <https://www.patrickrigoni.ch/material-requirement-planning/impact-lead-time-variability-supply-chain-performance-ddmrp/>  
  Variability (not average) drives safety stock and broken service levels; supports measuring spread/CoV over the mean.
- **Supply Chain Control Tower Metrics & Critical Business KPIs — SciKiQ** — <https://scikiq.com/blog/scikiq-supply-chain-control-tower/>  
  Control towers give real-time end-to-end visibility and auto-flag anomalies (supplier lead time creeping above average, shipments off schedule) — the 'visibility→action' 2026 framing for this dashboard.
- **Supplier KPIs measure input reliability before disruptions cascade — Prokuria (Modern Supply Chain KPIs)** — <https://www.prokuria.com/post/modern-supply-chain-kpis-building-resilience-and-visibility-through-data>  
  Frames supplier reliability and material shortage as upstream signals that prevent cascading production delays/premium freight — basis for the supplier index and at-risk-order rate.
- **What is Mean Time to Repair/Recovery (MTTR)? — IBM / Splunk / Fiix** — <https://www.ibm.com/think/topics/mttr>  
  MTTR = total downtime / number of failure (recovery) events, covering detect→diagnose→repair→handback; manufacturing target often <5h. Grounds the disruption-recovery indicator.
- **Gartner Supply Chain Top 25 for 2026 / Benchmarking** — <https://www.gartner.com/en/newsroom/press-releases/2026-06-17-gartner-announces-2026-rankings-of-the-global-supply-chain-top-25>  
  2026 macro-trends incl. 'Autonomous Workforce'; Gartner Hierarchy of Supply Chain Metrics ties forecast error/inventory to perfect-order fulfilment — supports the provenance/autonomy trend and OTIF↔perfect-order linkage.
- **Manufacturing KPIs: The 25 Metrics That Actually Matter in 2026 — iFactory** — <https://ifactoryapp.com/analytics-reporting/manufacturing-kpis-25-metrics-that-matter-2026>  
  Tiered KPI dashboards (operator/plant/exec) with OEE, schedule attainment, OTIF, PM compliance, MTTR — confirms audience-tiered, schedule-adherence-centric design for the portfolio (exec) tier.
- **Understanding Plan, Actual and Target Cost in Manufacturing Orders — SAP Community** — <https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-members/understanding-plan-actual-and-target-cost-in-manufacturing-orders/ba-p/13742110>  
  Planned vs actual production-order semantics (planned = estimate, actual = realized) — grounds the schedule-adherence plan-vs-actual diff against each step's expected baseline.
- **qlerify-live event model (prisma/schema.prisma EventLog + src/twin/sim.ts + src/twin/provenance.ts)** — <file:///Users/staffanpalopaa/work/qlerify-live/.claude/worktrees/organisation-dashboard/prisma/schema.prisma>  
  Verified the exact event-stream fields each indicator is computed from: caseId (instance), workflowId+boundedContext (type+source system), eventRef vs ont.linearOrder() (step progress), businessAt vs occurredAt (business vs wall-clock time), payload (source-system snapshot), provenance simulated|recorded|live, and the {skipped,error} soft-fail marker in sim.ts.
- **Managing Work in Progress (WIP) / Aging WIP — Businessmap (Kanbanize)** — <https://businessmap.io/kanban-resources/kanban-analytics/kanban-aging-wip>  
  Aging WIP = days each task has spent in its current stage; plotted by stage with WIP counts; recommends automatic alerts when an item exceeds its usual time — basis for the percentile-band aging indicator.
- **Portfolio Flow Metrics in SAFe: Deep Dive — agility-at-scale.com** — <https://agility-at-scale.com/safe/lpm/flow-metrics-deep-dive/>  
  Precise definitions of flow velocity/time/load/efficiency/distribution/predictability; flow efficiency example (15 active of 90 days = ~17%) and that <=15% is typical — directly grounds the efficiency and predictability indicators.
- **Flow Load — Is Demand Outweighing Capacity? — Tasktop/Planview Blog** — <https://blog.planview.com/flow-load/>  
  Flow Load = active WIP in a value stream and a leading driver of flow time and velocity degradation — basis for the WIP/Flow-Load-vs-capacity indicator and the overload trend.
- **Using Flow Metrics to Optimize Software Delivery — Planview** — <https://www.planview.com/resources/articles/using-flow-metrics-to-optimize-software-delivery/>  
  Flow Framework canonical metric set (velocity, time, load, efficiency, distribution) and value-stream decomposition; supports the throughput, distribution, and per-source-system contribution indicators.
- **Agile Forecasting: Monte Carlo Simulations and Flow Metrics — 55degrees** — <https://www.55degrees.se/blog/post/agile-forecasting-monte-carlo-simulations-and-flow-metrics>  
  Monte Carlo over historical throughput to produce P-confidence completion dates; 50/85/95 confidence conventions — grounds the forecast-vs-commitment and on-track% indicator and SLE guidance.
- **Kanban metrics: A comprehensive guide — Wrike** — <https://www.wrike.com/kanban-guide/kanban-metrics/>  
  Practitioner definitions of cycle time, throughput, WIP and the Cumulative Flow Diagram (band width = WIP, gaps = cycle time, flat top = stalled throughput) — basis for the CFD and cycle-time indicators.
- **Flow Efficiency — Where is the Waste in Your Software Delivery Process? — Tasktop/Planview** — <https://blog.planview.com/flow-efficiency/>  
  Flow efficiency = active time / total flow time exposing hidden wait; reinforces the 'waiting iceberg' framing and the active-vs-blocked computation for the digital-twin hand-off context.
- **Boosting Efficiency with WIP Aging Insights and Tools — Marat Kiniabulatov (Agile Coach/PMO)** — <https://kiniabulatov.com/2025/10/29/boosting-efficiency-with-wip-aging-insights-and-tools/>  
  2025 practitioner write-up positioning WIP aging as the actionable leading indicator for intervention while work is active — current-source support for prioritizing aging over lagging metrics.
- **Flow, Queue, and WIP at scale — Agileseekers** — <https://agileseekers.com/blog/flow-queue-and-wip-at-scale-how-to-measure-and-improve>  
  Scaling flow/queue/WIP measurement beyond a single team — supports the portfolio normalization and rollup approach across heterogeneous workflow types.
- **SAFe Flow Metrics: Six Measures of Value Delivery — agility-at-scale.com** — <https://agility-at-scale.com/safe/team-technical-agility/flow-metrics/>  
  The six flow measures and predictability/distribution framing used for the RAG rollup and flow-distribution indicators.
- **Internal: EventLog schema + simulator step model (prisma/schema.prisma, src/twin/sim.ts, src/events/clock.ts)** — <file:///Users/staffanpalopaa/work/qlerify-live/.claude/worktrees/organisation-dashboard/prisma/schema.prisma>  
  Confirms the computable substrate: per step-event eventRef/step-index, caseId (instance), businessAt (duration clock, NOT occurredAt), boundedContext/role, payload snapshot, provenance — every indicator above maps to a query over these fields.
- **Measuring Agentic AI: KPIs That Matter — Oteemo** — <https://oteemo.com/blog/kpis-measuring-agentic-ai/>  
  Names autonomous-completion rate as the single most important operational metric; lists task accuracy, capacity-without-headcount, error-cost reduction, and time/redeployment value.
- **AI Governance Framework for Production Agents — Galileo** — <https://galileo.ai/blog/ai-governance-framework>  
  Core governance metrics: human-intervention rate, policy-violation frequency by type/severity, guardrail effectiveness, MTTR, trace completeness, audit-readiness — explicitly tied to EU AI Act Aug-2026 traceability.
- **AI Agent Observability, Evaluation & Governance: The 2026 Market Reality Check — Deepak Gupta** — <https://guptadeepak.com/ai-agent-observability-evaluation-governance-the-2026-market-reality-check/>  
  Benchmark numbers for 2026: 57% run agents in production, 69% of AI decisions still need human verification, <33% satisfied with observability, only 34% fully agentic.
- **80% of Fortune 500 use active AI Agents — Microsoft Security Blog (Feb 2026)** — <https://www.microsoft.com/en-us/security/blog/2026/02/10/80-of-fortune-500-use-active-ai-agents-observability-governance-and-security-shape-the-new-frontier/>  
  Assistive vs autonomous modes; five observability capabilities (registry, access control, visualization, interoperability, security); the 'how many agents / who owns / what data / sanctioned vs shadow' governance gap.
- **Evaluating Agentic AI in the Enterprise: Metrics, KPIs, and Benchmarks — Auxiliobits** — <https://www.auxiliobits.com/blog/evaluating-agentic-ai-in-the-enterprise-metrics-kpis-and-benchmarks/>  
  Five dimensions (Effectiveness/Efficiency/Autonomy/Accuracy/Robustness): task-success rate, decision-turn count, tool-selection accuracy, recovery rate, cost-per-task, latency — and 'instrument every decision point'.
- **Gartner Predicts 2026: AI Agents Will Reshape Infrastructure & Ops — Itential** — <https://www.itential.com/resource/analyst-report/gartner-predicts-2026-ai-agents-will-reshape-infrastructure-operations/>  
  Analyst framing of the shift to agentic ops and autonomous remediation; supports the >40%-of-agentic-projects-cancelled-by-2027 risk-control warning used to justify the safety panel.
- **AI Agent Guardrails & Governance 2026 (Part 1) — QueryPie** — <https://www.querypie.com/features/documentation/white-paper/28/ai-agent-guardrails-governance-2026>  
  Sharp guardrails-vs-approvals distinction: guardrails are automatic binary allow/block; approvals pause the run and wait for a human — the basis for tracking block-rate and approval-queue separately.
- **AIOps Explained: Detection, Prediction, and Mitigation — Splunk** — <https://www.splunk.com/en_us/blog/learn/aiops.html>  
  Predictive/self-healing framing: knowledge graphs for cascading-failure tracing, anomaly detection, auto-remediation 'turning emergencies into pre-empted events' — basis for the predictive-alert precision/lead-time indicator.
- **AI Agent Observability: A Complete Guide for 2026 & Beyond — Atlan** — <https://atlan.com/know/ai-agent-observability/>  
  Observability and data-trust angle: agents acting on stale/unverified data as a top blind spot — supports the live-vs-simulated source-health indicator (knowledge-derived corroboration, page surfaced in search).
- **Product code: qlerify-live web/app.js (provenance + role model)** — <file:///Users/staffanpalopaa/work/qlerify-live/.claude/worktrees/organisation-dashboard/web/app.js>  
  Confirms the event stream carries provenance (live/recorded/simulated, lines 56-77), a role/actor field, per-step businessAt timestamps and +Nd gaps, and that the assistant /chat endpoint runs write-tools — the substrate every indicator above is computed from.
- **Google SRE Book — Monitoring Distributed Systems (Four Golden Signals)** — <https://sre.google/sre-book/monitoring-distributed-systems/>  
  Canonical definition of latency, traffic, errors, saturation; basis for mapping process throughput/cycle-time/exception/WIP signals.
- **Google SRE Workbook — Alerting on SLOs (multi-window, multi-burn-rate)** — <https://sre.google/workbook/alerting-on-slos/>  
  Standard for burn-rate alerts; the 1h/6h/3d window pattern underpins the SLA breach-prediction indicator.
- **SRE Metrics & KPIs in 2026: Golden Signals, SLOs & MTTR Guide** — <https://srexpert.cloud/blog/sre-metrics-kpis-complete-guide-2026>  
  Current (2026) framing of golden signals + SLO + MTTR as a combined operating model.
- **How to Instrument Digital Twin Synchronization Performance (OpenTelemetry)** — <https://oneuptime.com/blog/post/2026-02-06-digital-twin-sync-performance-opentelemetry/view>  
  Concrete twin metrics: sync-latency histogram (>5s alert), state-drift gauge, staleness at 3× expected interval, sync queue depth, batch-recovery rate — directly powers the connector-health & freshness indicators.
- **Data Freshness Explained: Why Low Latency Doesn't Mean Current Data (Tacnode)** — <https://tacnode.io/post/what-is-data-freshness>  
  Freshness Gap = now − event timestamp; 'fast at being wrong'; per-asset freshness SLAs; pipeline-freshness compounding — core of the twin-freshness indicator and the latency-vs-freshness pitfall.
- **What Is Data Observability? 5 Key Pillars (Monte Carlo, 2026)** — <https://montecarlo.ai/blog-what-is-data-observability/>  
  Freshness/volume/quality/schema/lineage pillars; volume anomaly bands and lineage for blast-radius — informs anomaly-detection and cascade indicators.
- **Data Observability Metrics That Matter in 2026 (Promethium)** — <https://promethium.ai/guides/data-observability-metrics-that-matter-2026/>  
  2026 crawl/walk/run benchmarks: <20h monthly data downtime, TTD<30m, TTR<1h, 99%+ freshness-SLA compliance — concrete targets for twin data-quality KPIs.
- **Process Mining in Minutes — Minute 5: SLA Breach Analysis (ServiceNow)** — <https://www.servicenow.com/community/process-mining-blog/process-mining-in-minutes-minute-5-sla-breach-analysis/ba-p/3532395>  
  Isolating SLA-breach work and pinpointing where time leaks (long waits, handoffs) — basis for time-in-state / stuck-in-stage and breach indicators from an event log.
- **What is MTTR? Mean Time to Repair (Splunk)** — <https://www.splunk.com/en_us/blog/learn/mttr-mean-time-to-repair.html>  
  MTTR definition and its use as a friction/leading indicator; underpins the exception-MTTR indicator and its gaming pitfall.
- **Little's Law — Queue Management and System Performance (LiveSession)** — <https://livesession.io/blog/applying-littles-law-queue-management-and-system-performance>  
  WIP = throughput × cycle time and critical-WIP; foundation for the saturation/WIP indicator and Little's-Law consistency check.
- **How to Build Burn Rate Alerts (OneUptime, 2026)** — <https://oneuptime.com/blog/post/2026-01-30-sre-burn-rate-alerts/view>  
  Practical burn-rate thresholds (14.4x/6x/1x) translated to error-budget consumption — used in the error-budget and breach-prediction indicators.
- **2026 Supply Chain Risk / Cascading Failure & Blast Radius reporting (Cyber Strategy Institute; MDPI cascade study)** — <https://cyberstrategyinstitute.com/2026-supply-chain-risk-report/>  
  Focal-node concentration and cross-business-unit propagation; basis for the cross-workflow cascade / blast-radius index. (Knowledge-supplemented; see also https://www.mdpi.com/2079-8954/13/9/729 on cascading failure in centralized supply networks.)
- **Digital Twins Explained: Data Foundation Guide (Informatica)** — <https://www.informatica.com/resources/articles/digital-twins.html>  
  Twin = mirror of many source systems; emphasizes data foundation and trust — frames why provenance-mix/twin-coverage is a first-class indicator. (Stale-input cost example ~$2M/yr corroborated by 2026 twin-sync writing above.)
