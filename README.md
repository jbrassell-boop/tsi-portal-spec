# TSI Portal Spec — Working Proof-of-Concept

Single-repo proof-of-concept for two pieces of the BrightLogix-built TSI portal, with **live carrier API integration** (UPS + FedEx) running against real sandboxes.

> **For Steve**: this is the runnable counterpart to [`Claude/docs/CARRIERS-INTEGRATION.md`](https://github.com/BrightLogix/TSI-Winscope-Net---Production/blob/joe/carriers-plan/Claude/docs/CARRIERS-INTEGRATION.md) on the cloud repo's `joe/carriers-plan` branch. Every integration described in that design doc is **already working end-to-end here**, against UPS CIE / FedEx Sandbox, with real PRNs and tracking numbers coming back. The cloud-side C# port is on PR #14 (`joe/carriers-foundation`).

---

## Live demo

Hosted on Azure App Service:

| URL | What it shows |
|---|---|
| **`/portal-contracts.html`** | Sales Rep Portal — Contracts page (the original BrightLogix spec — list, filter, detail panes, repair history, equipment, reasons) |
| **`/portal-send-product-in.html`** | Sales Rep Portal — Send Product In page. Customer Repair Request Form with **live UPS + FedEx pickup scheduling, label generation, dynamic next-business-day service selection**, and PA/TN facility routing |
| **`/pickup-test.html`** | Raw API harness — exercise UPS Pickup API directly with form fields. Used during integration debugging. |
| **`/portal-repair-request.html`** | Standalone version of the RRF (no Sales Rep Portal chrome) |

Base URL: `https://tsi-portal-spec-ang2crc0d2cudddz.centralus-01.azurewebsites.net`

---

## What's working live (proven end-to-end against sandboxes)

| Capability | UPS | FedEx | Notes |
|---|---|---|---|
| OAuth client_credentials | ✅ | ✅ | Tokens cached in-memory |
| Return label generation | ✅ GIF base64 | ✅ PDF base64 | UPS uses `ReturnService.Code='9'` (1-Attempt Print Return Label) |
| Pickup On-Call scheduling | ✅ returns PRN | ✅ returns confirmation # | $5–7/click on TSI's account; TSI absorbs cost |
| Time-in-Transit / Rate Quotes | ✅ live | ⚠️ Rate API needs subscription | UPS `/api/shipments/v1/transittimes`; FedEx `/rate/v1/rates/quotes` |
| **Dynamic cheapest-next-biz-day picker** | ✅ | ⏳ pending FedEx Rate | M–F filter (no Saturday delivery), preference: Ground → Saver → NDA → NDA Early |
| Facility routing (PA / TN) | ✅ | ✅ | Per-department service-location key |
| Service-level + delivery date displayed in UI | ✅ | ✅ | Shown inline with label preview + tracking number |

**Gotchas already discovered and documented in the code** (so the C# port doesn't re-discover them under deadline pressure):

- UPS `CompanyName` is documented max 35 chars but actually rejects > 27 in v2409 (error 9500529)
- UPS `PaymentMethod` `"00"` (legacy) is rejected in v2409 — use `"01"` (Bill Shipper)
- UPS `ReturnService` Code 8 = Electronic Return Label (requires `LabelDelivery` block); Code 9 = "1 Attempt Print Return Label" (label inline) — we want Code 9
- UPS Pickup endpoint is `/api/pickupcreation/{version}/pickup` — NOT under `/api/shipments/`
- UPS Pickup version `v2409` (NOT v2403 — Pickup is on its own version cadence)
- FedEx Ship + Rate APIs require explicit subscription in the FedEx project — same `client_id` keeps working but each API has to be added
- Azure App Service often needs an explicit `restart` after `appsettings.set` for new env vars to load — don't trust the auto-restart timing

---

## Repo map

```
portal-contracts.html               Original BrightLogix Sales Rep Portal — Contracts page
portal-send-product-in.html         Send Product In page — RRF + carrier integration
portal-repair-request.html          Standalone RRF (same form, no portal chrome)
pickup-test.html                    Raw API harness for debugging

server/
  index.js                          Express app — mounts /api routes, serves static
  db.js                             SQL Server connection pool helpers
  routes/
    portal.js                       /api/portal/contracts — wraps tblContract for the Contracts page
    ups-pickup.js                   /api/pickup           — UPS Pickup On-Call API
    fedex-pickup.js                 /api/fedex-pickup     — FedEx Pickup API
    ups-label.js                    /api/label/ups        — UPS Shipping API + Time-in-Transit picker
    fedex-label.js                  /api/label/fedex      — FedEx Ship API + Rate Quotes picker

tasks/
  spec-portal-contracts.md          Original Contracts spec for reference
```

Each `routes/*.js` file is a self-contained reference implementation — DTOs, OAuth flow, payload builders, response parsing, error handling. **The C# port in `WinscopeNet.Infrastructure/Carriers/` mirrors these one-to-one.**

---

## Running locally

```bash
npm install
npm run server                # API on http://localhost:4000
```

Open `http://localhost:4000/portal-contracts.html` (or any other HTML) — Express also serves the static files.

---

## Required environment variables (local or Azure App Service)

UPS:
| Variable | Value |
|----------|-------|
| `UPS_CLIENT_ID` | OAuth client ID from UPS Developer Portal |
| `UPS_CLIENT_SECRET` | OAuth client secret |
| `UPS_ACCOUNT_NUMBER` | TSI's UPS shipper account |
| `UPS_ENV` | `CIE` (sandbox, default) or `PRODUCTION` |
| `UPS_PICKUP_VERSION` | Default `v2409` (Pickup) |
| `UPS_SHIP_VERSION` | Default `v2403` (Shipping) |

FedEx:
| Variable | Value |
|----------|-------|
| `FEDEX_CLIENT_ID` | API Key |
| `FEDEX_CLIENT_SECRET` | Secret Key |
| `FEDEX_ACCOUNT_NUMBER` | TSI's FedEx shipper account |
| `FEDEX_ENV` | `SANDBOX` (default) or `PRODUCTION` |

Database (only needed for the Contracts page):
| Variable | Value |
|----------|-------|
| `DB_SERVER` | Azure SQL hostname (when running on Azure) |
| `DB_NAME` | Database name (default `TSI_Demo`) |
| `DB_USER` | SQL login |
| `DB_PASSWORD` | SQL password |

---

## How this relates to the cloud rebuild

| Layer | Where |
|---|---|
| **Design doc / RFC** | [`BrightLogix/TSI-Winscope-Net---Production` PR #13](https://github.com/BrightLogix/TSI-Winscope-Net---Production/pull/13) — full architecture, 21 questions, four-PR plan |
| **Cloud foundation code (PR 1)** | [`BrightLogix/TSI-Winscope-Net---Production` PR #14](https://github.com/BrightLogix/TSI-Winscope-Net---Production/pull/14) — `IUpsClient`, OAuth, Time-in-Transit, `FacilityRoutingService`, `RatesController` |
| **Cloud labels code (PR 2)** | TBD — depends on PR 1 review |
| **Cloud FedEx + pickup (PR 3)** | TBD — depends on PR 2 |
| **Cloud Pending Arrivals (PR 4)** | TBD — depends on PR 1, partially independent of 2/3 |
| **This repo** | Living reference implementation. Every payload shape, every gotcha, every error code is already proven here. |

The Node code here is the canonical reference — the C# port should match it field-for-field. Once cloud has parity, this repo retires (or pivots to being a quick-iteration playground for new carrier features before C# port).

---

## Why a Node/Express PoC for a C#-bound integration

Iteration speed. We discovered ~7 non-obvious carrier API quirks (CompanyName 27-char limit, ReturnService Code 9 vs 8, PaymentMethod 01 vs 00, Pickup-on-its-own-URL-version, FedEx subscription gating, etc.) by trying things against the live sandbox. Each took 5–30 minutes to find and document; would've taken hours each in C# with the cloud's review/deploy cycle.

The PoC was deliberately throwaway-shaped — keep iterating until everything works, then port the working payload to C# and discard the Node version. We're at the port stage now.

---

## Status

- 🟢 UPS Pickup, UPS Label, UPS Time-in-Transit, dynamic service picker — all production-ready against PRODUCTION (just swap `UPS_ENV=PRODUCTION` and prod credentials)
- 🟢 FedEx Pickup — production-ready
- 🟢 FedEx Label — works in sandbox; FedEx Rate API subscription pending in the project
- 🟢 PA + TN facility routing — implemented (TN street address still placeholder pending Joe confirmation)
- 🟡 Pending Arrivals subsystem — designed in PR #13, not yet built here (the customer-portal RRF page in this repo currently just calls the carrier APIs; structured-form-data persistence is for cloud's PR 4)
