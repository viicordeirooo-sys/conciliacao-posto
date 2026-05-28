# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A card-payment **reconciliation tool for a Brazilian gas station ("posto")**. It tracks card/Pix sales, computes acquirer fees (MDR) and expected deposit dates, then reconciles those against actual bank deposits. UI and domain terms are in pt-BR.

The **entire application is `index.html`** — one ~1800-line file containing HTML, CSS, and vanilla-JS logic. There is no build step, no framework, no package manager, no tests, and no dependencies installed in the repo. Third-party libraries (Firebase, PDF.js, SheetJS) are loaded from CDNs at runtime.

## Running / developing

There are no npm/build/lint/test commands. To run, serve the file over HTTP (not `file://` — the Firebase ES-module imports and Auth require an http(s) origin):

```powershell
python -m http.server 8000   # then open http://localhost:8000
# or: npx serve
```

`localhost` is an authorized Auth domain by default. Logging in requires an existing Firebase user (email/password) — see the setup comment block near the top of the `<script type="module">`: Email/Password sign-in must be enabled and a user created. Firestore rules are versioned in `firestore.rules` (with `firebase.json` and `.firebaserc`) — restrict access to the `conciliacao` collection for authenticated users, default-deny otherwise. Publish them with `firebase deploy --only firestore:rules`.

To deploy, host `index.html` as a static file on any HTTPS host (the Firebase config is embedded and public by design for client SDKs).

## Architecture

**Single source of truth:** the module-level `STATE = {sales, bank, mdr, config}` object. All tabs render from it; all mutations go through it then call `saveToFirebase()`.

**Persistence model:** one Firestore document, `conciliacao/posto1` (`DOC_ID = "posto1"`). The whole `STATE` is persisted to that single doc. This means the app is effectively **single-tenant / single-shared-account** — every authenticated user reads and writes the same document.
- `saveToFirebase()` debounces 800ms; `flushSave()` then runs a `runTransaction` (read-modify-write) instead of overwriting the doc. `mergeListById` does a 3-way merge per id: starts from the remote list, removes ids deleted locally (tracked via `_baselineSaleIds`), then applies local adds/edits — preventing lost-update between users. `mdr`/`config` follow last-writer-wins. `setSyncStatus` reports saving/saved/warn/error states with `retrySave()`, and the save warns when the doc nears the Firestore 1 MB limit (`docSizeBytes`).
- `onSnapshot` gives real-time sync; it ignores its own pending writes (`metadata.hasPendingWrites`) to avoid clobbering local edits, and re-renders the current tab on remote changes.
- `loadFromFirebase` / snapshot merge incoming `mdr` and `config` over the `DEFAULT_*` constants, so new default keys survive old saved docs.

**Rendering pattern (important):** no virtual DOM. Each tab is a `render<Tab>()` function that builds an HTML string and assigns it to `#tab-<name>.innerHTML`. Event handlers are inline `onclick=`/`oninput=` attributes calling functions attached to `window.*`. Consequences to respect when editing:
- Any function referenced from markup **must** be assigned to `window` (e.g. `window.addSale = ...`).
- Re-rendering replaces the DOM, so transient input state is held in module-level form objects (`vForm`, `eForm`) and filter vars (`filterStatus`, `filterMonth`, `resumoMonth`, `mdrBandeira`), not in the DOM.
- All user/data-derived text interpolated into HTML **must** go through `escHtml()` (XSS prevention is manual here).

**The five tabs:** `conciliacao` (reconciliation table + status stats), `vendas` (enter/import sales), `extrato` (enter/import bank credits), `resumo` (per-month totals by card brand), `config` (posto name, tolerance, liquidation terms, MDR rates, holidays, export/import).

The `config` tab also has an **"Exportar Backup (.json)"** button (`exportBackupJSON`): it reads the `conciliacao/posto1` doc straight from Firestore (`getDoc`, **read-only — never mutates data**), serializes it (`backupSerialize`) and downloads a timestamped `conciliacao-posto-backup-<YYYY-MM-DD...>.json` for weekly off-site backup, reporting the sales+bank record counts.

