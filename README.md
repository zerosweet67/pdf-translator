# PDF Translator

Layout-preserving English → Traditional Chinese (Taiwan) academic PDF translator.

The app keeps PDF processing in the browser, sends only translatable text blocks to a Cloudflare Worker, and generates a bilingual PDF with the original page on the left and the translated page on the right.

## Features

- English → Traditional Chinese (Taiwan) academic translation
- Side-by-side bilingual PDF export
- PDF.js text extraction and layout analysis
- Two-column reading-order detection
- Sentence-aware block merging across columns/pages
- Figure captions, table labels, footnotes, supplemental material and appendices can be translated
- References remain untranslated
- Symbol/private-use Unicode normalization for common academic PDF glyphs
- Mixed-font PDF rendering with:
  - LXGW WenKai TC
  - Liberation Serif
  - Noto Sans Symbols 2
  - Noto Sans TC fallback
- Translation cache and token-cost optimizations
- Academic fidelity pipeline: automatic document terminology, protected citations / references / DOIs / URLs, numeric and citation integrity checks, second-pass QA of high-risk blocks only
- Invite-code protection with short-lived signed session tokens
- Developer tools available with `?debug=true`

## Architecture

```text
Browser / GitHub Pages
        |
        | text blocks only
        v
Cloudflare Worker
        |
        v
OpenAI API
```

The complete PDF stays in the browser. The Worker does not receive the full PDF file.

## Project Structure

```text
pdf-translator/
├─ README.md
├─ .gitignore
├─ .github/
│  └─ workflows/
│     └─ deploy-pages.yml
├─ web/
│  ├─ index.html
│  ├─ vite.config.ts
│  ├─ public/
│  │  └─ fonts/
│  └─ src/
│     ├─ main.ts
│     ├─ styles.css
│     ├─ config.ts
│     ├─ pdf/
│     └─ translate/
└─ worker/
   ├─ wrangler.toml
   └─ src/
```

## Requirements

- Node.js 20.19 or newer
- OpenAI API key
- Cloudflare account
- GitHub account

## Local Development

### 1. Cloudflare Worker

```powershell
cd worker
npm install
```

Create `worker/.dev.vars`:

```text
OPENAI_API_KEY=sk-...
INVITE_CODE=your-local-invite-code
AUTH_SECRET=your-random-secret
```

Generate a secure `AUTH_SECRET` in PowerShell:

```powershell
$b = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
[Convert]::ToBase64String($b)
```

Start the Worker:

```powershell
npm run dev
```

Default local Worker URL:

```text
http://127.0.0.1:8787
```

Health check:

```powershell
curl.exe --tlsv1.2 http://127.0.0.1:8787/health
```

Expected response:

```json
{"ok":true}
```

### 2. Frontend

```powershell
cd web
npm install
npm run dev
```

Default frontend URL:

```text
http://localhost:5173
```

The first screen asks for the invite code.

## User Flow

```text
Enter invite code
→ Select PDF
→ Read PDF
→ Analyze layout
→ Analyze terminology (one call)
→ Translate
→ Check translation quality (high-risk blocks only)
→ Generate bilingual PDF
→ Download
```

User Mode is intentionally simple. Developer controls are hidden unless the URL contains:

```text
?debug=true
```

Example:

```text
http://localhost:5173/?debug=true
```

## Translation Behavior

The translator is designed for academic documents.

Translated content includes:

- Title
- Headings
- Body paragraphs
- Footnotes
- Figure captions / notes
- Table captions / headers / text labels
- Supplemental material
- Appendices
- Questionnaires

Normally preserved without translation:

- References / bibliography entries
- DOI
- URL
- E-mail addresses
- Page numbers
- Citation-only blocks
- Numeric-only table cells
- Equation-only blocks

## Translation Quality (academic fidelity)

Only English → Traditional Chinese (Taiwan) is supported. The pipeline puts fidelity before fluency: no expansion, no summary, no added causality, hedges (*may / might / could*, *suggest / indicate*, *associated with*, *approximately*), negations (*no significant difference*, *failed to demonstrate*, *not inferior*) and every number, statistic, symbol and citation must survive unchanged. The frontend modules live in `web/src/translate/`, the prompts in `worker/src/prompt.ts`.

### Document terminology (`terminology.ts`, `POST /terminology`)

