// ═══════════════════════════════════════════════════════
//  fedex-label.js — FedEx Ship API (return-label generation)
//  POST /api/label/fedex/generate
//  GET  /api/label/fedex/health
//
//  Reuses FEDEX_CLIENT_ID / FEDEX_CLIENT_SECRET / FEDEX_ACCOUNT_NUMBER
//  / FEDEX_ENV from the pickup integration.
//
//  Endpoint: POST {host}/ship/v1/shipments
//  pickupType: USE_SCHEDULED_PICKUP (no extra fee — TSI already has
//  scheduled pickup from FedEx for daily outbound)
// ═══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();

const ENV = (process.env.FEDEX_ENV || 'SANDBOX').toUpperCase();
const HOST = ENV === 'PRODUCTION'
  ? 'https://apis.fedex.com'
  : 'https://apis-sandbox.fedex.com';

const CLIENT_ID     = process.env.FEDEX_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.FEDEX_CLIENT_SECRET || '';
const ACCOUNT       = process.env.FEDEX_ACCOUNT_NUMBER || '';

// TSI receives M-F only
const BUSINESS_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

// Service preference per Joe's rule (2026-04-30):
//   "If Ground gets it there next biz day → Ground.
//    Otherwise next-day air."
// For FedEx that means: FEDEX_GROUND (or GROUND_HOME_DELIVERY for residential)
// → STANDARD_OVERNIGHT (cheapest next-day air; equivalent to UPS Saver).
// Drops FEDEX_EXPRESS_SAVER (3-day), FEDEX_2_DAY, PRIORITY_OVERNIGHT,
// FIRST_OVERNIGHT — same delivery as Standard but more expensive.
const SERVICE_RANK = [
  { type: 'FEDEX_GROUND',         name: 'FedEx Ground' },
  { type: 'GROUND_HOME_DELIVERY', name: 'FedEx Home Delivery' },   // residential ground
  { type: 'STANDARD_OVERNIGHT',   name: 'FedEx Standard Overnight' }
];
const FALLBACK_SERVICE = { type: 'STANDARD_OVERNIGHT', name: 'FedEx Standard Overnight' };

let _token = null;
let _tokenExpiresAt = 0;

async function getToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('FedEx credentials not configured.');
  if (_token && Date.now() < _tokenExpiresAt - 60_000) return _token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  });
  const res = await fetch(`${HOST}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FedEx OAuth ${res.status}: ${text}`);
  const j = JSON.parse(text);
  _token = j.access_token;
  _tokenExpiresAt = Date.now() + (parseInt(j.expires_in || '3600', 10) * 1000);
  return _token;
}

