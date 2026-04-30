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

function buildPayload(p) {
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
      serviceType: 'FEDEX_GROUND',
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
    const payload = buildPayload(p);

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
