# Ericsson HW Flow — Demo Simulation Spec (v2)

A consolidated, simulation-ready version of the Event Storming session, reduced to **28 key domain events** that can be demonstrated end-to-end with each system represented by a small set of database tables.

> **v2 changes** vs v1: split *Supply & Material Readiness* into its own phase; added *Material Shortage Identified* (separate from ETA changed) and *Material Kit Completed* (AND-gate); separated *Engineering Release Approved* from *BOM Frozen* (distinct gates); added *Hardware Demand Created* as the explicit entry event and *Build Plan Updated* as the controlled-replan event; added §7 state-machine summary and §8 cascading-disruption storyline.

The full board contained ~95 events. For the demo we keep events that:

- **Cross a system boundary** (where the handoff pain lives)
- **Mutate observable state** (touch a DB row the next event reads)
- **Tell the end-to-end story** from customer demand to delivered unit
- **Allow realistic perturbations** (late ER, material ETA slip, locked plan)

---

## 1. Simulated systems

Seven systems, each backed by 1–3 tables. Names are kept short and demo-friendly.

### 1.1 Helix — Demand & build planning
The orchestration layer. Owns the *demand*, the *build plan*, and the *Lock*.

```sql
demand            (demand_id, customer_id, product_name, qty, requested_week, status)
                   -- status ∈ {NEW, PLANNED, DELIVERED}
build_plan        (build_plan_id, demand_id, version, status, locked_at, released_at)
                   -- status  ∈ {DRAFT, LOCKED, RELEASED}
                   -- version ++ on every Build-Plan-Updated event
build             (build_id, build_plan_id, build_no, qty, priority, site_id,
                   material_status, planned_start, actual_start, actual_end, status)
                   -- material_status ∈ {OPEN, AT_RISK, KIT_READY}
                   -- status          ∈ {PLANNED, RELEASED, IN_PROGRESS, RTD, SHIPPED}
build_demand      (build_id, part_number, qty_required, qty_available)
```

### 1.2 PRIM — Product & release master
The source of truth for product structure, BOM and engineering release.

```sql
project           (project_id, demand_id, product_name, status)
bom_item          (bom_item_id, project_id, part_number, qty_per_unit, design_state, frozen_at)
                   -- design_state ∈ {DRAFT, DS1, DS2_PROD}
engineering_release (release_id, project_id, status, approved_at)
                   -- status ∈ {OPEN, APPROVED}
```

### 1.3 SAP — ERP, procurement & orders

```sql
purchase_order    (po_id, project_id, part_number, qty, supplier_id,
                   requested_date, confirmed_eta, actual_receipt_date, status)
                   -- status ∈ {DRAFT, ORDERED, CONFIRMED, RECEIVED}
work_order        (wo_id, project_id, build_id, qty, status)
                   -- status ∈ {CREATED, RELEASED, CLOSED}
```

### 1.4 ESTER — Engineering changes / trouble reports

```sql
engineering_change (er_id, project_id, bom_item_id, description, status, created_at, approved_at)
                   -- status ∈ {OPEN, APPROVED, REJECTED}
```

### 1.5 Compass / Chronos — Production scheduling

```sql
production_site   (site_id, name)
production_line   (line_id, site_id, name, capacity_per_week)
line_booking      (booking_id, line_id, build_id, planned_start, planned_end, status)
                   -- status ∈ {BOOKED, RUNNING, DONE}
```

### 1.6 Test — NPI / Test results

```sql
test_result       (test_id, build_id, unit_serial, test_type, result, executed_at)
                   -- test_type ∈ {BOARD, FAI, FA2, FUNCTIONAL}
                   -- result    ∈ {PASS, FAIL}
```

### 1.7 Logistics — Warehouse, pack & ship