- Before translation, **one** request builds the paper's glossary from selected excerpts of the already extracted blocks (title, opening paragraphs, headings, captions, sentences that define an abbreviation such as *chronic obstructive pulmonary disease (COPD)*, the most term-dense paragraph per page), at most ~7 000 characters. Small documents are sent whole. The PDF is never sent again.
- Structured output `{ "terms": [{ "source", "target", "abbreviation" }] }`, at most 50 entries; ordinary words (patient, result, study, exercise…) and malformed entries are dropped.
- **User terminology first**: entries typed in Developer Mode (`term = 中文`, or `term (ABBR) = 中文`) override automatic ones with the same source or abbreviation.
- Each batch carries **only the entries that occur in its blocks** (term, plural, hyphen/space variant or the bare abbreviation), so a batch with only *COPD* and *inspiratory neural drive* sends two lines, never the whole glossary.
- **Abbreviations**: first full mention → 中文全名（COPD）; afterwards, and whenever the source has only the abbreviation (COPD, ILD, FEV1, FVC, mMRC, CAT, HADS, RCT…), the bare abbreviation is kept and never expanded.
- The glossary is cached in memory per document fingerprint for the page session, so a test run plus the full run, or a re-run of the same file, cost one extraction. No IndexedDB, no server storage.
- If extraction fails the document is translated without an automatic glossary (warning in Developer Mode).

### Protected entities (`protect.ts`)

`[12]`, `[3–6]`, `[3,5,8]`, `(Smith et al., 2024)`, `(Smith & Lee, 2023; Wu, 2020)`, `Smith et al. (2024)`, `Figure 2`, `Fig. 2A`, `Figures 2 and 3`, `Table S1`, `Fig. B1`, `Supplementary Figure 3`, `Appendix A`, DOIs, URLs and e-mail addresses are replaced by placeholders (`__CITE_1__`, `__REF_1__`, `__DOI_1__`, `__URL_1__`, `__EMAIL_1__`) before the request and restored afterwards. Restoration tolerates small distortions (spacing, single underscores); a placeholder that does not come back is a warning and makes the block high-risk. A text that already contains such tokens is sent unprotected. Symbols and identifiers (SpO2, PaCO2, FEV1, TRPM8, ±, ≤, ≥, μ, Greek letters) stay in the text and the prompt forbids changing them.

### Numeric / statistical integrity (`entities.ts`)

Source and translation are compared on a semantic numeric signature: the multiset of numbers (sign, decimals, `%` flag) plus `p = / < / ≤ …`, `n = …` and `mean ± sd` entities. Equivalent: `95 %` / `95%`, `p=0.03` / `p = 0.03`, `5.2±1.1` / `5.2 ± 1.1`, `10-15` / `10–15` / `10 至 15`, `1,234` / `1234`, `.05` / `0.05`, `410 million` / `4.10 億`, number words / months / roman numerals rendered as digits, small digits rendered as Chinese numerals. Anything else missing, added or changed (`0.03 → 0.3`, `n = 42 → n = 24`, `12.4% → 12.5%`, `± 1.1 → ± 1.2`, a lost sign) is a numeric warning. A lost symbol (±, ≤, ≥, °, μ, Δ, Greek) is a separate warning.

### Citation integrity

The same patterns as the protection step are compared as a multiset between source and restored translation (dash variants and spacing normalized): a citation may not disappear, change its number, author, year or figure/table number.

### Hard risk / soft risk (`risk.ts`)

Every block is assessed after translation. Only **hard-risk** blocks, those with at least one QA trigger, are QA candidates; **soft-risk** blocks (weighting signals only) are reported in Developer Mode and never sent to QA on their own. A block whose deterministic checks all pass is not sent to QA just because it is merged, hedged, cut off or long.

QA triggers, in priority order:

| # | Trigger | Condition |
| --- | --- | --- |
| 1 | `PLACEHOLDER_ERROR` | a placeholder did not come back (**critical**) |
| 2 | `NUMERIC_MISMATCH` | numbers / statistics differ (**critical**) |
| 3 | `CITATION_MISMATCH` | citations differ (**critical**) |
| 4 | `SYMBOL_MISMATCH` | ±, ≤, ≥, °, μ, Δ or a Greek letter lost |
| 5 | `NEGATION_WITH_OUTCOME` | a conclusion-changing negation (*no significant difference*, *no evidence / effect*, *did not improve*, *failed to show*, *was not associated*, *not inferior / superior*, *neither … nor*, *no longer*, *cannot*) **in the same sentence** as a number, statistic, comparison or outcome word; *not only*, *not necessarily* are ignored |
| 6 | `UNCERTAINTY_WITH_OUTCOME` | a hedge (*may, might, could, suggest, indicate, likely, possibly, plausible…*) **in the same sentence** as numeric / statistical content (*may reduce mortality by 15 %*); *this may reflect…* does not count |
| 7 | `CROSS_PAGE_INCOMPLETE` | cross-page unit whose source is cut off |
| 8 | `MERGED_INCOMPLETE_SEMANTIC` | merged unit, cut off, with a negation or hedge |
| 9 | `HIGH_RISK_SCORE` | weighted score ≥ 8 without any specific trigger |