// ── Pick fastest+cheapest service ──
//
// Strategy:
//   1. Call FedEx Rate Quotes for the rate of each service.
//   2. Use UPS Time-in-Transit as the oracle for "does Ground deliver next biz
//      day from this origin?" — UPS Ground 1-day zones and FedEx Ground 1-day
//      zones are nearly identical (same road network, same regional delivery
//      economics). FedEx sandbox doesn't return commit dates on Rate, but UPS
//      sandbox does on Time-in-Transit, so we get usable delivery info either
//      way without needing FedEx Transit Times API subscription.
//   3. If UPS says Ground is 1-day eligible, prefer FEDEX_GROUND. Otherwise
//      pick STANDARD_OVERNIGHT.
async function pickService(token, p) {
  const today = new Date().toISOString().slice(0, 10);
  const fac = getFacility(p);

  // ── Step 1: get FedEx rates for each service ──
  let rateMap = {};
  try {
    const rateRes = await fetch(`${HOST}/rate/v1/rates/quotes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-locale': 'en_US'
      },
      body: JSON.stringify({
        accountNumber: { value: ACCOUNT },
        requestedShipment: {
          shipper: { address: { postalCode: (p.zip || '').slice(0, 5), countryCode: 'US' } },
          recipient: { address: { postalCode: fac.zip, countryCode: 'US' } },
          shipDateStamp: today,
          pickupType: 'USE_SCHEDULED_PICKUP',
          rateRequestType: ['LIST'],
          requestedPackageLineItems: [{ weight: { units: 'LB', value: Number(p.weightLbs) || 10 } }]
        }
      })
    });
    if (rateRes.ok) {
      const rj = await rateRes.json();
      for (const d of (rj.output || {}).rateReplyDetails || []) {
        const charge = Number((d.ratedShipmentDetails || [{}])[0].totalNetCharge || 0);
        rateMap[d.serviceType] = charge;
      }
    }
  } catch { /* fall through to oracle */ }

  // ── Step 2: oracle — is FedEx Ground 1-day eligible from this origin? ──
  // We delegate to UPS's Time-in-Transit (always sandbox-truthful, free, already
  // wired). If UPS Ground is 1-day eligible, FedEx Ground is too with high
  // confidence (same physical road network).
  const groundIsNextDay = await isGroundOneDayViaUps(p, fac);

  // ── Step 3: pick by preference ──
  const tomorrow = nextBusinessDay();
  if (groundIsNextDay) {
    // Pick the appropriate Ground variant — prefer commercial Ground.
    const groundType = p.residential ? 'GROUND_HOME_DELIVERY' : 'FEDEX_GROUND';
    const charge = rateMap[groundType] || rateMap['FEDEX_GROUND'] || null;
    return {
      type: groundType,
      name: groundType === 'GROUND_HOME_DELIVERY' ? 'FedEx Home Delivery' : 'FedEx Ground',
      charge,
      deliveryDate: tomorrow
    };
  }
  return {
    type: 'STANDARD_OVERNIGHT',
    name: 'FedEx Standard Overnight',
    charge: rateMap['STANDARD_OVERNIGHT'] || null,
    deliveryDate: tomorrow
  };
}

// Returns YYYY-MM-DD string for next business day (M-F)
function nextBusinessDay() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (![1, 2, 3, 4, 5].includes(d.getDay())) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// UPS Time-in-Transit oracle: ask UPS if Ground delivers next biz day from
// this origin to TSI's facility ZIP. Falls back to false (= use Overnight)
// on any error so we never fail the whole label flow because of the oracle.
const UPS_OAUTH = {
  host: (process.env.UPS_ENV || 'CIE').toUpperCase() === 'PRODUCTION'
    ? 'https://onlinetools.ups.com'
    : 'https://wwwcie.ups.com',
  clientId: process.env.UPS_CLIENT_ID || '',
  clientSecret: process.env.UPS_CLIENT_SECRET || ''
};
let _upsOracleToken = null;
let _upsOracleTokenExpiresAt = 0;

async function getUpsOracleToken() {
  if (!UPS_OAUTH.clientId || !UPS_OAUTH.clientSecret) return null;
  if (_upsOracleToken && Date.now() < _upsOracleTokenExpiresAt - 60_000) return _upsOracleToken;
  const basic = Buffer.from(`${UPS_OAUTH.clientId}:${UPS_OAUTH.clientSecret}`).toString('base64');
  try {
    const r = await fetch(`${UPS_OAUTH.host}/security/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    if (!r.ok) return null;
    const j = await r.json();
    _upsOracleToken = j.access_token;
    _upsOracleTokenExpiresAt = Date.now() + (parseInt(j.expires_in || '14400', 10) * 1000);
    return _upsOracleToken;
  } catch { return null; }
}

async function isGroundOneDayViaUps(p, fac) {
  const token = await getUpsOracleToken();
  if (!token) return false;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = await fetch(`${UPS_OAUTH.host}/api/shipments/v1/transittimes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'transId': 'fedex-oracle-' + Date.now(),
        'transactionSrc': 'TSIPortal'
      },
      body: JSON.stringify({
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
      })
    });
    if (!r.ok) return false;
    const j = await r.json();
    const services = (j.emsResponse || {}).services || [];
    return services.some(s =>
      s.serviceLevel === 'GND' &&
      Number(s.businessTransitDays) === 1 &&
      BUSINESS_DAYS.includes(s.deliveryDayOfWeek)
    );
  } catch { return false; }
}

// Facility routing — same model as ups-label.js
const FACILITIES = {
  PA: {
    name: 'Total Scope, Inc.',
    contact: 'Receiving Dept (PA)',
    phone: '8004712255',
    streetLines: ['17 Creek Parkway'],
    city: 'Upper Chichester',
    state: 'PA',
    zip: '19061'
  },
  TN: {
    name: 'Total Scope South',
    contact: 'Receiving Dept (TN)',
    phone: '8004712255',
    // TODO: confirm street address with Joe — placeholder
    streetLines: ['TBD — Nashville facility'],
    city: 'Nashville',
    state: 'TN',
    zip: '37210'
  }
};
function getFacility(p) {
  const f = String(p.facility || 'PA').toUpperCase();
  return FACILITIES[f] || FACILITIES.PA;
}
function tsiRecipient(fac) {
  return {
    contact: {
      personName: fac.contact,
      phoneNumber: fac.phone,
      companyName: fac.name
    },
    address: {
      streetLines: fac.streetLines,
      city: fac.city,
      stateOrProvinceCode: fac.state,
      postalCode: fac.zip,
      countryCode: 'US'
    }
  };
}

function buildPayload(p, picked) {
  const svc = picked || FALLBACK_SERVICE;
  const fac = getFacility(p);
  const TSI_RECIPIENT = tsiRecipient(fac);
  const phoneDigits = (p.phone || '').replace(/[^\d]/g, '');
  const streetLines = [p.address1, p.address2].filter(Boolean);
  const today = (new Date()).toISOString().slice(0, 10);

  // For a RETURN label: customer is the shipper (pickup origin),
  // TSI is the recipient. FedEx Ground.
  return {
    labelResponseOptions: 'LABEL',  // returns label inline (vs URL_ONLY)
    accountNumber: { value: ACCOUNT },
    requestedShipment: {
      shipper: {
        contact: {
          personName: (p.contactName || '').slice(0, 70),
          phoneNumber: phoneDigits || '0000000000',
          companyName: (p.companyName || '').slice(0, 35)
        },
        address: {
          streetLines: streetLines,
          city: (p.city || '').slice(0, 35),
          stateOrProvinceCode: (p.state || '').slice(0, 2),
          postalCode: (p.zip || '').slice(0, 10),
          countryCode: 'US',
          residential: !!p.residential
        }
      },
      recipients: [TSI_RECIPIENT],
      shipDatestamp: today,
      serviceType: svc.type,
      packagingType: 'YOUR_PACKAGING',
      pickupType: 'USE_SCHEDULED_PICKUP',
      shippingChargesPayment: {
        paymentType: 'SENDER',
        payor: {
          responsibleParty: {
            accountNumber: { value: ACCOUNT },
            address: TSI_RECIPIENT.address
          }
        }
      },
      labelSpecification: {
        labelStockType: 'PAPER_85X11_TOP_HALF_LABEL',
        imageType: 'PDF',
        labelFormatType: 'COMMON2D'
      },
      requestedPackageLineItems: [{
        weight: { units: 'LB', value: Number(p.weightLbs) || 10 },
        ...(p.description ? { customerReferences: [
          { customerReferenceType: 'CUSTOMER_REFERENCE', value: String(p.description).slice(0, 40) }
        ] } : {})
      }]
    }
  };
}

router.post('/generate', async (req, res) => {
  const p = req.body || {};
  const required = ['companyName', 'contactName', 'address1', 'city', 'state', 'zip'];
  const missing = required.filter(k => !p[k]);
  if (missing.length) return res.status(400).json({ success: false, error: `Missing fields: ${missing.join(', ')}` });

  try {
    const token = await getToken();
    const picked = await pickService(token, p);
    const payload = buildPayload(p, picked);

    const fxRes = await fetch(`${HOST}/ship/v1/shipments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-locale': 'en_US'
      },
      body: JSON.stringify(payload)
    });
    const text = await fxRes.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!fxRes.ok) {
      return res.status(fxRes.status).json({
        success: false,
        error: `FedEx ${fxRes.status}`,
        env: ENV,
        fedex: json,
        sentPayload: payload
      });
    }

    const out = json.output || {};
    const tx = (out.transactionShipments || [])[0] || {};
    const piece = (tx.pieceResponses || [])[0] || {};
    const docs = piece.packageDocuments || [];
    const labelDoc = docs[0] || {};

    return res.json({
      success: true,
      env: ENV,
      carrier: 'FedEx',
      facility: getFacility(p).state,
      tracking: piece.trackingNumber || tx.masterTrackingNumber || null,
      labelFormat: labelDoc.contentType || 'PDF',
      labelBase64: labelDoc.encodedLabel || null,
      labelUrl: labelDoc.url || null,
      service: picked || { ...FALLBACK_SERVICE, charge: null, deliveryDate: null, fallback: true },
      fedex: { transactionId: json.transactionId }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, env: ENV });
  }
});

router.get('/health', async (req, res) => {
  res.json({
    env: ENV,
    host: HOST,
    hasClientId: !!CLIENT_ID,
    hasClientSecret: !!CLIENT_SECRET,
    hasAccount: !!ACCOUNT
  });
});

module.exports = router;
