# Portal Contracts Feature — Steve Handoff Spec

**Date:** 2026-03-30
**Author:** Joseph Brassell
**For:** Steve (BrightLogix developer)
**Status:** Mockup complete and running against live SQL — see `portal-contracts.html`

---

## 1. What We're Building

The **Contracts** nav item in the BrightLogix portal currently goes nowhere. This spec describes the full Contracts section for two audiences:

### Two User Contexts — Same UI, Different Filter

| User Type | Who They Are | What They See | How to Filter |
|-----------|-------------|---------------|---------------|
| **Sales Rep** | TSI account manager logged into the portal | All contracts they own | `WHERE lSalesRepKey = [session rep key]` |
| **Facility User** | Hospital/clinic staff logged into the client portal | Only their facility's contracts | `WHERE lClientKey = [session client key]` |

The UI is identical for both. The only difference is which SQL filter gets applied based on the portal session. A sales rep might have 40 contracts across 20 clients. A facility director sees only their 3 contracts with TSI. Same page, same tabs, same detail — just scoped to them.

---

## 2. Database Source

All data lives in **WinScopeNet** (not TSIPortal). The portal already queries WinScopeNet for repairs — this follows the same pattern.

| Table | Purpose |
|-------|---------|
| `tblContract` | Contract master record — dates, value, PO, type, billing |
| `tblContractTypes` | Type names: Capitated, Shared Risk, PSA, Fuse, Airway, Rental |
| `tblContractDepartments` | Which departments are covered under a contract |
| `tblContractScope` | Which scopes (instruments) are enrolled under a contract |
| `tblClient` | Client name (`sClientName1`) |
| `tblSalesRep` | Rep first/last name |
| `tblPaymentTerms` | Invoice terms description |
| `tblRepair` | Repair records linked to a contract via `lContractKey` |
| `tblRepairStatuses` | Repair status label (`sRepairStatus`) |
| `tblRepairReasons` | Root cause code (`sRepairReason`) + `lRepairReasonCategoryKey` |
| `tblScope` | Scope serial number (`sSerialNumber`) |
| `tblScopeType` | Scope model description (`sScopeTypeDesc`) + `sRigidOrFlexible` (R/F/C/I) |
| `tblManufacturers` | Make/brand name (`sManufacturer`) — join via `tblScopeType.lManufacturerKey` |
| `tblDepartment` | Department name (`sDepartmentName`) |
| `tblTechnicians` | Tech name (`sTechName`) |

---

## 3. Page Layout

Split-panel layout: contract list on the left, contract detail on the right.

```
┌─────────────────────────┬──────────────────────────────────────────────────┐
│  LEFT PANEL (~380px)    │  RIGHT PANEL (flex)                              │
│                         │                                                  │
│  [Status filter bar]    │  [Empty state — "Select a contract"]             │
│  [Search input]         │                                                  │
│  [KPI strip — 4 chips]  │  ── after row click ──                          │
│  [Contracts table]      │                                                  │
│                         │  [Contract header: name, status, dates]          │
│  • Row click loads      │  [5 metric cards]                                │
│    detail on right      │  [Tab bar: Overview · Equipment · Why It Breaks  │
│  • Selected row         │             · Documents]                         │
│    highlighted          │                                                  │
└─────────────────────────┴──────────────────────────────────────────────────┘
```

---

## 4. Left Panel

### 4a. Status Filter
Toggle buttons: **All / Active / Expiring / Expired**

Status is computed from dates — there is no status column in the database:

| Status | SQL Condition |
|--------|--------------|
| Active | `dtDateEffective <= GETDATE() AND dtDateTermination >= GETDATE()` |
| Expiring | Active + `dtDateTermination <= DATEADD(day, 90, GETDATE())` |
| Expired | `dtDateTermination < GETDATE()` |
| Pending | `dtDateEffective > GETDATE()` |

### 4b. KPI Strip (4 chips)

Computed from the filtered contract set. No extra round-trips needed — derive from the same query result where possible.

| Chip | Computation |
|------|------------|
| Active Contracts | Count rows where status = Active |
| Monthly Revenue | Sum of `(dblAmtTotal / DATEDIFF(month, dtDateEffective, dtDateTermination))` for active contracts |
| Expiring ≤90 Days | Count active rows where `dtDateTermination <= today + 90` |
| Scopes Covered | `SELECT COUNT(*) FROM tblContractScope` matching the same filters |

