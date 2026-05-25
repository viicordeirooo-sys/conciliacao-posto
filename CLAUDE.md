# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A card-payment **reconciliation tool for a Brazilian gas station ("posto")**. It tracks card/Pix sales, computes acquirer fees (MDR) and expected deposit dates, then reconciles those against actual bank deposits. UI and domain terms are in pt-BR.

The **entire application is `index.html`** — one ~1450-line file containing HTML, CSS, and vanilla-JS logic. There is no build step, no framework, no package manager, no tests, and no dependencies installed in the repo. Third-party libraries (Firebase, PDF.js, SheetJS) are loaded from CDNs at runtime.

## Running / developing

There are no npm/build/lint/test commands. To run, serve the file over HTTP (not `file://` — the Firebase ES-module imports and Auth require an http(s) origin):

```powershell
python -m http.server 8000   # then open http://localhost:8000
# or: npx serve
```

`localhost` is an authorized Auth domain by default. Logging in requires an existing Firebase user (email/password) — see the setup comment block near the top of the `<script type="module">` (around line 296): Email/Password sign-in must be enabled, a user created, and Firestore rules set to `allow read, write: if request.auth != null`.

To deploy, host `index.html` as a static file on any HTTPS host (the Firebase config is embedded and public by design for client SDKs).

## Architecture

**Single source of truth:** the module-level `STATE = {sales, bank, mdr, config}` object. All tabs render from it; all mutations go through it then call `saveToFirebase()`.

**Persistence model:** one Firestore document, `conciliacao/posto1` (`DOC_ID = "posto1"`). The whole `STATE` is written to that single doc. This means the app is effectively **single-tenant / single-shared-account** — every authenticated user reads and writes the same document.
- `saveToFirebase()` debounces writes 800ms.
- `onSnapshot` gives real-time sync; it ignores its own pending writes (`metadata.hasPendingWrites`) to avoid clobbering local edits, and re-renders the current tab on remote changes.
- `loadFromFirebase` / snapshot merge incoming `mdr` and `config` over the `DEFAULT_*` constants, so new default keys survive old saved docs.

**Rendering pattern (important):** no virtual DOM. Each tab is a `render<Tab>()` function that builds an HTML string and assigns it to `#tab-<name>.innerHTML`. Event handlers are inline `onclick=`/`oninput=` attributes calling functions attached to `window.*`. Consequences to respect when editing:
- Any function referenced from markup **must** be assigned to `window` (e.g. `window.addSale = ...`).
- Re-rendering replaces the DOM, so transient input state is held in module-level form objects (`vForm`, `eForm`) and filter vars (`filterStatus`, `filterMonth`, `resumoMonth`, `mdrBandeira`), not in the DOM.
- All user/data-derived text interpolated into HTML **must** go through `escHtml()` (XSS prevention is manual here).

**The five tabs:** `conciliacao` (reconciliation table + status stats), `vendas` (enter/import sales), `extrato` (enter/import bank credits), `resumo` (per-month totals by card brand), `config` (posto name, tolerance, liquidation terms, MDR rates, holidays, export/import).

### Domain logic (the core, lines ~310–482)

- **MDR** = acquirer fee. `STATE.mdr[bandeira][modality]` is a percentage; `getMDR()` divides by 100. `enrichSale()` derives `custoMDR` and `liquido` (net) from gross `amount`.
- **Expected deposit date** = `calcDeposit(date, modality)` using per-modality liquidation terms in `STATE.config`: `liquidation[modality]` (number of days) and `corridos[modality]` (true = calendar days via `addCalendarDays`, false = business days via `addBusinessDays`, which skips weekends and `config.holidays`).
- **Reconciliation** = `getReconciliation()`: groups enriched sales by `expectedDate`, sums bank credits by date, and assigns a status per group:
  - `conciliado` (bank matches expected within `config.tolerance` R$), `divergencia` (bank present but outside tolerance), `atrasado` (no bank credit and ≥2 days past), `em_aberto` (no credit, 0–1 days past), `a_vencer` (date in future).

### Importers (heuristic, fragile by nature)

- **PDF (PagBank sales report):** `importPDF` → `parsePagBankPDF`. PDF.js extracts text items tagged with a global index `[n]`; the parser finds gross values and infers the fee/net by **fixed index offsets** (`idx+2`, `idx+4`) and locates date/type in nearby index windows. There's also a **"Debug PDF"** button (`runDebugPDF`) that dumps the raw indexed text of the first 2 pages — use it when a statement layout changes and offsets break.
- **XLSX (PagBank bank statement):** `importXLSX` assumes a fixed layout — header at row index 8, data from row 9, columns `0=Data, 2=Tipo, 4=Descrição, 5=Entradas`.
- Both **dedupe** on a synthetic `extId` so re-importing the same file is safe.

### Security features (already implemented)

CSP header in `<head>`; client-side login rate limiting (`MAX_LOGIN_ATTEMPTS`, `LOCKOUT_MS`, stored in `localStorage`); 30-min idle session timeout (`SESSION_TIMEOUT_MS`) reset on user activity; import-size caps; and a typed-confirmation modal — destructive actions (`deleteSale`, `clearSales`, `deleteBank`, `clearBank`) route through `confirmarLimpar()`, which requires the user to type `LIMPAR`.

## Conventions

- Code, comments, UI, and commit messages are in **Portuguese**. Match this.
- Money via `fmtBRL`, dates stored as `YYYY-MM-DD` and shown via `fmtDate` (dd/mm/yyyy). Stable record ids from `uid()`.
- The card brands (`BANDEIRAS`), payment modalities (`MODALITIES`), default fees (`DEFAULT_MDR`), and Brazilian national holidays (`DEFAULT_HOLIDAYS`, 2025–2026) are hardcoded constants — extend these rather than introducing parallel lists.
