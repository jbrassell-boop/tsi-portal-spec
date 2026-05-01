// ═══════════════════════════════════════════════════════
//  ups-label.js — UPS Shipping API (return-label generation)
//  POST /api/label/ups/generate  → returns base64 label + tracking
//  GET  /api/label/ups/health    → cred status
//
//  Reuses UPS_CLIENT_ID / UPS_CLIENT_SECRET / UPS_ACCOUNT_NUMBER
//  / UPS_ENV from the pickup integration. No new env vars needed.
//
//  Endpoint: POST {host}/api/shipments/v2403/ship
//  Return Service Code 9 = "1 Attempt Print Return Label"
//    (label returned inline as base64; UPS does NOT email a link)
// ═══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();

const ENV = (process.env.UPS_ENV || 'CIE').toUpperCase();
const HOST = ENV === 'PRODUCTION'
  ? 'https://onlinetools.ups.com'
  : 'https://wwwcie.ups.com';

const SHIP_VER = process.env.UPS_SHIP_VERSION || 'v2403';

// TSI receives M-F only (Joe confirmed: no Saturday processing)
const BUSINESS_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

// Service preference, cheapest → most expensive (next-business-day options).
// serviceLevel from TransitTimes API → numeric Service.Code in Ship API.
// Ground is cheapest (~$10) but only works for short-haul routes.
const SERVICE_RANK = [
  { level: 'GND', code: '03', name: 'UPS Ground' },
  { level: '1DP', code: '13', name: 'UPS Next Day Air Saver' },
  { level: '1DA', code: '01', name: 'UPS Next Day Air' },
  { level: '1DM', code: '14', name: 'UPS Next Day Air Early' }
];
const FALLBACK_SERVICE = SERVICE_RANK[1];   // Saver — works coast-to-coast

const CLIENT_ID     = process.env.UPS_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.UPS_CLIENT_SECRET || '';
const ACCOUNT_PA    = process.env.UPS_ACCOUNT_NUMBER     || '';      // North / Upper Chichester
const ACCOUNT_TN    = process.env.UPS_ACCOUNT_NUMBER_TSS || '9Y406Y'; // South / Nashville (from legacy Portal2 web.config)

// ── Facility routing ─────────────────────────────────────
// Customer's department determines which TSI facility receives
// the return: PA (North/Upper Chichester) or TN (Nashville/TSS).
const FACILITIES = {
  PA: {
    name: 'Total Scope Inc',
    attentionName: 'Receiving Dept (PA)',
    account: ACCOUNT_PA,
    phone: '8004712255',
    addressLine: '17 Creek Pkwy',
    city: 'Upper Chichester',
    state: 'PA',
    zip: '19061'
  },
  TN: {
    name: 'Total Scope South',
    attentionName: 'Receiving Dept (TN)',
    account: ACCOUNT_TN,
    // TODO: confirm street address with Joe — placeholder ZIP
    phone: '8004712255',
    addressLine: 'TBD — Nashville facility',
    city: 'Nashville',
    state: 'TN',
    zip: '37210'
  }
};
function getFacility(p) {
  const f = String(p.facility || 'PA').toUpperCase();
  return FACILITIES[f] || FACILITIES.PA;
}

let _token = null;
let _tokenExpiresAt = 0;

async function getToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('UPS credentials not configured.');
  }
  if (_token && Date.now() < _tokenExpiresAt - 60_000) return _token;
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${HOST}/security/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-merchant-id': ACCOUNT_PA
    },
    body: 'grant_type=client_credentials'
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`UPS OAuth ${res.status}: ${text}`);
  const j = JSON.parse(text);
  _token = j.access_token;
  _tokenExpiresAt = Date.now() + (parseInt(j.expires_in || '14400', 10) * 1000);
  return _token;
}