Numbers inside citations, figure/table references, DOIs and URLs are not counted (they are removed before the numeric checks of the risk assessment).

Weighting signals (score only; the score orders blocks of the same trigger class and feeds trigger 9): critical mismatch 8, lost symbol 4, strong negation 3, weak negation (*not*, *no*, *without*, *never*) 1, hedges 1 / 2 / 3 (1, 2–3, ≥ 4) + 1 for *approximately/about + number*, dense notation 3 / 2 / 1 (≥ 8 numbers or ≥ 3 statistics / ≥ 4 numbers or a statistic / ≥ 3 parentheses), merged 1, cross-page 1, cut-off source 1, length ratio outside 0.25–2.0 (source ≥ 60 chars) 2, + 3 when that block also carries numbers, a negation or a hedge.

QA budget: after the triggers have selected the candidates, at most `DEFAULT_MAX_QA_SHARE` (5 %) of the translated blocks go to QA. **Critical mismatches (placeholder, numeric, citation) are always reviewed, even beyond the budget**; the remaining slots are filled in trigger priority order, then by score, then by reading order. Hard-risk blocks left out are reported as *skipped* in Developer Mode.

### Second-pass QA (`qa.ts`, `POST /qa`)

- Batches of at most 20 blocks / 16 000 characters (source + translation), same concurrency as translation. Each block carries only its id, source, current translation, block type (when not body text) and the QA triggers that fired; soft signals, entity details that passed the deterministic checks, section context and layout data are not sent. The glossary is filtered to the entries that occur in the batch.
- The reviewer prompt is short (≈ 1 000 characters) and checks **only** meaning distortion, missing / added negation, altered uncertainty, numeric / statistical changes, citation changes, terminology inconsistency, missing or added content; it must not rewrite for style and returns `ok: true` when uncertain. Strict JSON: `{ "ok": true, "translation": null, "issues": [] }` or `{ "ok": false, "translation": "修正版", "issues": ["NUMERIC_MISMATCH", …] }` (codes: NUMERIC_MISMATCH, CITATION_MISMATCH, NEGATION_ERROR, UNCERTAINTY_ERROR, TERMINOLOGY_INCONSISTENCY, MISSING_CONTENT, ADDED_CONTENT, MEANING_DISTORTION, PLACEHOLDER_ERROR).
- A translation is replaced **only** when `ok` is false and the correction passes a sanity check (non-empty, still Chinese, no new numeric error); the corrected text also replaces the cache entry. Each block is reviewed at most once and corrected at most once: there is no translate → QA → translate loop.
- Ids missing from a reply are re-sent once on their own (the Worker also retries missing ids once); a block whose review never arrives, or a failed QA request, keeps its first-round translation. QA can never fail the document.

### Cache key

`targetLanguage + hash of the block's relevant terminology + whitespace-normalized text`. The same sentence under a different glossary is translated again; the full glossary is never part of the key.

### Developer Mode

`?debug=true` shows, after a run: **Terminology** (auto / user counts, every `source → target (ABBR) [origin]`), **Quality Assurance** (hard-risk / soft-risk counts, QA checked, QA corrected, correction rate, a *QA avoided* block with *soft-risk skipped by policy*, *hard-risk checked*, *critical mismatch forced QA* and *budget-skipped hard-risk*, the numeric / citation / placeholder warnings and the per-block list with level, score, triggers, signals, verdict and issue codes) and, in the cost panel, a **cost breakdown** (first-pass / terminology / QA / total: requests, input, output, total tokens) plus **QA efficiency** (QA checked, QA corrected, correction rate). Each block card carries a `hard-risk … [triggers] · QA ok / corrected / failed / skipped` or `soft-risk …` tag. User Mode only shows the stages 分析專業術語 → 翻譯 → 檢查翻譯品質 → 產生對照 PDF.