```sql
unit              (unit_id, build_id, serial_no, status)
                   -- status ∈ {BUILT, PICKED, PACKED, SHIPPED, DELIVERED, LOST}
shipment          (shipment_id, demand_id, packed_at, shipped_at, delivered_at, status)
                   -- status ∈ {PREPARING, READY, IN_TRANSIT, DELIVERED}
```

---

## 2. The 28 demo events

Each row gives: event (past tense), actor, system that records it, and the DB rows it mutates. Sequence flows top-to-bottom.

### Phase 1 — Demand & Product Structure (events 1–5)

| # | Event | Actor | System | DB mutation |
|---|---|---|---|---|
| 1 | **Hardware demand created** | Product Manager / PiM | Helix | INSERT `demand` (status = `NEW`) — e.g. *20 × Radio Unit X for NPI verification, requested week 2026-W18* |
| 2 | **Project created** | PiM | PRIM | INSERT `project` linked to `demand_id`; product variant/revision set as attribute |
| 3 | **BOM defined** | Designer / CM | PRIM | INSERT N × `bom_item` (design_state = `DRAFT`) |
| 4 | **BOM frozen at DS1** | CM | PRIM | UPDATE `bom_item.design_state = 'DS1'`, set `frozen_at` |
| 5 | **Build quantity defined** | PiM / Planner | Helix | INSERT `build_plan` v1 (status = `DRAFT`); INSERT N × `build` (status = `PLANNED`) |

### Phase 2 — Supply & Material Readiness (events 6–10)

| # | Event | Actor | System | DB mutation |
|---|---|---|---|---|
| 6 | **Material demand specified** | PiM / Supply Planner | Helix → SAP | INSERT N × `build_demand` (BOM × qty); INSERT N × `purchase_order` (status = `DRAFT`) |
| 7 | **Material ordered** | Sourcing / Buyer | SAP | UPDATE `purchase_order.status = 'ORDERED'`, set `requested_date` |
| 8 | **Supplier confirmed order with ETA** | Supplier | SAP | UPDATE `purchase_order.status = 'CONFIRMED'`, set `confirmed_eta` |
| 9 | **Material ETA changed** ⚠ | Supplier | SAP | UPDATE `purchase_order.confirmed_eta` to a later date |
| 10 | **Material shortage identified** ⚠ | Supply Planner | SAP → Helix | UPDATE `build.material_status = 'AT_RISK'` for any build whose `confirmed_eta` now lands after `build.planned_start` |

### Phase 3 — Build Planning & Engineering Gates (events 11–16)

| # | Event | Actor | System | DB mutation |
|---|---|---|---|---|
| 11 | **Engineering change raised** ⚠ | Designer | ESTER | INSERT `engineering_change` (status = `OPEN`) referencing a `bom_item` |
| 12 | **Engineering change approved** | CM | ESTER → PRIM | UPDATE `engineering_change.status = 'APPROVED'`; UPDATE affected `bom_item` |
| 13 | **BOM frozen at DS2 (production)** | CM | PRIM | UPDATE `bom_item.design_state = 'DS2_PROD'` for all rows in project |
| 14 | **Engineering release approved** | CM / Release Authority | PRIM | INSERT `engineering_release` (status = `APPROVED`, `approved_at`) — the design *package* is signed off, separate from the BOM freeze |
| 15 | **Build priority set** | Programme / HWM | Helix | UPDATE `build.priority` |
| 16 | **Build plan updated** | HWM / Planner | Helix | INSERT new `build_plan` version (status = `DRAFT`); previous version archived. Triggered by any of: ETA change, ER approval, priority change, site change |

### Phase 4 — Lock & Production Execution (events 17–22)

The *Locked!* gate happens at event 17. After it, no further changes to `build_demand` are allowed in the simulation.