### Domain logic (the core, lines ~310–482)

- **MDR** = acquirer fee. `STATE.mdr[bandeira][modality]` is a percentage; `getMDR()` divides by 100. `enrichSale()` derives `custoMDR` and `liquido` (net) from gross `amount`.
- **Expected deposit date** is **frozen at entry**: `addSale`/PDF-import store `expectedDate = calcDeposit(date, modality)` on the record. `enrichSale()` then **prefers the stored `expectedDate`** (preserved across export round-trips) and only falls back to `calcDeposit` for legacy records lacking the field — so changing the liquidation config or "today" does not silently move past deposit dates. `calcDeposit(date, modality)` uses per-modality terms in `STATE.config`: `liquidation[modality]` (number of days) and `corridos[modality]` (true = calendar days via `addCalendarDays`, false = business days via `addBusinessDays`, which skips weekends and `config.holidays`). The **"Recalcular datas"** button (`recalcExpectedDates`) re-freezes all sales' `expectedDate` with the current config (confirmation required; may change reconciliation status).
- **Reconciliation** = `getReconciliation()`: groups enriched sales by `expectedDate`, sums bank credits by date, and assigns a status per group:
  - `conciliado` (bank matches expected within `config.tolerance` R$), `divergencia` (bank present but outside tolerance), `atrasado` (no bank credit and ≥2 days past), `em_aberto` (no credit, 0–1 days past), `a_vencer` (date in future).
  - `sem_venda` (a bank credit exists on a date with **no matching sales group** — money came in on a date with no expected sale). Emitted in a second pass over `bankByDate` for dates not covered by any sales group; surfaces its own stat-card, filter option, badge and alert.

### Importers (heuristic, fragile by nature)

- **PDF (PagBank sales report):** `importPDF` → `parsePagBankPDF`. PDF.js extracts text items tagged with a global index `[n]`; the parser finds gross values and infers the fee/net by **fixed index offsets** (`idx+2`, `idx+4`) and locates date/type in nearby index windows. There's also a **"Debug PDF"** button (`runDebugPDF`) that dumps the raw indexed text of the first 2 pages — use it when a statement layout changes and offsets break.
- **XLSX (PagBank bank statement):** `importXLSX` → `mapXlsxColumns` + `parseXlsxBankRows`. The header row is detected dynamically (scans up to 50 rows for a row containing "data" plus a value column — `entradas`/`credito`/`valor`, in that priority) and columns are mapped **by normalized name**, not fixed index — the PagBank layout varies in metadata rows / column positions. Data rows parse a `dd/mm/yyyy` string or an Excel serial date, skip "saldo" rows, and use `parseBRLNumber`.
- Both **dedupe** on a synthetic `extId` so re-importing the same file is safe.

### Security features (already implemented)

CSP header in `<head>`; client-side login rate limiting (`MAX_LOGIN_ATTEMPTS`, `LOCKOUT_MS`, stored in `localStorage`); 30-min idle session timeout (`SESSION_TIMEOUT_MS`) reset on user activity; import-size caps; and a typed-confirmation modal — destructive actions (`deleteSale`, `clearSales`, `deleteBank`, `clearBank`) route through `confirmarLimpar()`, which requires the user to type `LIMPAR`.

## Conventions

- Code, comments, UI, and commit messages are in **Portuguese**. Match this.
- Money via `fmtBRL`, dates stored as `YYYY-MM-DD` and shown via `fmtDate` (dd/mm/yyyy). Stable record ids from `uid()`.
- The card brands (`BANDEIRAS`), payment modalities (`MODALITIES`), default fees (`DEFAULT_MDR`), and Brazilian national holidays (`DEFAULT_HOLIDAYS`, 2025–2026) are hardcoded constants — extend these rather than introducing parallel lists.