### Cost impact (50-page single-column accounting paper, 237 blocks, real API, same model / glossary strategy)

| | baseline (no quality pipeline) | A: QA off | B: previous policy, QA share 10 % | C: trigger policy, 5 % cap (current) |
| --- | --- | --- | --- | --- |
| terminology requests · tokens | – | 1 · 1 985 in / 861 out | 1 · 1 985 / 855 | 1 · 1 985 / 887 |
| translation requests · tokens | 12 · 29 754 in / 28 442 out | 12 · 35 965 / 30 235 | 12 · 35 922 / 30 328 | 12 · 35 939 / 31 041 |
| QA requests · blocks · corrected · tokens | – | – | 2 · 24 (10 %) · 3 · 11 135 / 1 698 | 1 · 12 (5 %) · 4 · 5 451 / 2 088 |
| risk classes | – | 79 high-risk (old scoring) | 79 high-risk, 55 over budget | 48 hard / 163 soft, 2 critical forced, 36 budget-skipped |
| total tokens | 58 196 | 69 046 (+19 %) | 81 923 (+41 %) | 77 391 (+33 %) |
| price-weighted ($2 / $12 per 1M in / out) | $0.401 | $0.449 (+12 %) | $0.493 (+23 %) | $0.495 (+23 %) |
| translation + QA time | 85 s | 97 s | 110 s (95 + 14) | 118 s (96 + 22) |
| total time (upload → PDF) | 88.8 s | 109 s | 120 s | 129 s |

A, B and C ran back to back in one session; the baseline numbers come from the earlier run before the quality pipeline (API latency was lower that day: A, with no QA at all, already takes 97 s of translation). Compared with B, the trigger policy sends half the blocks to QA, cuts QA tokens by 41 % and still corrected four blocks: two were forced by a numeric mismatch (an invented section reference; a dropped table header), one removed a duplicated fragment, one was a wording fix. Replaying the policy over B's own first-round output keeps two of its three corrections (the third was a merged-only block, now soft risk). The remaining growth over the baseline is the first pass (+15 %: fidelity prompt, glossary lines, placeholders) and terminology (+5 %); QA is +13 % of the baseline.

QA batch size was benchmarked on B's 24 review blocks (24 100 chars): 20 blocks / 16 000 chars → 2 requests, 14 316 tokens, 38.6 s; 15 blocks / 12 000 chars → 3 requests, 15 680 tokens, 46.9 s. The larger batch stays.

## PDF Export

Default export mode:

```text
Original page | Traditional Chinese page
```

Output filename:

```text
<name>_bilingual_zh-TW.pdf
```

Developer Mode can also generate a translated-only PDF.

### Tables (`web/src/pdf/table.ts`)

Text inside a detected table (caption → `TABLE` blocks, `classify.ts`) is not
treated as paragraphs. Its raw text items are regrouped into logical cells:

```text
text items → baseline rows → fragments (wide gaps) → column bands
           → wrapped lines merged per cell → one translation unit per cell
```

- Column bands come from the x-projection of the data rows only, so a
  spanning header ("Bedbound (n = 590)") never merges two data columns.
- Wrapped lines join one cell only when they leave data columns empty and
  continue the text (lowercase / "(" start, trailing comma, hanging indent),
  never across a table rule.
- Superscript footnote markers ("Medicaid^d") stay with their cell, are kept
  out of the translated text and are drawn back after the translation.
- Numeric cells (`isNumericTableCell`: numbers, %, ±, ranges, p-values,
  n =, "—", NA …) are never sent to the API.
- Each cell gets a usable rectangle inside its row / column band, 1 pt clear
  of every ruling line (`extract.ts` collects rules and fills from the
  operator list). Masks are the union of the cell's source lines clipped to
  that rectangle, in the cell's background colour, so borders and shading
  survive.
- Table-only fitting (`fitTextToTableCell`): wrap → line height 1.15 → 1.08 ×
  font size → font −0.25 pt steps down to 5 pt. No downward extension. A cell
  that still does not fit keeps its English text and is listed as
  `TABLE_CELL_OVERFLOW` in Developer Mode → Table Diagnostics.
- Cell units are sent with `type: "TABLE_CELL"` (short guidance in the
  Worker prompt); batching, cache and QA are unchanged.
- A table whose cells cannot be resolved (no column structure) keeps its
  blocks in English instead of overlaying them.

