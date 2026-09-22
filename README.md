# PDF Translator

Layout-preserving English → Traditional Chinese (Taiwan) PDF translation, with all PDF processing in the browser and a tiny Cloudflare Worker as the only backend.

**Current status: layout analysis + sentence-aware translation units + translation test mode (OpenAI) + pdf-lib overlay prototype. Default UI is a one-step User Mode; all developer tools are behind `?debug=true`.**
The app selects a PDF, extracts text with PDF.js, groups it into paragraph blocks with column detection, repairs hyphenation, merges sentences cut by column or page breaks, sends each unit with surrounding context to the Worker, lets you translate a hand-picked sample (or just the Abstract) before unlocking the whole document, and finally writes the Chinese back into the PDF (white line masks + embedded LXGW WenKai TC / Liberation Serif), either as a side-by-side bilingual document (`<name>_bilingual_zh-TW.pdf`, every page = original page | translated page) or as a translated-only document (`<name>_zh-TW.pdf`). A debug mode draws bounding boxes instead, to verify coordinates first.

```
pdf-translator/
├── README.md
├── .gitignore                  # secrets (.dev.vars, .env*, *.secret), node_modules, dist
├── .github/workflows/
│   └── deploy-pages.yml        # push to main → test, typecheck, build web/ → GitHub Pages
├── web/                        # Vite + TypeScript frontend (static, GitHub Pages ready)
│   ├── index.html
│   ├── vite.config.ts          # base path (BASE_PATH env, set by the Pages workflow)
│   ├── .env.development        # VITE_WORKER_URL=http://127.0.0.1:8787 (npm run dev)
│   ├── .env.example            # VITE_WORKER_URL for production (public URL only)
│   ├── public/fonts/           # committed, deployed: LXGWWenKaiTC-Regular.ttf, LiberationSerif-Regular.ttf,
│   │                           #   NotoSansSymbols2-Regular.ttf, NotoSansTC-Regular.ttf (fallback) + licenses (all SIL OFL 1.1)
│   ├── scripts/build-font.py   # how the two CJK font files were produced (fontTools)
│   └── src/
│       ├── main.ts             # UI: User Mode auto pipeline; ?debug=true: analyze, test mode, full translation, PDF export, debug
│       ├── styles.css
│       ├── pdf/
│       │   ├── extract.ts      # PDF.js worker setup + raw text items + image bounding boxes
│       │   ├── layout.ts       # items → lines → columns → blocks → reading order
│       │   ├── classify.ts     # TITLE / BODY / ..., sections (references, supplemental, figures, tables) + do-not-translate rules
│       │   ├── symbols.ts      # Symbol-font private-use code points → Unicode (U+F05B → "[", U+F044 → Δ ...)
│       │   ├── text.ts         # hyphenation repair, sentence completeness, context snippets
│       │   ├── merge.ts        # blocks → translation units (cross-column / cross-page merging)
│       │   ├── fit.ts          # CJK tokenizer, line wrapping (禁則), text fitting
│       │   ├── font.ts         # font set (LXGW WenKai TC / Liberation Serif / Noto fallback), mixed-font runs + widths
│       │   ├── render.ts       # overlay eligibility, line masks, text placement, debug boxes, pdf-lib save
│       │   ├── types.ts
│       │   └── __tests__/      # vitest: text.test.ts, merge.test.ts, fit.test.ts
│       ├── config.ts           # WORKER_URL (the only place the Worker URL is read)
│       └── translate/
│           ├── client.ts       # fetch() to the Worker (Bearer token), invite verify, typed errors
│           ├── session.ts      # session token in sessionStorage
│           ├── batch.ts        # batching, concurrency, retries, missing-id handling
│           └── cache.ts        # Map cache (text + language → translation)
└── worker/                     # Cloudflare Worker: translation proxy only
    ├── wrangler.toml           # PROVIDER, model, reasoning effort, ALLOWED_ORIGINS (no secrets)
    ├── .dev.vars.example       # OPENAI_API_KEY, INVITE_CODE, AUTH_SECRET for local dev
    └── src/
        ├── index.ts            # POST /translate, POST /auth/verify, GET /auth/check, GET /health, CORS, id verification
        ├── auth.ts             # invite-code check, HMAC-SHA256 session tokens
        ├── __tests__/          # vitest: auth / token / CORS (provider mocked)
        ├── validate.ts         # request limits (+ context fields, terminology map)
        ├── prompt.ts           # system prompt, style guidance, terminology preferences, JSON schema
        ├── cors.ts
        ├── env.ts
        └── providers/
            ├── types.ts        # TranslationProvider interface
            ├── openai.ts       # OpenAI Responses API + strict JSON schema (default)
            ├── anthropic.ts    # Claude adapter (kept, not default)
            └── index.ts        # provider factory
```

---

## 1. Requirements

- Node.js 20.19 or newer (`node --version`)
- An OpenAI API key
- A Cloudflare account (free plan) only when you deploy the Worker; `wrangler dev` works without one

## Local Development

### 2. Worker (terminal 1)

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars
npm run dev                          # http://127.0.0.1:8787
```

`.dev.vars` (git-ignored) holds the three secrets:

```
OPENAI_API_KEY=sk-...
INVITE_CODE=local-dev-invite
AUTH_SECRET=<at least 32 random characters>
```

Generate `AUTH_SECRET` in Windows PowerShell:

```powershell
$b = New-Object byte[] 48; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

Check it works (Git Bash / macOS / Linux):

```bash
curl http://127.0.0.1:8787/health                                   # {"ok":true}
TOKEN=$(curl -s -X POST http://127.0.0.1:8787/auth/verify -d '{"code":"local-dev-invite"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -X POST http://127.0.0.1:8787/translate \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"blocks":[{"id":"t1","text":"I find that large language models exhibit look-ahead bias."}],"targetLanguage":"zh-TW"}'
```