Monthly Revenue formula in SQL:
```sql
dblAmtTotal / NULLIF(DATEDIFF(month, dtDateEffective, dtDateTermination), 0)
```

### 4c. Contract Table Columns

| Column | Source | Notes |
|--------|--------|-------|
| Client | `tblClient.sClientName1` | Primary display |
| Status | Computed | Color badge: green/amber/red/grey |
| Expires | `dtDateTermination` | MM/DD/YYYY |
| Monthly | Computed monthly fee | Right-aligned, dollar |

Contract # is in the detail panel header — not needed in the list.

---

## 5. Right Panel — Contract Detail

### 5a. Contract Header
Displayed above the tabs once a contract is selected:
- **Client name** (large, bold)
- Status badge · Contract type · Date range · Payment terms

### 5b. Metric Cards (5 cards, always visible)

| Card | Value | Source |
|------|-------|--------|
| Monthly Fee | `dblAmtTotal ÷ term months` | Computed |
| Contract Value | `dblAmtTotal` | `tblContract` |
| Days Remaining | `dtDateTermination - today` | Computed |
| Scopes Covered | COUNT from `tblContractScope` | Separate query |
| Avoidable Rate | See section 7 | Computed from repairs |

### 5c. Tab Bar

Four tabs: **Overview · Equipment · Why It Breaks · Documents**

---

## 6. Tab: Overview

Three stacked sections:

**Consumption bar** — total charges billed under this contract vs. contract value (progress bar showing % used)

**What's Covered** — coverage pills:
- `Flexible: N` / `Rigid: N` / `Camera: N` (from `tblContractScope → tblScopeType.sRigidOrFlexible`)
- Department name chips (from `tblContractDepartments → tblDepartment`)

**Recent Repairs table** (last 8, links to full list in repairs module):

| Column | Source | Notes |
|--------|--------|-------|
| WO # | `sWorkOrderNumber` | Monospace |
| Date | `dtDateIn` | |
| Scope | `tblScopeType.sScopeTypeDesc` + serial | |
| Customer Complaint | `sComplaintDesc` | Truncated with tooltip |
| Root Cause | `tblRepairReasons.sRepairReason` | Standardized tech code |
| Category | `lRepairReasonCategoryKey` | See Section 7 |
| TAT | `dtShipDate ?? dtDateOut` minus `dtDateIn` in days | |
| Outcome | `sInsFinalPF` (Pass/Fail) + Replaced/Outsourced flags | |

---

## 7. Avoidable Rate — Key Business Metric

This is one of the most valuable data points for a sales rep. It tells them whether a client's repairs are their own fault or normal scope wear.

**How it works:** `tblRepairReasons.lRepairReasonCategoryKey` classifies every repair reason into one of two buckets:

| Category Key | Meaning | Examples |
|-------------|---------|---------|
| `1` | Wear & Failure | CCD Failure, Driver Board Malfunction, Bending Section Wear |
| `2` | Avoidable / User-Induced | Fluid Invasion - Improper Cleaning, Bending Rubber Hole/Puncture, Distal Tip Crushed |

**Formula:**
```
Avoidable Rate = (repairs with category 2) / (repairs with category 1 OR 2) × 100
```
Repairs with no category (null) are excluded from the denominator — they're undiagnosed.

**Display rules:**
- `≥ 50%` → amber/warning color
- `≤ 25%` → green
- Between → neutral

**Why it matters for the sales rep:** A client with 90% avoidable rate needs staff retraining, not a bigger contract. A sales rep can use this data to have a proactive conversation before renewal.

---

## 8. Tab: Equipment

All scopes enrolled under this contract, grouped by department.

**Export button:** Downloads a CSV with all enrolled scopes — Contract #, Client, Department, Serial #, Make, Model, Type, Repair Count. Useful for facilities to reconcile their own instrument inventory records.

**Table columns per department group:**

| Column | Source |
|--------|--------|
| Serial # | `tblScope.sSerialNumber` |
| Make | `tblManufacturers.sManufacturer` (via `tblScopeType.lManufacturerKey`) |
| Model | `tblScopeType.sScopeTypeDesc` |
| Type | `sRigidOrFlexible` mapped to Flexible / Rigid / Camera / Instrument |
| Repairs | COUNT of `tblRepair` rows for this scope + contract |

