// ═══════════════════════════════════════════════════════
//  ups-pickup.js — UPS Pickup On-Call API integration
//  POST /api/pickup/schedule  → schedules a UPS pickup
//  GET  /api/pickup/health    → checks credential + token availability
//
//  Env vars (set in Azure App Service > Configuration):
//    UPS_CLIENT_ID         OAuth client_id from UPS Developer portal
//    UPS_CLIENT_SECRET     OAuth client_secret
//    UPS_ACCOUNT_NUMBER    TSI's UPS shipper account number (the bill-to)
//    UPS_ENV               'CIE' (sandbox, default) or 'PRODUCTION'
// ═══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();

const ENV = (process.env.UPS_ENV || 'CIE').toUpperCase();
const HOST = ENV === 'PRODUCTION'
  ? 'https://onlinetools.ups.com'
  : 'https://wwwcie.ups.com';

// UPS Pickup Creation API version. Override via env if UPS publishes a new one.
const PICKUP_VER = process.env.UPS_PICKUP_VERSION || 'v2409';

const CLIENT_ID     = process.env.UPS_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.UPS_CLIENT_SECRET || '';
const ACCOUNT       = process.env.UPS_ACCOUNT_NUMBER || '';

// ── Token cache (module-scoped; OAuth tokens last ~4hrs) ──
let _token = null;
let _tokenExpiresAt = 0;

async function getToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('UPS credentials not configured. Set UPS_CLIENT_ID and UPS_CLIENT_SECRET in Azure App Service > Configuration.');
  }
  if (_token && Date.now() < _tokenExpiresAt - 60_000) {
    return _token;
  }
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
  if (!res.ok) {
    throw new Error(`UPS OAuth ${res.status}: ${text}`);
  }
  const json = JSON.parse(text);
  _token = json.access_token;
  _tokenExpiresAt = Date.now() + (parseInt(json.expires_in || '14400', 10) * 1000);
  return _token;
}

// ── Build the UPS Pickup Creation request payload ──────
//  Input shape (from form/RRF):
//    { companyName, contactName, phone,
//      address1, address2, city, state, zip,
//      pickupDate (YYYY-MM-DD),
//      readyTime (HH:mm, default 08:00),
//      closeTime (HH:mm, e.g. 14:00),
//      packageCount (default 1),
//      weightLbs   (default 10),
//      specialInstruction (optional),
//      residential (boolean, default false) }
function buildPayload(p) {
  const yyyymmdd = (p.pickupDate || '').replace(/-/g, '');     // 2026-04-30 → 20260430
  const hhmm = (s) => (s || '').replace(':', '').padStart(4, '0'); // 14:00 → 1400
  const phoneDigits = (p.phone || '').replace(/[^\d]/g, '');

  return {
    PickupCreationRequest: {
      RatePickupIndicator: 'N',
      Shipper: {
        Account: { AccountNumber: ACCOUNT, AccountCountryCode: 'US' }
      },
      PickupDateInfo: {
        CloseTime: hhmm(p.closeTime || '17:00'),
        ReadyTime: hhmm(p.readyTime || '08:00'),
        PickupDate: yyyymmdd
      },
      PickupAddress: {
        CompanyName: (p.companyName || '').slice(0, 35),
        ContactName: (p.contactName || '').slice(0, 35),
        AddressLine: (p.address1 || '').slice(0, 35),
        ...(p.address2 ? { Room: String(p.address2).slice(0, 35) } : {}),
        City: (p.city || '').slice(0, 30),
        StateProvince: (p.state || '').slice(0, 5),
        PostalCode: (p.zip || '').slice(0, 10),
        CountryCode: 'US',
        ResidentialIndicator: p.residential ? 'Y' : 'N',
        ...(phoneDigits ? { Phone: { Number: phoneDigits } } : {})
      },
      AlternateAddressIndicator: 'Y',
      PickupPiece: [{
        ServiceCode: '001',           // 001 = UPS Next Day Air; UPS accepts this for Ground pickups too
        Quantity: String(p.packageCount || 1),
        DestinationCountryCode: 'US',
        ContainerCode: '01'           // 01 = Customer-supplied package
      }],
      TotalWeight: {
        Weight: String(p.weightLbs || 10),
        UnitOfMeasurement: 'LBS'
      },
      OverweightIndicator: (Number(p.weightLbs || 0) > 70) ? 'Y' : 'N',
      PaymentMethod: '01',            // 01 = Bill Shipper (TSI account) per v2409 spec
      SpecialInstruction: (p.specialInstruction || '').slice(0, 90)
    }
  };
}

// ── POST /api/pickup/schedule ──────────────────────────
router.post('/schedule', async (req, res) => {
  const p = req.body || {};

  // Minimal validation — UPS will reject the rest
  const required = ['companyName', 'contactName', 'address1', 'city', 'state', 'zip', 'pickupDate', 'closeTime'];
  const missing = required.filter(k => !p[k]);
  if (missing.length) {
    return res.status(400).json({ success: false, error: `Missing fields: ${missing.join(', ')}` });
  }

  try {
    const token = await getToken();
    const payload = buildPayload(p);

    const transId = 'tsi-' + Date.now();
    const upsRes = await fetch(`${HOST}/api/pickupcreation/${PICKUP_VER}/pickup`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'transId': transId,
        'transactionSrc': 'TSIPortal'
      },
      body: JSON.stringify(payload)
    });
    const upsText = await upsRes.text();
    let upsJson;
    try { upsJson = JSON.parse(upsText); } catch { upsJson = { raw: upsText }; }

    if (!upsRes.ok) {
      return res.status(upsRes.status).json({
        success: false,
        error: `UPS ${upsRes.status}`,
        env: ENV,
        ups: upsJson,
        sentPayload: payload
      });
    }

    const r = upsJson.PickupCreationResponse || {};
    return res.json({
      success: true,
      env: ENV,
      prn: r.PRN || null,                                            // Pickup Request Number
      rateStatus: r.RateStatus && r.RateStatus.Code,
      rateAmount: r.RateResult && r.RateResult.GrandTotalOfAllCharge,
      ups: upsJson,
      sentPayload: payload
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, env: ENV });
  }
});

// ── GET /api/pickup/health — does the env have what it needs? ──
router.get('/health', async (req, res) => {
  const status = {
    env: ENV,
    host: HOST,
    pickupVersion: PICKUP_VER,
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