Without the `Authorization` header `/translate` answers 401 and OpenAI is not called.

### 3. Frontend (terminal 2)

```bash
cd web
npm install
npm run dev                          # http://localhost:5173 (uses .env.development → http://127.0.0.1:8787)
```

The first screen asks for the invite code (`INVITE_CODE` from `.dev.vars`).

Scripts in `web/`: `npm test` (vitest), `npm run typecheck`, `npm run build`, `npm run preview`. In `worker/`: `npm test` (vitest, provider mocked), `npm run typecheck`, `npm run build` (wrangler dry-run bundle into `worker/dist`, nothing is uploaded), `npm run deploy`.

## 4. Using the app

### User Mode (default)

Open `http://localhost:5173/` (or `https://USERNAME.github.io/REPO/`). Drag a PDF onto the page or press **選擇 PDF**. File name and size appear and processing starts at once, with no further buttons:

讀取 PDF → 分析版面 → 翻譯 → 產生中英對照 PDF → 完成, shown as one progress bar (e.g. 正在翻譯... 42%). When it finishes the page shows **翻譯完成 ✓** and **下載中英對照 PDF** (`<name>_bilingual_zh-TW.pdf`, always Side-by-Side Bilingual, all pages, every translatable unit: TITLE / HEADING / BODY / CAPTION / FOOTNOTE; references stay English). No terminology map is sent (the Worker defaults apply).

Errors are shown in plain language only (details go to the console): scanned / no selectable text → 「目前只支援可選取文字的 PDF，掃描型 PDF 暫不支援。」, nothing could be translated → 「翻譯服務暫時發生問題，請稍後再試。」, export failed → 「PDF 產生失敗，請重新嘗試。」 (plus password-protected and out-of-memory messages). If only some units failed, the PDF is still produced with those units left in English and a one-line note.

Choosing another file while a job runs aborts it: no further batches are sent (requests already in flight finish and fill the cache), its results never reach the page, and the old download URL is revoked. The fonts start downloading while the translation runs.

User Mode and Developer Mode call the same functions in `main.ts`: `analyzePdf()` (extraction + layout + translation units), `translateAll()` (the batch pipeline) and `buildPdf()` (fonts + `generateTranslatedPdf`).

### Developer Mode (`?debug=true`)

`http://localhost:5173/?debug=true` shows every tool below; nothing starts automatically.

1. **Choose PDF** or drag-drop. Only real PDFs are accepted (MIME/extension plus the `%PDF-` signature).
2. **Analyze PDF** – extracts text, then runs layout analysis. The card shows pages, text items, detected layout, body font size, block count and the number of translation units, including how many were merged across column/page breaks and how many still look incomplete.
3. **Show Translation Blocks** – one card per translation unit. A merged unit shows a purple `merged ×2` tag and an `incomplete source` tag when the text still does not end a sentence. Expand **sourceBlockIds** to see `wasMerged`, `incompleteSource`, `mergeReason`, the geometry of every source block, and the `previousContext` / `nextContext` snippets that will be sent along.
4. **Translation Test** (below) – pick 1–10 units or the Abstract, translate only those, judge the quality.
5. **Translate Full PDF** – enabled only after you tick the confirmation under the test results.
6. **PDF Export** (bottom card) – pick an export mode (Side-by-Side Bilingual or Translated Only) and a render range, optionally tick **Show Bounding Boxes**, press **Generate**, then **Download**. See section 12.

Everything is also in the console: `__pdfDebug` (raw items), `__pdfLayout` (blocks and translation units), `__translations`, `__translationStats` (cost stats of the last run), `__pdfRender` (per-unit reports of the last export).

## 5. Translation Test Mode

1. After analysis, the **Translation Test** card appears.
2. Select units with **Select Abstract** (from the first block starting with "Abstract" on page 1–2 up to the next heading), **Pick Sample Blocks** (title, a heading, a caption, a footnote, body paragraphs from different pages), or by ticking **test** on cards in "Translation Blocks".
3. Optionally fill the **terminology map**: one `english term = 中文` per line, `→` or a JSON object also work. Entries are merged over the Worker's built-in preferences.
4. Press **Test Translation (n)**. Only the selected units are sent, as one batch.
5. Each card shows **Original** and **OpenAI Translation**. Check tone, terminology, citations, numbers and DOIs.
6. Tick the confirmation to unlock **Translate Full PDF**. Test translations are cached, so the full run reuses them.

## 6. Text preprocessing (`web/src/pdf/text.ts`, `merge.ts`)

### Hyphenation repair

`joinFragments(prev, next)` joins two line fragments. If `prev` ends with an alphabetic token plus `-` and `next` starts with a lowercase letter, the hyphen is treated as a typesetting break and removed (`reason-` + `ing` → `reasoning`). The hyphen is kept when the token already contains a hyphen (`state-of-the-` + `art`), starts with a digit (`5-year`), is a single letter (`X-ray`), or is a known prefix (`well-`, `self-`, `cross-`, `quasi-`, `pseudo-`, `ex-`, `ill-`, `so-`). Real compounds that are not at a line end (`out-of-the-box`) are never touched. `joinLines` applies this to every line of a paragraph and is what `layout.ts` uses to build block text.

### Sentence completeness

`analyzeCompleteness(text)` strips trailing citation markers and closing quotes/brackets, then decides:

