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

// Service preference, cheapest → most expensive (next-business-day options).
// FedEx serviceType strings used by both Rate API and Ship API.
const SERVICE_RANK = [
  { type: 'FEDEX_GROUND',                name: 'FedEx Ground' },
  { type: 'GROUND_HOME_DELIVERY',        name: 'FedEx Home Delivery' },   // residential ground
  { type: 'FEDEX_EXPRESS_SAVER',         name: 'FedEx Express Saver' },   // 3-day, only useful if shipDate gives 1 biz-day
  { type: 'FEDEX_2_DAY',                 name: 'FedEx 2Day' },
  { type: 'STANDARD_OVERNIGHT',          name: 'FedEx Standard Overnight' },
  { type: 'PRIORITY_OVERNIGHT',          name: 'FedEx Priority Overnight' },
  { type: 'FIRST_OVERNIGHT',             name: 'FedEx First Overnight' }
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

// ── Pick fastest+cheapest service via Rate Quotes API ──
async function pickService(token, p) {
  const today = new Date().toISOString().slice(0, 10);
  const body = {
    accountNumber: { value: ACCOUNT },
    requestedShipment: {
      shipper: { address: { postalCode: (p.zip || '').slice(0, 5), countryCode: 'US' } },
      recipient: { address: { postalCode: '19061', countryCode: 'US' } },
      shipDateStamp: today,
      pickupType: 'USE_SCHEDULED_PICKUP',
      rateRequestType: ['LIST'],
      requestedPackageLineItems: [{ weight: { units: 'LB', value: Number(p.weightLbs) || 10 } }]
    }
  };
  try {
    const res = await fetch(`${HOST}/rate/v1/rates/quotes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-locale': 'en_US'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) return null;
    const j = await res.json();
    const details = ((j.output || {}).rateReplyDetails) || [];
    // Filter: commit.dateDetail.day is in M-F (FedEx returns three-letter weekday)
    // and commitTimestamp / dateDetail represents next biz day delivery.
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    while (!BUSINESS_DAYS.includes(['SUN','MON','TUE','WED','THU','FRI','SAT'][tomorrow.getDay()])) {
      tomorrow.setDate(tomorrow.getDate() + 1);
    }
    const targetDate = tomorrow.toISOString().slice(0, 10);   // YYYY-MM-DD

    const eligible = details.filter(d => {
      const cd = d.commit || {};
      // Commit can express delivery via commitTimestamp (ISO) or dateDetail.day
      if (cd.commitTimestamp) {
        const dd = cd.commitTimestamp.slice(0, 10);
        return dd === targetDate;
      }
      const day = (cd.dateDetail || {}).day;
      return day && BUSINESS_DAYS.includes(day.toUpperCase().slice(0, 3));
    });

    // Pick by SERVICE_RANK preference, lowest cost first within preference
    for (const pref of SERVICE_RANK) {
      const hits = eligible.filter(d => d.serviceType === pref.type);
      if (hits.length) {
        const cheapest = hits.sort((a, b) => {
          const ca = Number((a.ratedShipmentDetails || [{}])[0].totalNetCharge || 999999);
          const cb = Number((b.ratedShipmentDetails || [{}])[0].totalNetCharge || 999999);
          return ca - cb;
        })[0];
        const charge = Number((cheapest.ratedShipmentDetails || [{}])[0].totalNetCharge || 0);
        const cd = cheapest.commit || {};
        return { ...pref, charge, deliveryDate: (cd.commitTimestamp || '').slice(0, 10) || targetDate };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// TSI's facility — recipient of all return labels
const TSI_RECIPIENT = {
  contact: {
    personName: 'Receiving Dept',
    phoneNumber: '8004712255',
    companyName: 'Total Scope, Inc.'
  },
  address: {
    streetLines: ['17 Creek Parkway'],
    city: 'Upper Chichester',
    stateOrProvinceCode: 'PA',
    postalCode: '19061',
    countryCode: 'US'
  }
};

function buildPayload(p, picked) {
  const svc = picked || FALLBACK_SERVICE;
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