| # | Event | Actor | System | DB mutation |
|---|---|---|---|---|
| 17 | **Build plan locked** 🔒 | CM / PEU | Helix | UPDATE `build_plan.status = 'LOCKED'`, set `locked_at` (latest version only). Requires: DS2 frozen + engineering_release APPROVED + work_order created. |
| 18 | **Build released to site** | HWM | Helix → Compass | UPDATE `build.site_id`, `build.status = 'RELEASED'`; UPDATE `build_plan.status = 'RELEASED'` |
| 19 | **Production line booked** | Production Planner | Compass | INSERT `line_booking` (status = `BOOKED`) for the released build |
| 20 | **Material received at site** | Goods Receiving | SAP → Helix | UPDATE `purchase_order.status = 'RECEIVED'`, set `actual_receipt_date`; UPDATE `build_demand.qty_available` |
| 21 | **Material kit completed** ✅ | Warehouse / Planner | SAP → Helix | UPDATE `build.material_status = 'KIT_READY'` when *all* `build_demand.qty_available ≥ qty_required` for the build. This is the AND-gate that releases production. |
| 22 | **Production started** | Production | Compass → Helix | UPDATE `line_booking.status = 'RUNNING'`; UPDATE `build.status = 'IN_PROGRESS'`, `actual_start`. Requires `material_status = 'KIT_READY'`. |

> *Note:* the **work order** (`work_order` in SAP, status `CREATED`) is created earlier as a precondition to event 17 (Lock). It moves to `RELEASED` at event 18, and `CLOSED` after event 25. To keep the event count at 28 it's modelled as a side-effect of the Lock rather than a standalone event — but the table is still in SAP for the demo to display.

### Phase 5 — Test, Release & Delivery (events 23–28)

| # | Event | Actor | System | DB mutation |
|---|---|---|---|---|
| 23 | **Board test passed** | Test Engineer | Test | INSERT N × `test_result` (test_type = `BOARD`, result = `PASS`) — one per produced unit |
| 24 | **First Article Inspection passed** | NPI / Quality | Test | INSERT `test_result` (test_type = `FAI`, result = `PASS`) |
| 25 | **Build reached RTD** | NPI / HWM | Helix | UPDATE `build.status = 'RTD'`, `actual_end`; UPDATE `line_booking.status = 'DONE'`; UPDATE `work_order.status = 'CLOSED'`; INSERT N × `unit` (status = `BUILT`) |
| 26 | **Units picked & packed** | Warehouse | Logistics | INSERT `shipment` (status = `READY`); UPDATE `unit.status = 'PACKED'`; set `shipment.packed_at` |
| 27 | **Shipment dispatched** | Logistics | Logistics → SAP | UPDATE `shipment.status = 'IN_TRANSIT'`, `shipped_at`; UPDATE `unit.status = 'SHIPPED'`; UPDATE `build.status = 'SHIPPED'` |
| 28 | **Unit received by customer** ✅ | Customer / Receiver | Logistics | UPDATE `shipment.status = 'DELIVERED'`, `delivered_at`; UPDATE `unit.status = 'DELIVERED'`; UPDATE `demand.status = 'DELIVERED'` |

---

## 3. Event-chain dependencies

Each event has a clean precondition on the DB. The demo runner checks the precondition, applies the mutation, and moves on.