> **Note:** `tblScope` does NOT have a manufacturer or model column. You must join `tblScopeType` → `tblManufacturers`.

---

## 9. Tab: Why It Breaks

A repair reason breakdown showing what's driving service calls under this contract.

**Top section:** Two summary cards
- **Avoidable %** (amber) — user-induced damage, count + pct
- **Wear & Failure %** (green) — normal component wear, count + pct

**Bottom section:** Horizontal bar chart rows for each repair reason (top 15 by count):
- Amber bars = category 2 (avoidable)
- Blue bars = category 1 (wear)
- Count on right, dollar charges on far right

**SQL for this section:**
```sql
SELECT TOP 15
  ISNULL(rr.sRepairReason, 'Unknown') AS sReason,
  rr.lRepairReasonCategoryKey AS nReasonCategory,
  COUNT(*) AS nCount,
  SUM(ISNULL(r.dblAmtRepair, 0)) AS dblCharges
FROM tblRepair r
  LEFT JOIN tblRepairReasons rr ON rr.lRepairReasonKey = r.lRepairReasonKey
WHERE r.lContractKey = @contractKey
GROUP BY rr.sRepairReason, rr.lRepairReasonCategoryKey
ORDER BY nCount DESC
```

---

## 10. Tab: Documents

**Placeholder for now.** Intended to surface the signed CSA/service agreement PDF and any contract amendments stored in WinScopeNet. This is a future phase once we know where WinScopeNet stores document attachments.

---

## 11. Full API Contract

### `GET /api/portal/contracts`
**Query params:** `salesRepKey`, `clientKey`, `status`

Returns:
```json
{
  "success": true,
  "contracts": [ ...rows ],
  "kpis": {
    "activeCount": 12,
    "expiringCount": 2,
    "monthlyRevenue": 28450.00,
    "totalScopes": 148
  }
}
```

### `GET /api/portal/contracts/:contractKey/detail`
Runs 6 queries in parallel. Returns:
```json
{
  "success": true,
  "info": { ...contract header fields },
  "departments": [ ...covered departments ],
  "repairs": [ ...last 100 repairs ],
  "coverage": { "rigid": 0, "flexible": 10, "camera": 0, "instrument": 0 },
  "scopes": [ ...enrolled scopes with repair counts ],
  "reasons": [ ...top 15 repair reasons with category + charges ],
  "documents": []
}
```

---

## 12. BrightLogix Implementation Notes

**Auth filter:** The portal session has `intSalesRepKey` and `intClientKey` on the user record (TSIPortal.dbo). Apply the appropriate WHERE clause — never expose all contracts to a portal user. Sales rep gets `lSalesRepKey` filter. Facility user gets `lClientKey` filter.

**Cross-database:** All queries hit WinScopeNet directly. Same as how `contractRepairsGet` works today.

**Existing stored procs to reference:**
- `contractsGet` — base contract fetch
- `contractRepairsGet` — repairs under a contract
- `contractReportCardGet` — performance KPIs (overlap with our avoidable rate)

**Read-only:** No editing from the portal. No save, create, or delete buttons anywhere on this page.

**Repair reason category:** The category key is on `tblRepairReasons.lRepairReasonCategoryKey` directly — there is no separate `tblRepairReasonCategories` table.

**Manufacturer lookup:** Must go `tblContractScope → tblScope → tblScopeType → tblManufacturers`. There is no shortcut column on tblScope.

**Tech name:** The correct table is `tblTechnicians` (plural) with column `sTechName`. `tblTechnician` (singular) does not exist.

---

## 13. Visual Reference

See `portal-contracts.html` in this repo. Run it with:
```
npx serve -l 3000 .        ← static files
npm run server              ← Express API on :4000
```
Then open: `http://localhost:3000/portal-contracts.html`

The mockup is wired to real WinScopeNet SQL data. Everything you see is live — the avoidable rates, repair reasons, scope counts, and monthly fees are all computed from actual contract records.

---

## 14. Out of Scope — Future Enhancements

- Invoice history tab (invoices issued against the contract)
- Amendment / renewal history
- Repair consumption trend chart (monthly)
- Expiration alert emails (portal notification)
- Client-initiated renewal request workflow
- Document upload/access from WinScopeNet attachment store