| Ending | Result |
|---|---|
| `.` `!` `?` (also before a citation like `[12].`) | complete |
| `:` `;` | complete |
| abbreviation (`e.g.`, `et al.`, `Fig.`, `vs.` …) | incomplete, strong |
| `,` dash, open bracket | incomplete, strong |
| function word (`of`, `the`, `and`, `is`, `which`, `not` … ~90 words) | incomplete, strong |
| any other word without final punctuation | incomplete, weak |

### Merging into translation units

`buildTranslationBlocks(blocks)` walks the layout blocks in reading order. A BODY block that is incomplete is merged with the next BODY block when:

- the next block is the next real block in reading order (running HEADER/FOOTER blocks, e.g. page numbers, are skipped over);
- it is on the same page or the following page;
- it has the same type and a font size within 10 %;
- nothing else sits in between: a HEADING, CAPTION, TITLE, REFERENCE, AUTHOR or any non-translatable block stops the merge;
- the incompleteness signal is strong, **or** the next block starts with a lowercase letter (weak signal such as "Summary statistics" followed by "Table 1 reports…" is *not* merged).

At most `MAX_MERGED_BLOCKS = 3` blocks form one unit. If the result still does not end a sentence, the unit is flagged `incompleteSource: true` and the prompt tells the model to translate only the available text. Merged units get the id `merged-p1-b12-p2-b01` and keep `sourceBlockIds` for the overlay phase. Cross-column merges (left column bottom → right column top) and cross-page merges are both allowed.

### Context (token budget)

Blocks in one batch already see each other, so a normal complete unit carries **no** `previousContext` / `nextContext`. Extra context (at most 120 characters per side, cut earlier at a sentence boundary when possible) is attached only when it changes the translation:

| `contextReason` | when | sides |
|---|---|---|
| `incomplete` | a BODY/FOOTNOTE unit that does not end a sentence (headings and captions are exempt: they normally have no final period) | previous + next |
| `merged` | the unit was assembled from 2–3 blocks | previous + next |
| `continuation` / `continuation-cross-page` | the previous unit was cut mid-sentence, or this unit starts with a lowercase letter | previous only |

The analysis card shows the budget: input chars, context chars, units with extra context, and the context chars saved compared with the old policy (300 chars both ways for every unit). On the 50-page sample paper: 273 units, 91,310 input chars, context 23,408 chars on 176 units instead of 81,502 chars (−71 %). Contexts are context only; the model translates `currentText` exclusively.

### Tests

```bash
cd web && npm test
```

`text.test.ts` covers the hyphenation cases (`set-tings`, `reason-ing`, `out-of-the-box`, `well-known`, …), completeness detection and context snippets. `merge.test.ts` covers the column-break merge (Case 4), the page-break merge across header/footer (Case 5), no merge across a heading (Case 6) or a caption, hyphenation at the merge point, the 3-block cap, and the font-size and type guards.

## 7. Layout analysis (`web/src/pdf/layout.ts`)

1. **Body font size** – character-weighted most common font size in the document.
2. **Lines** – items are clustered by baseline (`|Δy| ≤ 0.5 × fontSize`), then each cluster is split at horizontal gaps wider than `0.8 × fontSize`.
3. **Columns (per page)** – using body-sized lines only: if both halves of the page have at least 5 lines and crossing lines do not dominate, the page is `TWO_COLUMN`; lines are `LEFT`, `RIGHT` or `SPANNING`. Single-column pages use `FULL`.
4. **Blocks** – inside one region, lines are merged unless the baseline pitch is too large, the font size differs by more than 15 %, the dominant font changes, or the line is indented.
5. **Reading order** – single column: top→bottom. Two columns: spanning blocks split the page into bands; within a band, left column, then right column, then the spanning block.
6. **Classification (`classify.ts`)** – HEADER/FOOTER (repeated text at page edges), TITLE, AUTHOR, CAPTION, FOOTNOTE, HEADING, REFERENCE, TABLE, OTHER (equations, fragments), BODY. This coarse `type` drives merging and overlay; every block also gets a `sectionType` and a fine `blockType` (both shown in Developer Mode, see below).
7. **Do-not-translate** – HEADER, FOOTER, AUTHOR, REFERENCE, OTHER, numeric-only table cells (`NUMERIC_ONLY`), upper-case abbreviation-only cells (`ABBREVIATION_ONLY`, e.g. `COPD`, `LABA + ICS`), and blocks that are only a DOI, URL, e-mail, page number or citation marker.

### Sections after the reference list

Academic PDFs often continue after the references (figures, tables, supplemental material, appendix, questionnaires). The classifier walks the blocks with a section state: `MAIN → REFERENCES → FIGURES / TABLES / SUPPLEMENTAL / APPENDIX → REFERENCES (a supplement's own list) …`

