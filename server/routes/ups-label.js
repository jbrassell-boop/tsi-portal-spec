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

const CLIENT_ID     = process.env.UPS_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.UPS_CLIENT_SECRET || '';
const ACCOUNT       = process.env.UPS_ACCOUNT_NUMBER || '';

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
      'x-merchant-id': ACCOUNT
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

// TSI's address — receiver of all return labels
const TSI_ADDRESS = {
  Name: 'Total Scope Inc',
  AttentionName: 'Receiving Dept',
  ShipperNumber: ACCOUNT,
  Phone: { Number: '8004712255' },
  Address: {
    AddressLine: '17 Creek Pkwy',
    City: 'Upper Chichester',
    StateProvinceCode: 'PA',
    PostalCode: '19061',
    CountryCode: 'US'
  }
};

// ── Build UPS Shipment Request payload ─────────────────
function buildPayload(p) {
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
            BillShipper: { AccountNumber: ACCOUNT }
          }
        },
        Service: { Code: '03', Description: 'UPS Ground' },
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
    const payload = buildPayload(p);

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
      tracking: first.TrackingNumber || results.ShipmentIdentificationNumber || null,
      labelFormat: (label.ImageFormat || {}).Code || null,   // "GIF"
      labelBase64: label.GraphicImage || null,
      labelHtmlBase64: label.HTMLImage || null,
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
    hasAccount: !!ACCOUNT
  });
});

module.exports = router;