Benchmark harness (no API calls): `TABLE_BENCH_PDF=<file> TABLE_BENCH_OUT=<dir>
TABLE_BENCH_PAGES=6,7 npx vitest run src/pdf/__tests__/table.bench.test.ts`
writes before / after / debug PDFs and `metrics.json`.

## Translation Cost Optimizations

The frontend minimizes unnecessary API usage by:

- Sending ordinary blocks as only `{ id, text }`
- Adding context only for incomplete / merged / cross-page blocks
- Removing duplicated context already present in the same batch
- Skipping numeric-only, DOI-only, URL-only and reference blocks
- Reusing in-session translation cache
- Retrying only missing block IDs when possible
- Filtering terminology so only relevant entries are sent (per block for the cache key, per batch for the request)
- Sending the block type only for non-body blocks (TITLE / HEADING / CAPTION / FOOTNOTE / TABLE)
- Reviewing only hard-risk blocks in the QA pass (deterministic mismatches, negation / uncertainty next to numbers or outcomes), capped at 5 % of the translated blocks except for critical mismatches
- Keeping PDF generation completely separate from translation calls

## Authentication

The app uses one shared invite code for test users.

### Secrets

These must exist only in the Cloudflare Worker environment:

```text
OPENAI_API_KEY
INVITE_CODE
AUTH_SECRET
```

They must never be placed in frontend `VITE_*` variables.

Authentication flow:

```text
POST /auth/verify
→ verify invite code
→ issue signed 24-hour session token
→ store token in sessionStorage
→ send Authorization: Bearer <token> to /translate
```

`/translate`, `/terminology` and `/qa` verify the token before calling OpenAI.

Worker routes (any other method answers `405` with an `Allow` header):

```text
GET  /health        → { "ok": true }            public liveness, nothing else
GET  /auth/check    → session status + provider/model (needs a token)
POST /auth/verify   → invite code → session token
POST /translate     → text blocks → translations                       (needs a token)
POST /terminology   → text excerpts → document glossary (one per PDF)   (needs a token)
POST /qa            → source + translation of high-risk blocks → verdicts (needs a token)
```

The three provider routes share one pipeline (auth → body cap → validation → the same per-session rate limits, character budget and concurrency lease → provider), so a QA or terminology request counts against the same limits as a translation request.

## Production Deployment

### Cloudflare Worker

Current Worker URL:

```text
https://pdf-translator-worker.pdf-translator.workers.dev
```

Set production secrets:

```powershell
cd worker

npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put INVITE_CODE
npx wrangler secret put AUTH_SECRET
```

Deploy:

```powershell
npx wrangler deploy
```

The first deploy after the rate-limiting change also runs the Durable Object migration declared in `wrangler.toml` (`[[migrations]] tag = "v1"`, class `RateLimiterDO`, SQLite-backed so it works on the free plan). No KV namespace or other resource has to be created by hand; the deploy output should list `env.RATE_LIMITER (RateLimiterDO)` under bindings.

Test:

```powershell
curl.exe -v --tlsv1.2 https://pdf-translator-worker.pdf-translator.workers.dev/health
```

Expected:

```json
{"ok":true}
```

### Cloudflare CORS

`worker/wrangler.toml` should allow local development and the GitHub Pages origin.

For this repository, the production GitHub origin is:

```text
https://zerosweet67.github.io
```

Important: CORS origins do not include the repository path.

### GitHub Pages

Repository:

```text
https://github.com/zerosweet67/pdf-translator
```

Because GitHub Pages on a free GitHub account requires a public repository, make sure the repository visibility is **Public**.

Then:

1. GitHub → repository → **Settings**
2. **Secrets and variables** → **Actions**
3. Under **Variables**, create:

```text
VITE_WORKER_URL
```

Value:

```text
https://pdf-translator-worker.pdf-translator.workers.dev
```

4. Go to **Settings → Pages**
5. Under **Build and deployment**, select **GitHub Actions**
6. Push to `main`
7. The workflow in `.github/workflows/deploy-pages.yml` builds and deploys `web/dist`

Expected project site:

```text
https://zerosweet67.github.io/pdf-translator/
```

## Build / Test Commands

Frontend:

```powershell
cd web
npm test
npm run typecheck
npm run build
```

Worker:

```powershell
cd worker
npm test
npm run typecheck
npm run build
```

## Security

