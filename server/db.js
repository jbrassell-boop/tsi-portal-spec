// ═══════════════════════════════════════════════════════
//  db.js — SQL Server connection pool + query helpers
//  Supports both Windows Auth (local) and SQL Auth (cloud)
// ═══════════════════════════════════════════════════════

// Use msnodesqlv8 (Windows ODBC) locally, tedious (cross-platform) on cloud
const isCloud = !!process.env.DB_SERVER;
let sql;
if (isCloud) {
  sql = require('mssql');
} else {
  try { sql = require('mssql/msnodesqlv8'); }
  catch { sql = require('mssql'); }
}

const config = isCloud
  ? {
      server: process.env.DB_SERVER,
      database: process.env.DB_NAME || 'TSI_Demo',
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      options: {
        encrypt: true,
        trustServerCertificate: false
      },
      pool: { max: 50, min: 5, idleTimeoutMillis: 30000 }
    }
  : {
      database: 'TSI_Demo',
      driver: 'msnodesqlv8',
      connectionString: 'Driver={ODBC Driver 18 for SQL Server};Server=localhost;Database=TSI_Demo;Trusted_Connection=yes;TrustServerCertificate=yes;',
      pool: { max: 50, min: 5, idleTimeoutMillis: 30000 }
    };

let _pool = null;

async function connect() {
  if (_pool) return _pool;
  _pool = await new sql.ConnectionPool(config).connect();
  console.log('[DB] Connected to', (config.server || 'localhost') + '/' + config.database);
  return _pool;
}

async function close() {
  if (_pool) { await _pool.close(); _pool = null; }
}

// Run a parameterized query — params is { name: value } object
async function query(sqlText, params) {
  const pool = await connect();
  const req = pool.request();
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v === null || v === undefined) req.input(k, sql.NVarChar, null);
      else if (typeof v === 'number') req.input(k, Number.isInteger(v) ? sql.Int : sql.Float, v);
      else if (typeof v === 'boolean') req.input(k, sql.Bit, v);
      else if (v instanceof Date) req.input(k, sql.DateTime, v);
      else req.input(k, sql.NVarChar, String(v));
    });
  }
  const result = await req.query(sqlText);
  return result.recordset || [];
}

// Return first row or null
async function queryOne(sqlText, params) {
  const rows = await query(sqlText, params);
  return rows[0] || null;
}

// Paginated query — adds ORDER BY + OFFSET/FETCH, returns { dataSource, totalRecord }
async function queryPage(sqlText, orderBy, params, pagination) {
  const page = pagination || {};
  const pageNum = parseInt(page.PageNumber) || 1;
  const pageSize = parseInt(page.PageSize) || 50;
  const offset = (pageNum - 1) * pageSize;

  // Single query with COUNT(*) OVER() — one pass instead of two
  const pageSql = `SELECT *, COUNT(*) OVER() AS _totalRecord FROM (${sqlText}) AS _src ORDER BY ${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`;
  const rows = await query(pageSql, params);
  const totalRecord = rows.length > 0 ? rows[0]._totalRecord : 0;

  // Strip the _totalRecord column from results
  const dataSource = rows.map(r => { const { _totalRecord, ...rest } = r; return rest; });
  return { dataSource, totalRecord };
}

module.exports = { connect, close, query, queryOne, queryPage, sql };
