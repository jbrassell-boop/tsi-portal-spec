// ═══════════════════════════════════════════════════════
//  portal.js — Sales Rep Portal API routes
//  Filtered contract views scoped to a sales rep or client.
//  All endpoints under /api/portal/...
// ═══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const db = require('../db');

// ── Shared SELECT for contract list (enriched with JOINs) ──
// Identical to contracts.js CONTRACT_SELECT so portal responses
// share the same field shape as the internal admin endpoints.
const CONTRACT_SELECT = `
  SELECT con.lContractKey, con.sContractNumber, con.lClientKey,
    con.lContractTypeKey, con.lSalesRepKey, con.lPaymentTermsKey,
    con.dtDateEffective, con.dtDateTermination,
    con.dblAmtTotal AS dblAmtContract, con.dblAmtInvoiced AS dblAmtExpense,
    con.sPurchaseOrder, con.mComments,
    con.dtCreateDate, con.dtLastUpdate,
    ISNULL(c.sClientName1, '') AS sClientName1,
    LTRIM(RTRIM(ISNULL(sr.sRepFirst,'') + ' ' + ISNULL(sr.sRepLast,''))) AS sSalesRepName,
    sr.lSalesRepKey AS lSalesRepNameKey,
    ISNULL(ct.sContractType, '') AS sContractTypeName,
    ISNULL(pt.sTermsDesc, '') AS sPaymentTerms,
    CASE
      WHEN con.dtDateTermination < GETDATE() THEN 'Expired'
      WHEN con.dtDateEffective > GETDATE() THEN 'Pending'
      ELSE 'Active'
    END AS sContractStatus
  FROM tblContract con
    LEFT JOIN tblClient c ON c.lClientKey = con.lClientKey
    LEFT JOIN tblSalesRep sr ON sr.lSalesRepKey = con.lSalesRepKey
    LEFT JOIN tblContractTypes ct ON ct.lContractTypeKey = con.lContractTypeKey
    LEFT JOIN tblPaymentTerms pt ON pt.lPaymentTermsKey = con.lPaymentTermsKey
`;

