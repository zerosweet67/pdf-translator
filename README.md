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

## Security Notes

Never commit:

```text
worker/.dev.vars
.env
.env.local
.env.production
*.secret
```

If a real API key was ever committed to Git history, rotate it immediately.

The repository can be public because the real secrets live in Cloudflare Worker secrets, not in the frontend.

## Known Limitations

- No OCR for scanned PDFs
- Rotated pages / rotated text are not fully supported
- Three-column layouts are not fully supported
- Figure text embedded only as raster image is not translated
- Table reconstruction is heuristic
- Translation cache is in-memory only
- Access control uses one shared invite code, not individual accounts
- There is currently no per-user quota or server-side rate limit
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