```
 1 Demand created                ⟶ demand row exists
 2 Project created               ⟵ requires demand
 3 BOM defined                   ⟵ requires project
 4 BOM frozen DS1                ⟵ requires ≥1 bom_item
 5 Build quantity defined        ⟵ requires DS1 frozen
 6 Material demand specified     ⟵ requires builds exist
 7 Material ordered              ⟵ requires purchase_order DRAFT
 8 Supplier confirmed            ⟵ requires PO ORDERED
 9 Material ETA changed   ⚠      ⟵ requires PO CONFIRMED
10 Material shortage     ⚠      ⟵ requires new_eta > planned_start (DERIVED)
11 ER raised             ⚠      ⟵ requires DS1 frozen
12 ER approved                   ⟵ requires ER OPEN
13 BOM frozen DS2                ⟵ requires all open ERs resolved
14 Engineering release approved  ⟵ requires DS2 frozen
15 Build priority set            ⟵ requires builds exist
16 Build plan updated            ⟵ requires any of: ETA changed, ER approved, priority changed
17 Build plan LOCKED      🔒    ⟵ requires DS2 + ER approved + WO created
18 Build released to site        ⟵ requires plan LOCKED
19 Production line booked        ⟵ requires build RELEASED
20 Material received at site     ⟵ requires PO CONFIRMED and ETA reached
21 Material kit completed ✅    ⟵ requires all build_demand satisfied (DERIVED)
22 Production started            ⟵ requires line BOOKED AND material KIT_READY
23 Board test passed             ⟵ requires production IN_PROGRESS
24 FAI passed                    ⟵ requires board test PASS
25 Build reached RTD             ⟵ requires FAI PASS + qty produced
26 Units picked & packed         ⟵ requires build RTD
27 Shipment dispatched           ⟵ requires shipment READY
28 Unit received          ✅    ⟵ requires shipment IN_TRANSIT
```

Events 10 and 21 are **derived** — the simulator computes them automatically when their precondition becomes true, rather than waiting for a user action. This is the demo moment where "the system tells the planner something they used to learn by email."

---

## 4. Suggested demo storyline

**Act 1 — Happy path (~5 min)**
Run events 1 → 8 → 11–17 → 18–25 → 28 with no perturbations. The audience sees the same product travel through Helix → PRIM → SAP → Compass → Test → Logistics. Pause at each event to show the row(s) that just changed.

**Act 2 — The two cascading disruptions (~6 min)**

These are the two patterns that recurred all over the whiteboard. Each shows multiple events firing in sequence across systems:

*Cascade A — supplier reality breaks the plan:*
```
   9  Material ETA changed         (SAP)
→ 10  Material shortage identified (Helix DERIVED — build.material_status = AT_RISK)
→ 16  Build plan updated           (Helix v2)
```
The demo highlight: events 9 and 10 happen in two different systems but the simulator joins them automatically. Today this join is an email.

*Cascade B — late engineering change after planning has started:*
```
  11  ER raised                    (ESTER)
→ 12  ER approved                  (ESTER → PRIM)
→ 13  BOM frozen DS2 delayed       (PRIM — the freeze waits)
→ 16  Build plan updated           (Helix v3)
```
The demo highlight: ER approval is a gate on BOM freeze, which is itself a gate on build-plan lock. The chain is enforced in code.

**Act 3 — The Lock (event 17, ~2 min)**
Show that *after* event 17, an attempt to mutate `build_demand` is rejected by the simulator. This is the policy-enforced-in-code version of the *Locked!* whiteboard column.

**Act 4 — Failure modes (optional, ~3 min)**
Replace event 28 with one of:
- *Delivery lost* — UPDATE `unit.status = 'LOST'`; `shipment.status` stays `IN_TRANSIT`. Demand does not close.
- *HW broken on arrival* — UPDATE `unit.status = 'DELIVERED'` but raise a new ER. Closes the loop back to PRIM.

---

## 5. Integration pain the demo can highlight

The cross-system handoffs from the whiteboard, made visible in the simulation:

| Handoff | Today's pain on the board | What the simulation shows |
|---|---|---|
| Helix ↔ SAP (event 6) | Material demand exported by Excel | A direct write from `build_demand` to `purchase_order` |
| SAP ↔ Helix (event 10) | ETA slips known in SAP, planners learn by email | The simulator joins `purchase_order.confirmed_eta` against `build.planned_start` and flips `material_status = AT_RISK` automatically |
| Helix ↔ Compass (event 19) | Site capacity in Compass; build plan in Helix | `line_booking` references `build` directly — no Excel intermediate |
| ESTER ↔ PRIM (events 11–14) | Late ERs disturb a frozen BOM; tracking weak | `engineering_change.status` state-machine forces approval before DS2 freeze; `engineering_release` is a separate gate |
| Helix gate (event 17) | The *Locked!* policy is honoured in some teams, ignored in others | Simulator rejects mutations to `build_demand` after lock |
| SAP ↔ Helix (event 21) | "Is the kit complete?" answered by Excel rollup | A SQL aggregate over `build_demand` flips `material_status = KIT_READY` |
| Logistics ↔ SAP (events 26–28) | Pick/pack/ship tracked in mixed tooling | `shipment` rows drive every status change |

