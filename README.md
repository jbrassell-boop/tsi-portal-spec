# TSI Portal — Contracts Screen Spec

Standalone mockup and spec for the **Contracts** section of the BrightLogix TSI Sales Rep Portal.

## What's here

| File | Purpose |
|------|---------|
| `portal-contracts.html` | Full visual mockup wired to live SQL |
| `server/routes/portal.js` | Express API routes (`/api/portal/contracts`, `/api/portal/contracts/:key/detail`) |
| `server/db.js` | SQL Server connection helper |
| `tasks/spec-portal-contracts.md` | Full implementation spec for BrightLogix |

## Running locally

```bash
npm install
npm run server        # API on :4000
npx serve -l 3000 .  # Static files on :3000
```

Open: http://localhost:3000/portal-contracts.html

## Environment variables (cloud/Azure)

| Variable | Value |
|----------|-------|
| `DB_SERVER` | Azure SQL server hostname |
| `DB_NAME` | Database name |
| `DB_USER` | SQL login username |
| `DB_PASSWORD` | SQL login password |
| `PORT` | App port (default 4000) |