// ── Build a reusable WHERE fragment + params object ──────
// Returns { where: string, params: object } ready to append
// to CONTRACT_SELECT.  Also builds a matching WHERE that can
// be used on tblContractScope via INNER JOIN tblContract con.
function buildContractWhere(salesRepKey, clientKey, status) {
  const conditions = [];
  const params = {};

  if (salesRepKey) {
    conditions.push('con.lSalesRepKey = @salesRepKey');
    params.salesRepKey = salesRepKey;
  }

  if (clientKey) {
    conditions.push('con.lClientKey = @clientKey');
    params.clientKey = clientKey;
  }

  // Status filter maps to date-range conditions so the CASE
  // expression in SELECT and the WHERE agree exactly.
  switch (status) {
    case 'Active':
      conditions.push(
        'con.dtDateEffective <= GETDATE()',
        'con.dtDateTermination >= GETDATE()'
      );
      break;
    case 'Expired':
      conditions.push('con.dtDateTermination < GETDATE()');
      break;
    case 'Pending':
      conditions.push('con.dtDateEffective > GETDATE()');
      break;
    case 'Expiring':
      // Active today but terminating within 90 days
      conditions.push(
        'con.dtDateEffective <= GETDATE()',
        'con.dtDateTermination >= GETDATE()',
        'con.dtDateTermination <= DATEADD(day, 90, GETDATE())'
      );
      break;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return { where, params };
}

// ── Compute monthly revenue from a row set (JS-side) ────
// Uses dblAmtContract and the effective/termination dates.
// Avoids divide-by-zero by treating 0-month spans as null.
function computeMonthlyRevenue(contracts) {
  let total = 0;
  for (const c of contracts) {
    if (c.sContractStatus !== 'Active') continue;
    const amt = parseFloat(c.dblAmtContract) || 0;
    if (!amt) continue;
    const dtEff = new Date(c.dtDateEffective);
    const dtTerm = new Date(c.dtDateTermination);
    const months =
      (dtTerm.getFullYear() - dtEff.getFullYear()) * 12 +
      (dtTerm.getMonth() - dtEff.getMonth());
    if (months > 0) {
      total += amt / months;
    }
  }
  return Math.round(total * 100) / 100;
}

// ────────────────────────────────────────────────────────
//  GET /api/portal/contracts
//  Query params: salesRepKey, clientKey, status
// ────────────────────────────────────────────────────────
router.get('/portal/contracts', async (req, res, next) => {
  try {
    const salesRepKey = parseInt(req.query.salesRepKey) || 0;
    const clientKey   = parseInt(req.query.clientKey)   || 0;
    const status      = req.query.status || '';

    const { where, params } = buildContractWhere(
      salesRepKey || null,
      clientKey   || null,
      status      || null
    );

    // ── Main contract list ───────────────────────────────
    const contracts = await db.query(
      `${CONTRACT_SELECT} ${where} ORDER BY con.dtDateTermination DESC`,
      params
    );

    // ── KPI: activeCount + expiringCount from the row set ─
    // Counts are derived from the already-fetched rows so we
    // don't issue a second query for these two tallies.
    const now = new Date();
    const plus90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    let activeCount   = 0;
    let expiringCount = 0;

    for (const c of contracts) {
      if (c.sContractStatus === 'Active') {
        activeCount++;
        const term = new Date(c.dtDateTermination);
        if (term <= plus90) expiringCount++;
      }
    }

    // ── KPI: monthlyRevenue (JS computation) ─────────────
    const monthlyRevenue = computeMonthlyRevenue(contracts);

    // ── KPI: totalScopes (separate COUNT query) ───────────
    // Build the same WHERE but targeting tblContractScope cs
    // joined back to tblContract con so the same filters apply.
    const scopeConditions = [];
    const scopeParams = Object.assign({}, params);

    if (salesRepKey) scopeConditions.push('con.lSalesRepKey = @salesRepKey');
    if (clientKey)   scopeConditions.push('con.lClientKey = @clientKey');

    // For the scope count we intentionally omit the status
    // date filter — we count all scopes on the filtered
    // contracts regardless of status unless a status was
    // explicitly requested, in which case we mirror it.
    if (status === 'Active' || status === 'Expiring') {
      scopeConditions.push(
        'con.dtDateEffective <= GETDATE()',
        'con.dtDateTermination >= GETDATE()'
      );
    } else if (status === 'Expired') {
      scopeConditions.push('con.dtDateTermination < GETDATE()');
    } else if (status === 'Pending') {
      scopeConditions.push('con.dtDateEffective > GETDATE()');
    }
    if (status === 'Expiring') {
      scopeConditions.push('con.dtDateTermination <= DATEADD(day, 90, GETDATE())');
    }

    const scopeWhere = scopeConditions.length
      ? 'WHERE ' + scopeConditions.join(' AND ')
      : '';

    const scopeRow = await db.queryOne(
      `SELECT COUNT(*) AS nTotal
       FROM tblContractScope cs
         INNER JOIN tblContract con ON con.lContractKey = cs.lContractKey
       ${scopeWhere}`,
      scopeParams
    );

    const totalScopes = scopeRow ? (scopeRow.nTotal || 0) : 0;

    res.json({
      success: true,
      contracts,
      kpis: { activeCount, expiringCount, monthlyRevenue, totalScopes }
    });
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────
//  GET /api/portal/contracts/:contractKey/detail
//  Returns: { info, departments, repairs, coverage }
// ────────────────────────────────────────────────────────
router.get('/portal/contracts/:contractKey/detail', async (req, res, next) => {
  try {
    const contractKey = parseInt(req.params.contractKey) || 0;
    if (!contractKey) {
      return res.status(400).json({ success: false, error: 'contractKey required' });
    }

    // Run all six queries in parallel for minimum round-trip time.
    const [info, departments, repairs, coverageRows, scopes, reasons] = await Promise.all([

      // 1. Contract header row
      db.queryOne(
        `${CONTRACT_SELECT} WHERE con.lContractKey = @contractKey`,
        { contractKey }
      ),

      // 2. Departments on this contract
      db.query(
        `SELECT cd.lContractDepartmentKey, cd.lDepartmentKey,
           cd.dtContractDepartmentEffectiveDate, cd.dtContractDepartmentEndDate,
           cd.bNonBillable, cd.sPONumber,
           ISNULL(d.sDepartmentName, '') AS sDepartmentName
         FROM tblContractDepartments cd
           LEFT JOIN tblDepartment d ON d.lDepartmentKey = cd.lDepartmentKey
         WHERE cd.lContractKey = @contractKey
         ORDER BY d.sDepartmentName`,
        { contractKey }
      ),

      // 3. Last 100 repairs under this contract
      db.query(
        `SELECT TOP 100
           r.lRepairKey, r.sWorkOrderNumber,
           r.dtDateIn, r.dtDateOut, r.dtShipDate,
           r.dblAmtRepair,
           r.sComplaintDesc,
           r.sInsFinalPF,
           r.bReplaced, r.bOutsourced,
           ISNULL(rs.sRepairStatus, '')    AS sRepairStatus,
           ISNULL(rr.sRepairReason, '')   AS sRepairReason,
           rr.lRepairReasonCategoryKey    AS nReasonCategory,
           ISNULL(s.sSerialNumber, '')    AS sSerialNumber,
           ISNULL(st.sScopeTypeDesc, '')  AS sScopeTypeDesc,
           ISNULL(d.sDepartmentName, '')  AS sDepartmentName,
           ISNULL(t.sTechName, '')        AS sTechName
         FROM tblRepair r
           LEFT JOIN tblRepairStatuses rs  ON rs.lRepairStatusID  = r.lRepairStatusID
           LEFT JOIN tblRepairReasons rr   ON rr.lRepairReasonKey = r.lRepairReasonKey
           LEFT JOIN tblScope s            ON s.lScopeKey         = r.lScopeKey
           LEFT JOIN tblScopeType st       ON st.lScopeTypeKey    = s.lScopeTypeKey
           LEFT JOIN tblDepartment d       ON d.lDepartmentKey    = r.lDepartmentKey
           LEFT JOIN tblTechnicians t      ON t.lTechnicianKey    = r.lTechnicianKey
         WHERE r.lContractKey = @contractKey
         ORDER BY r.dtDateIn DESC`,
        { contractKey }
      ),

      // 4. Scope coverage counts by instrument category
      db.query(
        `SELECT ISNULL(st.sRigidOrFlexible, 'I') AS sRigidOrFlexible,
           COUNT(*) AS nCount
         FROM tblContractScope cs
           LEFT JOIN tblScope s    ON s.lScopeKey      = cs.lScopeKey
           LEFT JOIN tblScopeType st ON st.lScopeTypeKey = s.lScopeTypeKey
         WHERE cs.lContractKey = @contractKey
         GROUP BY ISNULL(st.sRigidOrFlexible, 'I')`,
        { contractKey }
      ),

      // 5. Scopes enrolled on this contract
      db.query(
        `SELECT
           cs.lScopeKey,
           ISNULL(s.sSerialNumber, '') AS sSerialNumber,
           ISNULL(st.sScopeTypeDesc, '') AS sScopeTypeDesc,
           ISNULL(st.sRigidOrFlexible, 'I') AS sRigidOrFlexible,
           ISNULL(m.sManufacturer, '') AS sManufacturer,
           ISNULL(d.sDepartmentName, '') AS sDeptName,
           (SELECT COUNT(*) FROM tblRepair r2
            WHERE r2.lScopeKey = cs.lScopeKey
              AND r2.lContractKey = @contractKey) AS nRepairCount
         FROM tblContractScope cs
           LEFT JOIN tblScope s          ON s.lScopeKey          = cs.lScopeKey
           LEFT JOIN tblScopeType st     ON st.lScopeTypeKey      = s.lScopeTypeKey
           LEFT JOIN tblManufacturers m  ON m.lManufacturerKey    = st.lManufacturerKey
           LEFT JOIN tblDepartment d     ON d.lDepartmentKey      = s.lDepartmentKey
         WHERE cs.lContractKey = @contractKey
         ORDER BY d.sDepartmentName, st.sScopeTypeDesc`,
        { contractKey }
      ),

      // 6. Top 15 repair reason breakdown (grouped on standardized repair reason code)
      db.query(
        `SELECT TOP 15
           ISNULL(rr.sRepairReason, 'Unknown') AS sReason,
           rr.lRepairReasonCategoryKey          AS nReasonCategory,
           COUNT(*) AS nCount,
           SUM(ISNULL(r.dblAmtRepair, 0)) AS dblCharges
         FROM tblRepair r
           LEFT JOIN tblRepairReasons rr ON rr.lRepairReasonKey = r.lRepairReasonKey
         WHERE r.lContractKey = @contractKey
         GROUP BY rr.sRepairReason, rr.lRepairReasonCategoryKey
         ORDER BY nCount DESC`,
        { contractKey }
      )
    ]);

    // Pivot the coverage row set into a flat object.
    // sRigidOrFlexible values: R = Rigid, F = Flexible, C = Camera, I (or null) = Instrument
    const coverage = { rigid: 0, flexible: 0, camera: 0, instrument: 0 };
    for (const row of coverageRows) {
      switch (row.sRigidOrFlexible) {
        case 'R': coverage.rigid      += row.nCount; break;
        case 'F': coverage.flexible   += row.nCount; break;
        case 'C': coverage.camera     += row.nCount; break;
        default:  coverage.instrument += row.nCount; break;
      }
    }

    res.json({
      success: true,
      info:        info || {},
      departments,
      repairs,
      coverage,
      scopes,
      reasons,
      documents: []
    });
  } catch (e) { next(e); }
});

module.exports = router;
