# Mechanics reports

Athletes receive Mechanics session reports in **Profile → Reports**. Coaches send them from the Triton Mechanics Session Report Builder by selecting **Natural Ball Player**, searching the athlete, and sending a finalized report. **Neptune** recipients continue to use Triton's Compete inbox.

This repository contains:

- `api/mechanics-reports.js`: authenticated server-to-server athlete search and report delivery.
- `supabase/migrations/20261111_mechanics_reports.sql`: private `athlete_reports` storage and the server-only `receive_mechanics_report` function.
- `src/ReportsTab.js`: paginated inbox and full report view.
- `src/mechanics-report/SessionReportView.js` and `.css`: generated from Triton's report renderer. Do not edit these artifacts directly.

Apply the migration and set `NBP_MECHANICS_SECRET` on NBP and Triton to the same random secret. NBP also needs its existing `SUPABASE_SERVICE_ROLE_KEY`; Triton needs `NBP_REPORTS_URL=https://www.thenatural-app.com` and its own outbound-delivery migration. None of these secrets may use a browser-visible `REACT_APP_` or `NEXT_PUBLIC_` prefix. Deploy NBP before Triton.

Athletes can read only their own reports; NBP coaches and admins can read all athlete reports. The browser cannot create, update, or delete reports. Delivery rechecks the recipient's player role and deduplicates by session, fingerprint, and recipient. Sent reports preserve their notes, measurements, comparisons, and charts independently of later Mechanics edits.

To refresh the shared renderer from the sibling checkout:

```sh
cd ../Triton-Tools
node scripts/export-nbp-report-viewer.mjs ../NBP
```

Verification in NBP:

```sh
node --test scripts/test-mechanics-reports.cjs
CI=true npm test -- --watch=false --runInBand
npm run build
```

The complete deployment procedure and cross-project database/browser tests are documented in `Triton-Tools/docs/mechanics-nbp-integration.md`. These tests use synthetic local fixtures and never deliver a report to a live athlete.
