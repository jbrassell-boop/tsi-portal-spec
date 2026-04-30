// ═══════════════════════════════════════════════════════
//  fedex-pickup.js — FedEx Pickup Request API integration
//  POST /api/fedex-pickup/schedule  → schedule a FedEx pickup
//  GET  /api/fedex-pickup/health    → cred + token status
//
//  Env vars (App Service > Configuration):
//    FEDEX_CLIENT_ID       FedEx Developer Portal API Key
//    FEDEX_CLIENT_SECRET   FedEx Developer Portal Secret Key
//    FEDEX_ACCOUNT_NUMBER  TSI's FedEx shipper account number
//    FEDEX_ENV             'SANDBOX' (default) or 'PRODUCTION'
//
//  Endpoint: POST {host}/pickup/v1/pickups
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

// FedEx tokens last 1 hour. Cache in memory.
let _token = null;
let _tokenExpiresAt = 0;

async function getToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('FedEx credentials not configured. Set FEDEX_CLIENT_ID and FEDEX_CLIENT_SECRET in App Service > Configuration.');
  }
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
  const json = JSON.parse(text);
  _token = json.access_token;
  _tokenExpiresAt = Date.now() + (parseInt(json.expires_in || '3600', 10) * 1000);
  return _token;
}

// ── Build FedEx Pickup Request payload ─────────────────
//  Input shape matches the UPS route (same form fields):
//    { companyName, contactName, phone, address1, address2,
//      city, state, zip, pickupDate (YYYY-MM-DD),
//      readyTime (HH:mm), closeTime (HH:mm),
//      packageCount, weightLbs, specialInstruction, residential }
function buildPayload(p) {
  // FedEx wants ISO 8601 readyDateTimestamp: "YYYY-MM-DDTHH:mm:ss"
  const readyTimestamp = `${p.pickupDate}T${(p.readyTime || '08:00')}:00`;
  // customerCloseTime is "HH:MM:SS"
  const closeTime = `${(p.closeTime || '17:00')}:00`;
  const phoneDigits = (p.phone || '').replace(/[^\d]/g, '');
  const streetLines = [p.address1, p.address2].filter(Boolean);

  return {
    associatedAccountNumber: { value: ACCOUNT },
    originDetail: {
      pickupAddressType: 'ACCOUNT',
      pickupLocation: {
        contact: {
          companyName: (p.companyName || '').slice(0, 35),
          personName: (p.contactName || '').slice(0, 35),
          ...(phoneDigits ? { phoneNumber: phoneDigits } : {}),
          ...(p.emailAddress ? { emailAddress: String(p.emailAddress).slice(0, 80) } : {})
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
      readyDateTimestamp: readyTimestamp,
      customerCloseTime: closeTime,
      packageLocation: 'FRONT'
    },
    associatedAccountNumberType: 'FEDEX_GROUND',
    totalWeight: {
      units: 'LB',
      value: Number(p.weightLbs) || 10
    },
    packageCount: Number(p.packageCount) || 1,
    carrierCode: 'FDXG',  // FDXG = FedEx Ground (typical for return RMAs); FDXE = Express
    countryRelationships: 'DOMESTIC',
    pickupType: 'ON_CALL',
    ...(p.specialInstruction ? { remarks: String(p.specialInstruction).slice(0, 100) } : {})
  };
}

// ── POST /api/fedex-pickup/schedule ────────────────────
router.post('/schedule', async (req, res) => {
  const p = req.body || {};
  const required = ['companyName', 'contactName', 'address1', 'city', 'state', 'zip', 'pickupDate', 'closeTime'];
  const missing = required.filter(k => !p[k]);
  if (missing.length) {
    return res.status(400).json({ success: false, error: `Missing fields: ${missing.join(', ')}` });
  }

  try {
    const token = await getToken();
    const payload = buildPayload(p);

    const fxRes = await fetch(`${HOST}/pickup/v1/pickups`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-locale': 'en_US'
      },
      body: JSON.stringify(payload)
    });
    const fxText = await fxRes.text();
    let fxJson; try { fxJson = JSON.parse(fxText); } catch { fxJson = { raw: fxText }; }

    if (!fxRes.ok) {
      return res.status(fxRes.status).json({
        success: false,
        error: `FedEx ${fxRes.status}`,
        env: ENV,
        fedex: fxJson,
        sentPayload: payload
      });
    }

    // FedEx returns: { output: { pickupConfirmationCode, location, ... }, customerTransactionId }
    const out = fxJson.output || {};
    return res.json({
      success: true,
      env: ENV,
      confirmationNumber: out.pickupConfirmationCode || null,  // FedEx's equivalent of PRN
      location: out.location || null,
      fedex: fxJson,
      sentPayload: payload
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, env: ENV });
  }
});

// ── GET /api/fedex-pickup/health ───────────────────────
router.get('/health', async (req, res) => {
  const status = {
    env: ENV,
    host: HOST,
    hasClientId: !!CLIENT_ID,
    hasClientSecret: !!CLIENT_SECRET,
    hasAccount: !!ACCOUNT,
    tokenCached: !!_token,
    tokenExpiresInSec: _token ? Math.max(0, Math.round((_tokenExpiresAt - Date.now()) / 1000)) : 0
  };
  if (req.query.testToken === '1' && status.hasClientId && status.hasClientSecret) {
    try { await getToken(); status.tokenFetch = 'ok'; status.tokenCached = true; }
    catch (e) { status.tokenFetch = 'fail'; status.tokenError = e.message; }
  }
  res.json(status);
});

module.exports = router;