- **Entering REFERENCES**: a block whose whole text is `References`, `Bibliography`, `Literature Cited`, `Works Cited`, `Reference List` (any font; the accounting sample's small `REFERENCES` line was previously missed, so its bibliography used to be translated).
- **Leaving REFERENCES**: a figure / table caption with a real number (`Figure 1.`, `Table 3:`, `Supplemental Material Figure 2.`, `Supplementary Table S1`, `Fig. B1.—`, `eTable 2`); a supplemental / appendix heading (`Supplemental Material`, `Supplementary …`, `Online Supplement`, `Additional Methods`, `Extended Data`, `Appendix`, `Appendices`); a back-matter heading (`Acknowledgments`, `Funding`, `Author contributions`, `Figure legends`, …); any other heading-styled block that does not look like a bibliography entry; or a prose paragraph of 40+ words without year / et al. / DOI / volume(issue).
- **Inside REFERENCES** every block is REFERENCE and skipped: `REFERENCE_ENTRY` when it has bibliography features (`23.` / `[12]` start, `Surname, X.X.` start, DOI, or a year with et al. / volume(issue) / `p. 12-34`), `REFERENCE_CONTINUATION` for the wrapped lines of an entry.
- **FIGURES / TABLES**: caption pages after the references. The first heading or real paragraph there switches to **SUPPLEMENTAL** (supplementary material that has no explicit heading, as in the medical sample).
- **SUPPLEMENTAL / APPENDIX** blocks get `SUPPLEMENTAL_HEADING` / `SUPPLEMENTAL_BODY` / `SUPPLEMENTAL_FOOTNOTE` / `APPENDIX_HEADING` / `APPENDIX_BODY`; a block ending in `?` is `QUESTIONNAIRE`, and short answer options on a page with questions (and no figure) are translated as `QUESTIONNAIRE` instead of being dropped as fragments.

**Figures** (no OCR): `FIGURE_CAPTION` (plus its continuation block) and `FIGURE_NOTE` (`Note:`, `Abbreviations:`, `Data are …`, `*`, `†` … right after the caption, also on the next page) are translated and overlaid. Text drawn inside the figure stays as it is.

**Tables**: a table caption opens a table context that ends at a note, a paragraph-like block, a large heading or a page gap. Inside it: `TABLE_CAPTION` (translated), `TABLE_HEADER` (text above the first numeric row, translated), `TABLE_TEXT_LABEL` (translated: `Female, n (%)`, `Age, years`, `Smoking history` …), `TABLE_CELL` (numeric only — `67.6 ± 5.2`, `n=12`, `p<0.001`, `83%`, `10,589±7,251`, `–` — never sent to the API), `TABLE_NOTE` (translated). Table text cells use the coarse type `TABLE`, which is overlay-eligible, and are never merged with other blocks.

**Developer Mode** shows `sectionType`, `blockType`, `translationEligible`, `overlayEligible` and `skipReason` in each card's details (and as tags), and in the console table of blocks.

Block coordinates: `x` = left, `y` = **bottom**, `top = y + height`, PDF points, origin bottom-left.

## 8. Translation pipeline and prompt

- `batch.ts` slices units **in reading order** into batches of at most 25 units or 10 000 characters (text + context), whichever limit comes first, 3 batches concurrently. Test mode sends one batch of up to 10.
- Before batching, units that need no translation (a number / statistic, DOI, URL, e-mail, citation marker, page number: `isUntranslatableText`) get the status `skipped` and are never sent; the classifier already drops most of them, this is the last check. Cache hits (`cached`) are not sent either.
- **Payload**: an ordinary unit is `{ "id", "text" }`. Only special units add `contextBefore` / `contextAfter` / `incompleteSource`. Page, coordinates, font size, column, sourceBlockIds, overlay flags and warnings stay in the browser.
- **Context deduplication**: the contexts assigned in `merge.ts` are dropped at request time whenever the neighbour they were taken from is part of the same request (`buildPayload`), because the model sees that neighbour in reading order anyway. Context is only sent across batch boundaries and next to cached / skipped neighbours, so no text is sent twice inside one request and no boundary is described from both sides in the same request.
- The Worker validates the request (≤50 units, ≤6000 chars each, ≤40 000 total, contexts ≤600 chars, ≤200 terminology entries), builds the prompt, calls the provider with a strict JSON schema, and checks that every requested id came back. Missing ids are re-sent once inside the Worker (only those ids); the frontend re-sends what is still missing in batches of 5. A whole batch is only re-sent after a transport failure (nothing came back).
- Network errors, timeouts, 5xx and 429 are retried with backoff. Failed units can be retried from the UI.
- Successful translations are cached in memory by `(language, normalized text)`; the key is trimmed and runs of whitespace (including U+00A0 / U+3000) collapse to one space, nothing else (case, punctuation and citations stay). Repeated labels inside one PDF and a second run on the same file cost no API call. Generating, re-generating or switching the export mode of the PDF never calls the API: it only reads the entries.

**Translation Cost Stats** (Developer Mode, under "Full Translation", also `window.__translationStats` and one `[Translation Cost]` console line): API requests, provider calls, retry requests, translated / cached / skipped / failed blocks, input chars, context chars sent vs. assigned, estimated input / output tokens (≈4 English chars or 0.8 CJK char per token), retry tokens, the provider's real usage (`input_tokens`, `cached_tokens`, `output_tokens`, summed by the Worker over its provider calls and returned as `usage` / `providerCalls`), and a "before optimization" estimate for the same blocks (15 units / 12 000 chars per request, ~1 050-token prompt, 150-char contexts on both sides) with the saved tokens and percentage. User Mode shows none of this.

**Prompt** lives in `worker/src/prompt.ts` and is shared by both providers. It states every rule once (≈1 900 characters instead of ≈4 200; the same rules, style examples and safety rules, no repeated "do not …" paragraphs):

- the professional-academic-translator brief from the spec (exact meaning, no summarising/omitting/adding/inferring, natural Chinese syntax over English structure, Taiwan terminology, preserve numbers/percentages/equations/citations/DOI/URLs/model names, batch-level consistency);
- style guidance with the concrete examples: "I show that…" → 研究結果顯示……／本文指出……, "I find that…" → 研究發現……／本文發現……, "I set out to examine…" → 本文旨在探討……, "the literature does not provide…" → 現有文獻往往缺乏……;
- first-mention rule: 大型語言模型（Large Language Models, LLMs）once, then only the Chinese term or the abbreviation;
- input format: units `{id, text}` in document reading order (neighbouring units are context only), optional `contextBefore` / `contextAfter` (context only, never translated) and `incompleteSource` ("translate only the available text, do not complete the sentence");
- output rules: one translation per id, never merge/split/skip ids, single line, full-width punctuation.

`DEFAULT_TERMINOLOGY` in the same file holds the terminology **preferences** (股東權益報酬率, 利潤率, 財務報表, 推論, 大型語言模型, 數值推理, 前瞻偏誤, 損益表, 迴歸, …). They are presented to the model as preferred renderings for the usual technical sense, not as blind replacements. `filterTerminology()` puts only the entries whose term occurs in the batch (case-insensitive, singular/plural, hyphen or space) into the system prompt, so a batch about numerical reasoning does not carry 損益表. Terminology consistency across batches relies on this map; the model only sees one batch at a time, and there is no document-level first-mention state (the parenthesised English term may reappear in a later batch).

**Provider: OpenAI (default).** `worker/src/providers/openai.ts` calls the Responses API with `text.format = json_schema, strict: true`. Settings in `wrangler.toml`:

| Var | Default | Notes |
|---|---|---|
| `PROVIDER` | `openai` | or `anthropic` |
| `OPENAI_MODEL` | `gpt-5.6-terra` | never hard-coded; `gpt-5.6-sol` if quality is still short |
| `OPENAI_REASONING_EFFORT` | `low` | `none` is also allowed; translation does not need deep reasoning |

Note: values in `worker/.dev.vars` override `[vars]` from `wrangler.toml` during `wrangler dev`.

## 9. Secrets, invite code and session tokens

| Name | Where | Secret? |
|---|---|---|
| `OPENAI_API_KEY` | Worker secret (`wrangler secret put`), `.dev.vars` locally | yes |
| `INVITE_CODE` | Worker secret | yes |
| `AUTH_SECRET` | Worker secret, ≥ 32 random characters | yes |
| `VITE_WORKER_URL` | GitHub repository **variable**, `web/.env.development` | no, public URL compiled into the JS |

None of the secrets is ever in the frontend, in a `VITE_*` variable or in the repository (`.dev.vars`, `.env`, `.env.local`, `.env.*.local`, `.env.production`, `*.secret` are git-ignored).

Auth flow:

1. The page starts locked (`<html class="locked">`) and shows the invite screen.
2. `POST /auth/verify {"code"}` → the Worker compares SHA-256 digests of the typed code and `INVITE_CODE` in constant time. Wrong: `401 {"ok":false}` (the page shows 「邀請碼不正確」); missing: `400`; correct: `200 {"ok":true, token, expiresAt}`.
3. Token = `base64url(payload) + "." + base64url(HMAC-SHA256(AUTH_SECRET, base64url(payload)))`, payload `{"v":1,"iat","exp","sid"}` (timestamps + random session id only, never the invite code or a key). Lifetime 24 h (`TOKEN_TTL_SECONDS` in `worker/src/auth.ts`).
4. The page keeps the token in `sessionStorage` (closing the tab ends the session) and sends `Authorization: Bearer <token>` with every `/translate`.
5. `/translate` verifies signature (`crypto.subtle.verify`) and expiry **before** reading the body; failure → `401`, the provider is never called. The page then clears the token, stops the running job and returns to the invite screen with 「登入已過期，請重新輸入邀請碼。」.
6. On reload a stored token opens the app immediately and `GET /auth/check` confirms it in the background.

`?debug=true` does not bypass any of this; it shows provider/model (from `/health`, only with a valid token) but never the token or a secret. Rotating `AUTH_SECRET` logs everyone out; changing `INVITE_CODE` only affects new logins (existing tokens stay valid until they expire).

CORS: `ALLOWED_ORIGINS` in `wrangler.toml` is an explicit allowlist (`http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:4173`, `https://<user>.github.io`), never `*`. An origin has no path: for `https://alice.github.io/pdf-translator/` the entry is `https://alice.github.io`. Requests from other origins get `403` and no `Access-Control-Allow-Origin`. Every Worker response carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.

## 10. Production Deployment

### Cloudflare Worker (manual)

In `worker/`, first replace `YOUR-GITHUB-USERNAME` in `ALLOWED_ORIGINS` (`wrangler.toml`) with your GitHub account, then:

```bash
npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put INVITE_CODE
npx wrangler secret put AUTH_SECRET
npx wrangler deploy
```

`wrangler deploy` prints the URL, e.g. `https://pdf-translator-worker.<subdomain>.workers.dev`. The Worker is deployed by hand on purpose, so no Cloudflare API token has to be stored in GitHub.

### GitHub Pages (automatic)

1. GitHub → repository → Settings → Secrets and variables → Actions → **Variables** → New repository variable `VITE_WORKER_URL` = the Worker URL above.
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Push to `main`. `.github/workflows/deploy-pages.yml` runs `npm ci`, `npm test`, `npm run typecheck`, `npm run build` in `web/` and deploys `web/dist` (dist is never committed).

Base path: the workflow passes `actions/configure-pages`' `base_path` as `BASE_PATH` (`/pdf-translator/` for a project site, `/` for `<user>.github.io` or a custom domain), so renaming the repository needs no code change. JS, CSS, the PDF.js worker (`?url` import) and the fonts (`import.meta.env.BASE_URL + 'fonts/...'`) all follow it. Without `BASE_PATH` the build uses relative `./` URLs.

## 11. Known limitations

- Access control is one shared invite code, not accounts: anyone who has the code can use the service, and a token cannot be revoked individually (only all at once by rotating `AUTH_SECRET`). There is no server-side rate limit or brute-force lockout (that would need KV / Durable Objects), so use a long, random invite code and watch OpenAI usage limits. A leaked token stays valid for up to 24 h.

- Cost: the output (Chinese) tokens are about 40 % of the total and cannot be reduced without changing the translation; the optimizations only shrink the input side. The compressed system prompt (≈480 tokens) is below OpenAI's 1 024-token prompt-cache threshold, so it is never served from the cache — it is still cheaper than a cached 1 040-token prompt. The "before optimization" figure in the cost stats is an estimate, not a measurement.
- Papers with **no paragraph indentation and no extra paragraph spacing** cannot be split into paragraphs by geometry.
- Column detection needs a gutter wider than about 0.8 × body font size.
- Three-column layouts and rotated pages are not handled.
- Table cells become `fragment` / `OTHER`; only captions are translated.
- Hyphenation repair cannot consult a dictionary: a line ending in a prefix that is not in the keep-list (`non-`, `pre-`, `co-`, `inter-`…) followed by a lowercase word loses its hyphen (`non-linear` → `nonlinear`), and a keep-list prefix that was really a syllable break keeps it.
- Completeness detection is heuristic. A paragraph that legitimately ends without a period (list item, table note) is flagged incomplete; it is only *merged* when the next block visibly continues it, otherwise just marked `incompleteSource`.
- Merging never crosses a figure caption, so a paragraph interrupted by a floating figure stays split; both halves are marked incomplete and translated separately.
- A merged unit produces one translation for 2–3 layout blocks; the overlay flows it through the source boxes in order (see section 12), which can leave the first box slightly short or the last box slightly long.
- FOOTNOTE blocks are not merged.
- The cache and the terminology textarea are in-memory only.
- Overlay: only TITLE / HEADING / BODY / CAPTION / FOOTNOTE / TABLE (text labels) are written back; references, numeric table cells, figure-internal text, headers/footers stay English. Table labels are fitted into their own narrow cell boxes and can shrink to the minimum size or extend slightly downward.
- Classification after the references is heuristic: a supplement without any heading, caption or paragraph after the reference list stays REFERENCE; a supplement's repeated title / author list is translated like body text; a caption split into two blocks is translated as two units (captions are not merged). Masks are plain white rectangles (coloured backgrounds show white patches). Rotated pages and rotated text are skipped. Only raster images are detected for overlap, not vector charts. One weight per font (no Liberation Serif Bold/Italic yet): bold/italic runs, first-line indents, right-aligned or justified lines are not reproduced. Footnote markers are written inline at the footnote size, not raised as superscripts. The original English stays in the file under the masks (no true redaction), so text search still finds it.

## 12. PDF export: writing the translation back (`render.ts`, `fit.ts`, `font.ts`)

The original PDF is the base document. Nothing is re-typeset: pdf-lib loads the untouched file bytes, and for every eligible translation unit it (1) paints white rectangles over the **source lines** and (2) draws the Chinese translation into the block's box. Everything else (images, tables, rules, footnotes, references, headers) is left exactly as it was.

Two export modes share this painter (`generateTranslatedPdf({ output })`):

| Export mode | Output | File name |
|---|---|---|
| **Side-by-Side Bilingual** (default) | a new document; output page *n* is a spread `[ original page n | gap | translated page n ]`, width `2 × W + 14 pt`, height `H` (W/H = the page's view box, rotation applied) | `<name>_bilingual_zh-TW.pdf` |
| **Translated Only** | the original pages, rewritten in place | `<name>_zh-TW.pdf` |

Bilingual composition: every original page of the render range is embedded into the new document with one `embedPages()` call (one object copier, so fonts and images shared by several pages are copied once). Each spread draws that Form XObject twice, at `x = 0` and `x = W + gap`, then a 0.5 pt light-grey separator, then the normal mask + text painter runs on the right half through a `q 1 0 0 1 (W + gap − x0) (−y0) cm … Q` translation of the page's user space. No translated-only PDF is produced and re-read, translations are not re-requested, and the overlay geometry is identical to the translated-only output. Debug mode draws the boxes on the right half only. Pages with `/Rotate` are placed rotated on both halves (their units are skipped anyway).

### Data flow

```
File → arrayBuffer ──┬─ copy → PDF.js (extraction, coordinates, layout, image boxes)
                     └─ original → pdf-lib (load, mask, draw, save)
```

`extractPdf()` copies the buffer before handing it to PDF.js (the worker transfer would detach it). `main.ts` keeps the original in `currentPdfBytes` for pdf-lib.

### Coordinates

PDF.js text items (`transform[4], transform[5]`) are in PDF user space: points, origin bottom-left, y up, relative to the page's own coordinate origin (not the CropBox corner). pdf-lib draws in the same space, and it wraps the existing content in `q … Q` before appending, so block/line geometry from `layout.ts` is used **without any conversion**. Page bounds come from `page.view` (`[x0, y0, x1, y1]`). Pages with `/Rotate ≠ 0` are marked `PAGE_ROTATED` and skipped in this version; items whose text matrix is rotated or skewed are `ROTATED_TEXT`.

### Which units are overlaid

`assessOverlay()` sets `overlayEligible` / `overlaySkippedReason` on every translation unit (visible as tags in "Translation Blocks"):

| Reason | Meaning |
|---|---|
| eligible | type is TITLE, HEADING, BODY, CAPTION, FOOTNOTE or TABLE and none of the checks below fail |
| `TYPE_HEADER` … | other block types (headers, footers, references, authors, equations) are neither translated nor written back |
| `PAGE_ROTATED` | the page has a `/Rotate` entry |
| `ROTATED_TEXT` | a source item is rotated / vertical |
| `IMAGE_OVERLAP` | the block overlaps a raster image by more than 10 % of its area (images come from the page operator list: `cm`, `q/Q`, form XObjects tracked; full-page background images ignored; vector drawings are not detected) |
| `INVALID_COORDINATES`, `OUT_OF_PAGE` | broken geometry |
| `NO_TRANSLATION` (render time) | the unit has no successful translation yet |

### Line-level masking

For each source line of an eligible block: `x = line.x − 1.5`, `width = line.width + 3`, vertical extent from the line's items (`y + 0.8·fontSize` to `y − 0.25·fontSize`, superscripts included) plus 1 pt, clamped to the page. Filled white, no border. The paragraph bounding box is never masked as a whole, so a figure next to a paragraph is safe. All masks of a page are drawn before any text, so a block that extends below its box is never hidden by a later mask.

### Fonts: LXGW WenKai TC + Liberation Serif + Noto Sans Symbols 2, Noto Sans TC as fallback

The translated text is drawn with **four** open-source fonts, chosen per character (`font.ts`, `FONT_SOURCES`). All are committed in `web/public/fonts/` and deployed with GitHub Pages; nothing is read from the system (`C:\Windows\Fonts`) and no commercial font is needed:

| Role | Font | File | Committed? |
|---|---|---|---|
| Chinese / CJK, fullwidth punctuation | LXGW WenKai TC Regular (霞鶩文楷 TC) v1.522 | `web/public/fonts/LXGWWenKaiTC-Regular.ttf` (13 MB, trimmed + padded by `build-font.py`) | yes (OFL, `OFL-LXGWWenKaiTC.txt`) |
| Latin letters, digits, ASCII punctuation, spaces (model names, DOI, URL, citations, %, abbreviations) | Liberation Serif Regular 2.1.5 | `web/public/fonts/LiberationSerif-Regular.ttf` (unmodified) | yes (OFL, `LICENSE-LiberationSerif.txt`) |
| symbol blocks: arrows, math operators, misc technical, geometric shapes, dingbats … | Noto Sans Symbols 2 Regular (unmodified, 1.2 MB) | `web/public/fonts/NotoSansSymbols2-Regular.ttf` | yes (OFL, `OFL-NotoSansSymbols2.txt`) |
| final fallback for any glyph the other fonts lack, or a whole role when its file is missing | Noto Sans TC Regular | `web/public/fonts/NotoSansTC-Regular.ttf` | yes (OFL, `OFL-NotoSansTC.txt`) |

**Glyph selection** (`MixedFont.selectFontForGlyph`): the character's class picks the primary font, then the font's real cmap is checked and the class's chain is walked until a font has the glyph:

| class | characters | chain |
|---|---|---|
| cjk | CJK ideographs, kana, bopomofo, CJK / fullwidth punctuation | WenKai → Symbols 2 → Noto TC → Liberation |
| latin | everything else: Latin, digits, Greek (α β Δ), Latin-1 (± × ÷ ° ² ³), – — ‰ ′, super/subscripts | Liberation → Symbols 2 → Noto TC → WenKai |
| symbol | U+2190–23FF, U+2460–2BFF, pictographs, Private Use Area | Symbols 2 → Liberation → Noto TC → WenKai |

Noto Sans Symbols 2 does not contain ± ≤ ≥ ≈ ≠ ∞ √ or the basic arrows, so those end up in Liberation Serif, which keeps them in the same style as the digits. Glyphs drawn by a non-primary font count as `fallbackGlyphs`. Widths are always taken from the font that finally draws the glyph, so wrapping, fitting and drawing agree.

Only when no font has the glyph is the character replaced (first by an ASCII stand-in such as `∗ → *`, otherwise by `□`) and reported once per export:

```
[Font Fallback Warning]
character="" (the raw private-use character, usually invisible)
codePoint="U+F05B"
fontsTried=["Noto Sans Symbols 2","Liberation Serif","Noto Sans TC","LXGW WenKai TC"]
```

At the end of an export the console lists all such code points with counts.

**Symbol-font private-use characters** (`symbols.ts`). Fonts with the Adobe Symbol encoding (Symbol, SymbolMT) often have no ToUnicode map; PDF.js then reports their glyphs at U+F000 + code. The medical sample has `U+F05B`/`U+F05D` (the brackets of `95% CI [3.0, 13.6]`), `U+F044` (Δ), `U+F061` (α), `U+F062` (β), `U+F0B1` (±), `U+F0B3` (≥) and `U+F0B7` (•) — these were the `□`. Right after extraction every item whose real font name is a Symbol font gets U+F020–U+F0FF mapped through the Symbol encoding (159 entries generated from PDF.js' own `SymbolSetEncoding` + glyph list; Delta / Omega / mu map to the Greek letters). Other fonts (Wingdings, unresolved names) and code points without a standard Unicode value (bracket / radical extension pieces) are left alone and end in the fallback warning above. Real font names are now resolved after the page's operator list has loaded the fonts, so fonts used for the first time on a page are recognized too. `PdfAnalysis.normalizedSymbolCount` and a console line report how many characters were converted.

`loadFontSet()` downloads the three files once per session. A primary file that fails to load is reported in the PDF Export card ("LXGW WenKai TC font file not found (…). Expected web/public/fonts/LXGWWenKaiTC-Regular.ttf; using Noto Sans TC for Chinese text.") and the export still runs; glyphs drawn with the fallback are counted (`fallbackGlyphs`).

**Mixed-font rendering.** `MixedFont.runs(text)` splits every line into runs by the font chosen above: CJK characters and CJK punctuation → LXGW WenKai TC, Latin text, digits and spaces → Liberation Serif, symbol blocks → Noto Sans Symbols 2 or the next font in the chain. So `大型語言模型（Large Language Models, LLMs）` becomes `[WenKai] 大型語言模型（ [Liberation] Large Language Models, LLMs [WenKai] ）`. Lines are written with raw text operators (one `BT … ET` per line, one `Tf`/`Tj` pair per run, `PageTextWriter` in `render.ts`), so runs join at the natural advance and each font gets one resource entry per page.

**Widths.** `MixedFont` implements the `TextMeasurer` interface used by `fit.ts`: the width of a token is the sum of its runs' `widthOfTextAtSize()` in their own fonts. Because the font choice is context-free, the width of a line equals the sum of its tokens' widths, so wrapping, centring and drawing agree exactly. The line height stays `1.3 × fontSize` for every run.

**Subsetting.** All three fonts are embedded with `subset: true` (a 3-page export adds about 110 KB). `@pdf-lib/fontkit` cannot subset CID-keyed CFF (`OTTO`) fonts, and its TrueType subsetter writes short `loca` offsets without padding, which corrupts glyphs when a font has odd-length glyph data. `trueTypeSubsetSafe()` checks every font file for that; an unsafe file is embedded whole (correct glyphs beat a small PDF). The official LXGW WenKai TC file has ~12,800 odd-length glyphs, so `build-font.py` pads it (and trims it to the same Unicode ranges as Noto: 15.3 MB → 13.1 MB); Liberation Serif and the shipped Noto file are safe as they are. Verified in this order: subset with pdf-lib → embedded `FontFile2` re-parsed with fontTools (every glyph decodes, composites included) → rendered with MuPDF: `會計與財務領域的數值推理`, `Large Language Models (LLMs)`, `30%–40%, ROE, o1-preview`, `大型語言模型（Large Language Models, LLMs）…[12]，ROE 下降 30%。`, `¹ OpenAI 並未公開 GPT-4 …https://doi.org/…`. Characters no font has become `□`.

`web/scripts/build-font.py` documents how the LXGW WenKai TC and Noto files were produced (instance at wght=400 for the variable Noto font, trim to the needed ranges, pad glyphs to 4 bytes). Liberation Serif is shipped unmodified (its Reserved Font Name forbids modified copies under the same name).

### Wrapping (`fit.ts`)

`tokenize()` splits the translation into wrap units: every CJK character is its own token; Latin/digit runs stay whole (`o1-preview`, `GPT-4`, `30%`, `[12]`, `https://doi.org/…`, `LLM`); CJK opening punctuation `（《「『【` is `open` (never ends a line), closing punctuation `，。、；：？！）》」』】…` is `close` (never starts a line, the previous character is pulled down with it). Widths come from `font.widthOfTextAtSize()`. A token wider than the whole line (very long URL) is split by characters.

### Footnotes

FOOTNOTE blocks are translated (never merged with BODY or with each other) and written back like any other unit, at their own small font size. If the translation dropped the leading marker (`1`, `12`, `*`, `∗`, `†`, `¹`…), the marker from the source block is put back in front. References stay English.

### Fitting

`fitTextToBox({ text, width, height, originalFontSize, font })`: wrap at the original size, `lineHeight = 1.3 × fontSize`, `extent = (lines − 1) × lineHeight + 1.05 × fontSize` (so a one-line block fits at the original size). If it does not fit, decrease by 0.5 pt and retry, down to `max(6 pt, 0.7 × original)`. At the minimum, allow the block to grow downward by up to 25 % of its height (never below the page bottom). If it still does not fit, the layout is used anyway, nothing is cut, and the unit is reported with `TEXT_OVERFLOW` (`layoutWarning`). Lines that would land below the page are not drawn and reported as `PAGE_OVERFLOW`. Multi-line TITLE/HEADING blocks whose lines are centred are drawn centred.

### Merged units

A unit with several `sourceBlockIds` (column or page break) is laid out with `fitTextToBoxes()`: the text **flows** through the boxes in order at one shared font size. Every box except the last is filled to its line capacity (this is how the English filled the column before continuing), the remainder goes to the last box, which gets the shrink → extension → warning treatment. The split point is therefore always a token boundary, and the proportion follows the boxes' actual capacity. Each box's lines are drawn on its own page.

### Progress, memory, errors

The generator yields to the event loop after every page and every 20 blocks; the card shows `stage · Page n / N · %`. The saved bytes go into a Blob object URL (`<name>_zh-TW.pdf` / `<name>_bilingual_zh-TW.pdf`, or `…_debug-boxes.pdf`), revoked when a new PDF is generated or another file is chosen. A bilingual export of a page range only contains the objects reachable from those pages, so *Page 1 only* stays small; the full bilingual document is roughly the size of the original plus the Chinese subset font. Encrypted PDFs, pdf-lib load/save failures, font download failures and out-of-memory errors surface in the card; a single block that fails to draw only produces a warning.

### Testing the export

1. Analyze the PDF, then in **PDF Export** tick **Show Bounding Boxes**, keep *Page 1 only*, press **Generate Debug PDF** and open the download: red = block that will be overlaid (with its id), blue = its lines, grey dashed = translated but not overlaid (reason in the label), green dashed = detected image. The red boxes must hug the English text exactly (in bilingual mode they appear on the right half only, next to the untouched left page).
2. Run **Select Abstract → Test Translation**, then export with range *Abstract only*.
3. *First 3 pages*, then *Full PDF* after the full translation. Units without a translation are skipped, not masked.
4. Warnings: the **Layout warnings** disclosure under the status lists every `TEXT_OVERFLOW` / `PAGE_OVERFLOW` / `DRAW_FAILED` unit and the skipped units grouped by reason. The console prints one `[PDF Render] page=… block=… fontSize=… finalFontSize=… lines=… warning=…` line per block and `[PDF Render Warning] block=… reason=…` for problems; `window.__pdfRender` holds the reports.

`fit.test.ts` covers the tokenizer, 禁則 wrapping, long-token splitting, `maxLines` handoff, shrinking, extension, overflow and multi-box flow.
#   p d f - t r a n s l a t o r  
 