The Worker is the only component that holds secrets and the only one that can spend OpenAI credit, so all hardening lives there. Nothing below changes the translation pipeline.

- **Secrets** (`OPENAI_API_KEY`, `INVITE_CODE`, `AUTH_SECRET`) exist only as Cloudflare Worker secrets. The frontend bundle contains just the public Worker URL.
- **Invite code check** is a constant-time comparison of SHA-256 digests; the response for a wrong code is `401 { "ok": false }` with no hint.
- **Session tokens** are `base64url(payload).base64url(HMAC-SHA256(AUTH_SECRET, payload))`, valid for `TOKEN_TTL_SECONDS` (24 h, `worker/src/config.ts`). Verification checks format, signature length, HMAC, `v == 1`, integer `iat`/`exp`, a base64url `sid`, `exp > now`, `iat` not in the future and a lifetime of at most the TTL. Every failure is the same `401 { "error": "UNAUTHORIZED" }`.
- **Browser storage**: the token lives in `sessionStorage` only (closing the tab ends the session) and is never put in a URL, the DOM, analytics or the Developer Mode panel.
- **CORS**: an explicit origin allowlist (`ALLOWED_ORIGINS` in `wrangler.toml`), never `*`. Requests and preflights from any other origin get `403`. Allowed methods `GET, POST, OPTIONS`, allowed headers `Content-Type, Authorization`.
- **Strict input**: `POST` routes require `Content-Type: application/json` (`415` otherwise). Bodies are capped (`4 KB` for `/auth/verify`, `512 KB` for `/translate`, checked on `Content-Length` and again while reading → `413`). `/translate` also enforces at most 50 blocks, 6 000 characters per block, 40 000 characters per request, 600-character contexts, an upper-case block `type` and 200 terminology entries. `/terminology` (`128 KB`) accepts at most 40 excerpts of 2 000 characters, 16 000 in total; `/qa` (`512 KB`) at most 20 blocks, 6 000 characters per source / translation, 60 000 in total and 12 upper-case warning codes per block.
- **Security headers** on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cache-Control: no-store`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- **Request ids**: every response carries `X-Request-ID`; the frontend prints it to the browser console on failures so a problem can be matched with the Worker log without exposing anything else.
- **Safe errors**: users see one of a handful of generic messages (login expired / too many attempts / too many requests / file too large / service problem). Provider errors and stack traces stay in the Worker log.
- **Logging**: security events are one-line `[Security] event=… route=… status=… requestId=… ipHash=…` entries. The IP appears only as a truncated keyed hash; tokens, the `Authorization` header, the invite code, secrets and translation text are never logged.

### Rate Limiting

Counters live in a Durable Object (`RATE_LIMITER` binding, class `RateLimiterDO`, one tiny object per key). A Durable Object handles requests one at a time, so "check, then count" is atomic and global, which Workers KV (eventually consistent, no atomic increment, one write per second per key) and in-memory maps (one per Worker instance) cannot provide. Only counters, window timestamps and random lease ids are stored; nothing about the PDF, the translation, the token or the invite code.

| Limit | Key | Rule | Response |
| --- | --- | --- | --- |
| Invite attempts | `auth:<HMAC(ip)>` | 5 attempts / 60 s per `CF-Connecting-IP` | `429 { "error": "TOO_MANY_ATTEMPTS" }` |
| Translate requests | `session:<sid>` | 20 requests / 60 s | `429 { "error": "RATE_LIMITED" }` |
| Translate volume | `session:<sid>` | 250 000 source characters / 5 min | `429 { "error": "RATE_LIMITED" }` |
| Concurrency | `session:<sid>` | at most 4 in-flight `/translate` requests (lease expires after 5 min if never released) | `429 { "error": "TOO_MANY_CONCURRENT_REQUESTS" }` |

All windows are fixed windows; every `429` carries `Retry-After` and the frontend waits for it before retrying a batch. The frontend sends 3 batches in parallel and a typical PDF is 12–20 batches, so normal use stays under the limits. The numbers are in `worker/src/config.ts`.

If the Durable Object cannot be reached, the Worker answers `503` rather than skipping the check. Without the binding (e.g. a misconfigured dev setup) it falls back to per-instance in-memory counters and logs `RATE_LIMIT_FALLBACK_MEMORY`; that fallback is not a production safeguard.

### Secret Rotation

If a session token may have leaked, rotate `AUTH_SECRET`; every issued token becomes invalid at once and users just re-enter the invite code:

```powershell
cd worker
npx wrangler secret put AUTH_SECRET
npx wrangler deploy
```

If the invite code leaked, rotate `INVITE_CODE` the same way. Note that changing `INVITE_CODE` does **not** invalidate sessions that were already issued (they stay valid until they expire, at most 24 h); rotate `AUTH_SECRET` as well if that matters.

If `OPENAI_API_KEY` leaked, revoke it in the OpenAI dashboard first, then `npx wrangler secret put OPENAI_API_KEY`.

If a real secret was ever committed, deleting it from the latest version is not enough. Rotate the secret immediately. Git history keeps every past version, and this project deliberately does not rewrite history.

Never commit:

```text
worker/.dev.vars
.env
.env.local
.env.production
*.secret
```

The repository can be public because the real secrets live in Cloudflare Worker secrets, not in the frontend.

### Production Security Checklist

- [ ] Worker secrets set: `OPENAI_API_KEY`, `INVITE_CODE`, `AUTH_SECRET` (`npx wrangler secret list` shows the names only)
- [ ] `AUTH_SECRET` is at least 32 random characters (generator in *Local Development*)
- [ ] Invite code is long and random (a passphrase or 20+ random characters), not a word
- [ ] Repository contains no secrets: `git grep -nE "sk-[A-Za-z0-9]{8}|AUTH_SECRET=|INVITE_CODE=|OPENAI_API_KEY="` shows only placeholders
- [ ] `ALLOWED_ORIGINS` in `worker/wrangler.toml` lists the real GitHub Pages origin (`https://<user>.github.io`, no path) and no wildcard
- [ ] Rate-limit storage bound: `npx wrangler deploy` prints `env.RATE_LIMITER (RateLimiterDO)  Durable Object`
- [ ] OpenAI usage limits configured in the OpenAI dashboard (monthly budget + alert)
- [ ] `401` behaviour verified: `/translate` without a token answers `{ "error": "UNAUTHORIZED" }`
- [ ] `429` behaviour verified: the 6th wrong invite code within a minute answers `TOO_MANY_ATTEMPTS`
- [ ] `GET /health` answers only `{ "ok": true }`