This is the punch-line of the demo: *the information already flows through these systems today, but as PowerPoint, Excel and email instead of as DB rows.*

---

## 6. What was deliberately left out

For honesty, events from the whiteboard that did **not** make the 28-event cut, and why:

- *Demand reviewed by Order, Mock-up created, Sourcing engaged* — organisational, not state-mutating. Pre-conditions to event 1.
- *Release plan communicated, broadcast, re-baselined* — captured as new `build_plan` version (event 16); no separate event.
- *Purchase requisition created before PO* — in real SAP they're distinct; for the demo it's CRUD noise. Folded into event 7.
- *Product configuration selected, design state assigned* — folded into event 2 as project attributes.
- *FA2 done, NPI approved, Unit tested, Functional test* — represented by event 24 (FAI) and 23 (Board test). Trivial to add as extra `test_result` rows.
- *Packaging defined, FMP ready, SW ready, HW prepared* — pre-conditions to RTD, not separate stateful events.
- *Late change, Last-moment change, Urgent change* — all reduce to event 11 (ER raised).
- *No-ETA, Picking missing, HW broken, Delivery lost, Units lost* — failure modes in Act 4; not part of the happy path.
- *Production site changed, Best site selected* — single attribute update on `build.site_id`; covered by event 16 (plan updated).
- *PPT, MS Teams, email handovers* — these are the things the simulation *replaces*; anti-events in the new world.

---

## 7. State-machine summary

The whole demo can be told as a single `build` row walking through 14 states. This is the slide to put at the front:

```
 DemandCreated
   ↓
 ProjectCreated
   ↓
 BomFrozen (DS1)
   ↓
 BuildPlanned ─────────────────┐
   ↓                           │   ⚠ ETA slip / ER raised
 MaterialOrdered               │   loops back via
   ↓                           │   "Build Plan Updated"
 SupplierConfirmed ────────────┘
   ↓
 [MaterialAtRisk?] ────→ BuildPlanUpdated
   ↓
 EngineeringReleased
   ↓
 BuildLocked  🔒
   ↓
 LineBooked
   ↓
 MaterialReceived → KitReady
   ↓
 ProductionStarted
   ↓
 Tested (Board + FAI)
   ↓
 RTD
   ↓
 PickedPacked
   ↓
 Shipped
   ↓
 Delivered ✅
```

Two loops back to *BuildPlanUpdated* represent the two disruption cascades from §4.

---

## 8. Build order for the demo team

For the engineering team building the simulator:

1. **Schema first** (§1). 18 tables, all SQL `CREATE TABLE` statements should fit on one screen.
2. **Seed data**: one customer demand, one project, ~10 BOM lines, ~5 purchase orders, one production site with two lines.
3. **Event handlers**: 28 small functions, each ≤ 20 lines. Each function asserts preconditions then runs the documented INSERT/UPDATE.
4. **Two derived events** (10, 21): a tiny "rules engine" — really just two SQL queries that run after every event and fire the derived events if their condition is met.
5. **One enforcement check** (the Lock): reject any UPDATE to `build_demand` if the parent `build_plan.status = 'LOCKED'`.
6. **UI**: side-by-side panels per system; highlight the row(s) that changed on each event. Step-forward button. That's the whole demo.

Estimated build effort: 2 engineers × 1 week for the simulator + 1 week for the UI polish.