// ── Pick fastest+cheapest service via Time-in-Transit ──
// Returns { code, name, level, deliveryDate } or null on lookup failure.
async function pickService(token, p) {
  const today = new Date().toISOString().slice(0, 10);
  const fac = getFacility(p);
  const body = {
    originCountryCode: 'US',
    originStateProvince: (p.state || '').slice(0, 2),
    originCityName: (p.city || '').slice(0, 30),
    originPostalCode: (p.zip || '').slice(0, 5),
    destinationCountryCode: 'US',
    destinationStateProvince: fac.state,
    destinationCityName: fac.city,
    destinationPostalCode: fac.zip,
    weight: String(p.weightLbs || 10),
    weightUnitOfMeasure: 'LBS',
    shipmentContentsValue: '100',
    shipmentContentsCurrencyCode: 'USD',
    billType: '03',
    shipDate: today,
    shipTime: '14:00',
    residentialIndicator: p.residential ? '01' : '02',
    avvFlag: true,
    numberOfPackages: '1'
  };
  try {
    const res = await fetch(`${HOST}/api/shipments/v1/transittimes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'transId': 'tit-' + Date.now(),
        'transactionSrc': 'TSIPortal'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) return null;
    const j = await res.json();
    const services = (j.emsResponse || {}).services || [];
    // Filter: delivers in 1 business day AND on a business day (M-F only)
    const eligible = services.filter(s =>
      Number(s.businessTransitDays) === 1 &&
      BUSINESS_DAYS.includes(s.deliveryDayOfWeek)
    );
    // Pick by SERVICE_RANK preference (cheapest first)
    for (const pref of SERVICE_RANK) {
      const hit = eligible.find(s => s.serviceLevel === pref.level);
      if (hit) return { ...pref, deliveryDate: hit.deliveryDate, deliveryDayOfWeek: hit.deliveryDayOfWeek };
    }
    return null;
  } catch {
    return null;
  }
}

// Build TSI address block from facility selection
function tsiAddressBlock(fac) {
  return {
    Name: fac.name,
    AttentionName: fac.attentionName,
    ShipperNumber: fac.account,
    Phone: { Number: fac.phone },
    Address: {
      AddressLine: fac.addressLine,
      City: fac.city,
      StateProvinceCode: fac.state,
      PostalCode: fac.zip,
      CountryCode: 'US'
    }
  };
}

// ── Build UPS Shipment Request payload ─────────────────
//
// IMPORTANT: UPS's ReturnService Code 9 ("1-Attempt Print Return Label" — inline
// label in response) is ONLY valid with UPS Ground (Service Code 03). Air
// services (1DA / 1DP / 1DM) reject Return Service Code 9 with error 121040
// "Return Services are unavailable with the requested service."
//
// For now, return labels are pinned to GROUND. Customers far from TSI accept
// 4-5 day transit. If they need faster, Ops schedules a UPS pickup separately
// (the UPS driver brings the air-service label).
//
// Future option (PR 2/3): use ReturnService Code 8 (Electronic Return Label)
// + LabelDelivery block for far-distance customers; customer gets emailed link.
function buildPayload(p, picked) {
  const fac = getFacility(p);
  const TSI_ADDRESS = tsiAddressBlock(fac);
  // Force Ground for return labels regardless of dynamic-picker recommendation.
  const svc = { code: '03', name: 'UPS Ground' };
  // Customer info — they're the "ShipFrom" (where pickup happens) on a return
  const phoneDigits = (p.phone || '').replace(/[^\d]/g, '');
  // UPS limits: Name 35, but probed 27 char limit on Pickup CompanyName.
  // Empirically Shipping accepts longer; stay safe at 30.
  const customer = {
    Name: (p.companyName || p.contactName || '').slice(0, 35),
    AttentionName: (p.contactName || '').slice(0, 35),
    Phone: phoneDigits ? { Number: phoneDigits } : { Number: '8004712255' },
    Address: {
      AddressLine: (p.address1 || '').slice(0, 35),
      City: (p.city || '').slice(0, 30),
      StateProvinceCode: (p.state || '').slice(0, 5),
      PostalCode: (p.zip || '').slice(0, 10),
      CountryCode: 'US'
    }
  };

  return {
    ShipmentRequest: {
      Request: {
        RequestOption: 'nonvalidate',
        TransactionReference: { CustomerContext: 'TSI Portal Return Label' }
      },
      Shipment: {
        Description: (p.description || 'TSI Repair RMA').slice(0, 35),
        // ReturnService 9 = "1 Attempt Print Return Label" — label returned
        // inline as base64 in the response (no email to customer)
        ReturnService: { Code: '9' },
        Shipper: TSI_ADDRESS,           // who pays + label-of-record
        ShipFrom: customer,             // customer's address (pickup point)
        ShipTo:   TSI_ADDRESS,          // TSI = recipient on return
        PaymentInformation: {
          ShipmentCharge: {
            Type: '01',
            BillShipper: { AccountNumber: fac.account }
          }
        },
        Service: { Code: svc.code, Description: svc.name },
        Package: [{
          Description: (p.description || 'Endoscope').slice(0, 35),
          Packaging: { Code: '02', Description: 'Customer Supplied Package' },
          PackageWeight: {
            UnitOfMeasurement: { Code: 'LBS' },
            Weight: String(p.weightLbs || 10)
          }
        }]
      },
      LabelSpecification: {
        LabelImageFormat: { Code: 'GIF' },
        LabelStockSize: { Height: '6', Width: '4' }
      }
    }
  };
}

// ── POST /api/label/ups/generate ───────────────────────
router.post('/generate', async (req, res) => {
  const p = req.body || {};
  const required = ['companyName', 'contactName', 'address1', 'city', 'state', 'zip'];
  const missing = required.filter(k => !p[k]);
  if (missing.length) {
    return res.status(400).json({ success: false, error: `Missing fields: ${missing.join(', ')}` });
  }

  try {
    const token = await getToken();
    const picked = await pickService(token, p);
    const payload = buildPayload(p, picked);

    const upsRes = await fetch(`${HOST}/api/shipments/${SHIP_VER}/ship`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'transId': 'tsi-lbl-' + Date.now(),
        'transactionSrc': 'TSIPortal'
      },
      body: JSON.stringify(payload)
    });
    const text = await upsRes.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!upsRes.ok) {
      return res.status(upsRes.status).json({
        success: false,
        error: `UPS ${upsRes.status}`,
        env: ENV,
        ups: json,
        sentPayload: payload
      });
    }

    const r = json.ShipmentResponse || {};
    const results = r.ShipmentResults || {};
    let pkgs = results.PackageResults || [];
    if (!Array.isArray(pkgs)) pkgs = [pkgs];
    const first = pkgs[0] || {};
    const label = first.ShippingLabel || {};

    return res.json({
      success: true,
      env: ENV,
      carrier: 'UPS',
      facility: getFacility(p).state,                        // "PA" or "TN"
      tracking: first.TrackingNumber || results.ShipmentIdentificationNumber || null,
      labelFormat: (label.ImageFormat || {}).Code || null,
      labelBase64: label.GraphicImage || null,
      labelHtmlBase64: label.HTMLImage || null,
      // UPS return labels are pinned to Ground (see buildPayload comment).
      // Surface what the dynamic picker WOULD have chosen for non-return shipments.
      service: { code: '03', name: 'UPS Ground', level: 'GND' },
      pickerSuggestion: picked || null,
      ups: { transactionId: (r.Response || {}).TransactionReference }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, env: ENV });
  }
});

router.get('/health', async (req, res) => {
  res.json({
    env: ENV,
    host: HOST,
    shipVersion: SHIP_VER,
    hasClientId: !!CLIENT_ID,
    hasClientSecret: !!CLIENT_SECRET,
    hasAccountPA: !!ACCOUNT_PA,
    hasAccountTN: !!ACCOUNT_TN,
    facilities: Object.keys(FACILITIES)
  });
});

module.exports = router;