Quick production check from PowerShell (replace the URL):

```powershell
$w = "https://pdf-translator-worker.pdf-translator.workers.dev"
curl.exe -s $w/health
curl.exe -s -X POST $w/translate -H "Content-Type: application/json" -d "{}"
1..6 | ForEach-Object { curl.exe -s -o NUL -w "%{http_code} " -X POST $w/auth/verify -H "Content-Type: application/json" -d '{"code":"wrong"}' }
```

Expected: `{"ok":true}`, `{"error":"UNAUTHORIZED"}`, then `401 401 401 401 401 429`.

## Known Limitations

- No OCR for scanned PDFs
- Rotated pages / rotated text are not fully supported
- Three-column layouts are not fully supported
- Figure text embedded only as raster image is not translated
- Table reconstruction is heuristic: tables need a "Table N" caption; a wrapped header line that starts with a capital letter and has no continuation signal stays a separate cell; a translation that does not fit a cell even at 5 pt is left in English; a caption's translation may still grow downward over the first table rule (general block fitting)
- Translation cache and the automatic glossary are in-memory only (per page session)
- Numeric and citation checks are heuristic: a value the translator legitimately rewrites (e.g. "12 percent" → "百分之十二" in words) is reported as a warning and reviewed, and a wrong value that keeps the same digits (e.g. a swapped pair of identical numbers) is not detected
- Only hard-risk blocks are reviewed and the QA share is capped at 5 % of the blocks (critical mismatches excepted), so a paper with many negated or hedged findings leaves some hard-risk blocks unreviewed (listed as "skipped" in Developer Mode); soft-risk blocks (merged, cross-page, cut off, hedged or long without a trigger) are never reviewed
- Figure / table references are kept in English ("Figure 2"), never rendered as 圖 2
- Access control uses one shared invite code, not individual accounts
- Rate limits are per invite-code session and per source IP, not per person; users behind one shared IP share the 5-attempts-per-minute invite limit
- Original English may remain searchable under white overlay masks in the generated PDF

## Fonts

The project uses open-source fonts only:

- LXGW WenKai TC
- Liberation Serif
- Noto Sans Symbols 2
- Noto Sans TC

These fonts are stored under:

```text
web/public/fonts/
```

## License

Add your preferred project license here before wider public distribution.
