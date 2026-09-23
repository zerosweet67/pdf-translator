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
→ Translate
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

## Translation Cost Optimizations

The frontend minimizes unnecessary API usage by:

- Sending ordinary blocks as only `{ id, text }`
- Adding context only for incomplete / merged / cross-page blocks
- Removing duplicated context already present in the same batch
- Skipping numeric-only, DOI-only, URL-only and reference blocks
- Reusing in-session translation cache
- Retrying only missing block IDs when possible
- Filtering terminology so only relevant entries are sent
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

`/translate` verifies the token before calling OpenAI.

Worker routes (any other method answers `405` with an `Allow` header):

```text
GET  /health        → { "ok": true }            public liveness, nothing else
GET  /auth/check    → session status + provider/model (needs a token)
POST /auth/verify   → invite code → session token
POST /translate     → text blocks → translations   (needs a token)
```

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
- **Strict input**: `POST` routes require `Content-Type: application/json` (`415` otherwise). Bodies are capped (`4 KB` for `/auth/verify`, `512 KB` for `/translate`, checked on `Content-Length` and again while reading → `413`). `/translate` also enforces at most 50 blocks, 6 000 characters per block, 40 000 characters per request, 600-character contexts and 200 terminology entries.
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
- Table reconstruction is heuristic
- Translation cache is in-memory only
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
