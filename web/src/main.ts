/**
 * Entry point.
 *
 * Phase A: choose / drag-drop a PDF, validate it, show name and size.
 * Phase B: PDF.js text extraction and raw debug data.
 * Phase C: layout analysis → lines → blocks → translation blocks.
 * Translation Test Mode: pick 1–10 blocks, translate only those, review quality.
 * Full translation: unlocked only after the test is marked as passed.
 * Phase D–F: pdf-lib overlay → downloadable <name>_zh-TW.pdf (or a debug
 * bounding-box PDF to verify coordinates first).
 *
 * User Mode (default): choosing a file runs analyze → translate everything →
 * side-by-side bilingual PDF automatically and only shows simple progress.
 * Developer Mode (?debug=true): every tool above, unchanged. Both modes use
 * the same analyzePdf() / translateAll() / buildPdf() core.
 *
 * The PDF is read with the File API into an ArrayBuffer and never uploaded.
 * Only JSON text blocks (plus an optional terminology map) go to the Worker.
 * The same ArrayBuffer is kept for pdf-lib; PDF.js only ever sees a copy.
 */

import './styles.css';
import { extractPdf } from './pdf/extract';
import { FONT_SOURCES, FontLoadError, loadFontSet } from './pdf/font';
import { analyzeLayout } from './pdf/layout';
import {
  assessOverlay,
  generateTranslatedPdf,
  RenderError,
  type RenderMode,
  type RenderOutput,
  type RenderResult,
} from './pdf/render';
import type { FontSetBytes } from './pdf/font';
import type { RenderProgress } from './pdf/render';
import type { LayoutResult, PdfAnalysis, TextBlock, TextItemDebug, TranslationBlock, TranslationEntry } from './pdf/types';
import { translateBlocks, type TranslateBlocksOptions, type TranslationStats } from './translate/batch';
import { TranslationCache } from './translate/cache';
import { TranslateClient } from './translate/client';
import { clearSession, getSessionToken, saveSession } from './translate/session';
import { WORKER_URL } from './config';

const DEBUG_ITEM_LIMIT = 50;
const TARGET_LANGUAGE = 'zh-TW';
const TEST_MIN_BLOCKS = 1;
const TEST_MAX_BLOCKS = 10;
const SAMPLE_SIZE = 8;

/** ?debug=true shows every developer tool; otherwise the simplified User Mode. */
const DEBUG_MODE = new URLSearchParams(window.location.search).get('debug') === 'true';
document.documentElement.classList.toggle('debug', DEBUG_MODE);

// ---------------------------------------------------------------------------
// DOM lookup
// ---------------------------------------------------------------------------

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

const dropZone = byId<HTMLDivElement>('drop-zone');
const fileInput = byId<HTMLInputElement>('file-input');
const chooseBtn = byId<HTMLButtonElement>('choose-btn');
const fileInfo = byId<HTMLDivElement>('file-info');
const fileNameEl = byId<HTMLElement>('file-name');
const fileSizeEl = byId<HTMLElement>('file-size');
const analyzeBtn = byId<HTMLButtonElement>('analyze-btn');
const statusEl = byId<HTMLParagraphElement>('status');
const errorEl = byId<HTMLParagraphElement>('error');

const resultsEl = byId<HTMLElement>('results');
const resFile = byId<HTMLElement>('res-file');
const resPages = byId<HTMLElement>('res-pages');
const resItems = byId<HTMLElement>('res-items');
const resSelectable = byId<HTMLElement>('res-selectable');
const resLayout = byId<HTMLElement>('res-layout');
const resBodyFont = byId<HTMLElement>('res-body-font');
const resBlocks = byId<HTMLElement>('res-blocks');
const resTranslationBlocks = byId<HTMLElement>('res-translation-blocks');
const resContext = byId<HTMLElement>('res-context');
const warningEl = byId<HTMLParagraphElement>('warning');
const unsupportedEl = byId<HTMLParagraphElement>('unsupported');

const toolbar = byId<HTMLDivElement>('analysis-toolbar');
const blocksToggle = byId<HTMLButtonElement>('blocks-toggle');
const debugToggle = byId<HTMLButtonElement>('debug-toggle');
const workerInfo = byId<HTMLParagraphElement>('worker-info');

const blocksPanel = byId<HTMLDivElement>('blocks-panel');
const blocksOnlyTranslate = byId<HTMLInputElement>('blocks-only-translate');
const blocksList = byId<HTMLDivElement>('blocks-list');

const debugPanel = byId<HTMLDivElement>('debug-panel');
const debugLimitEl = byId<HTMLElement>('debug-limit');
const debugList = byId<HTMLDivElement>('debug-list');

// test mode
const testSection = byId<HTMLElement>('test-section');
const terminologyInput = byId<HTMLTextAreaElement>('terminology-input');
const terminologyError = byId<HTMLParagraphElement>('terminology-error');
const pickSampleBtn = byId<HTMLButtonElement>('pick-sample-btn');
const clearSelectionBtn = byId<HTMLButtonElement>('clear-selection-btn');
const pickAbstractBtn = byId<HTMLButtonElement>('pick-abstract-btn');
const testBtn = byId<HTMLButtonElement>('test-btn');
const selectionInfo = byId<HTMLElement>('selection-info');
const testStatus = byId<HTMLParagraphElement>('test-status');
const testList = byId<HTMLDivElement>('test-list');
const testOkWrapper = byId<HTMLElement>('test-ok-wrapper');
const testOkCheckbox = byId<HTMLInputElement>('test-ok-checkbox');

// full translation
const fullSection = byId<HTMLElement>('full-section');
const translateBtn = byId<HTMLButtonElement>('translate-btn');
const retryBtn = byId<HTMLButtonElement>('retry-btn');
const translateStatus = byId<HTMLParagraphElement>('translate-status');
const costStats = byId<HTMLDetailsElement>('cost-stats');
const costStatsList = byId<HTMLPreElement>('cost-stats-list');
const previewEl = byId<HTMLElement>('preview');
const previewSummary = byId<HTMLParagraphElement>('preview-summary');
const previewList = byId<HTMLDivElement>('preview-list');

// PDF export (Phase D–F)
const exportSection = byId<HTMLElement>('export-section');
const exportSummary = byId<HTMLParagraphElement>('export-summary');
const exportMode = byId<HTMLSelectElement>('export-mode');
const renderRange = byId<HTMLSelectElement>('render-range');
const renderDebug = byId<HTMLInputElement>('render-debug');
const generateBtn = byId<HTMLButtonElement>('generate-btn');
const renderStatus = byId<HTMLParagraphElement>('render-status');
const renderProgress = byId<HTMLProgressElement>('render-progress');
const renderError = byId<HTMLParagraphElement>('render-error');
const fontNote = byId<HTMLParagraphElement>('font-note');
const renderWarnings = byId<HTMLDetailsElement>('render-warnings');
const renderWarningsSummary = byId<HTMLElement>('render-warnings-summary');
const renderWarningsList = byId<HTMLPreElement>('render-warnings-list');
const downloadLink = byId<HTMLAnchorElement>('download-link');

// User Mode
const jobCard = byId<HTMLElement>('job-card');
const jobProgress = byId<HTMLDivElement>('job-progress');
const jobStage = byId<HTMLParagraphElement>('job-stage');
const jobPercent = byId<HTMLElement>('job-percent');
const jobBar = byId<HTMLProgressElement>('job-bar');
const jobSteps = byId<HTMLOListElement>('job-steps');
const jobDone = byId<HTMLDivElement>('job-done');
const jobNote = byId<HTMLParagraphElement>('job-note');
const jobDownload = byId<HTMLAnchorElement>('job-download');
const jobError = byId<HTMLParagraphElement>('job-error');
const jobReset = byId<HTMLButtonElement>('job-reset');
const uploadNote = byId<HTMLParagraphElement>('upload-note');

// Invite gate
const inviteForm = byId<HTMLFormElement>('invite-form');
const inviteInput = byId<HTMLInputElement>('invite-input');
const inviteSubmit = byId<HTMLButtonElement>('invite-submit');
const inviteError = byId<HTMLParagraphElement>('invite-error');

// ---------------------------------------------------------------------------
// State (all in-memory, browser only)
// ---------------------------------------------------------------------------

let currentFile: File | null = null;
/** The untouched file bytes; PDF.js works on a copy, pdf-lib on these. */
let currentPdfBytes: ArrayBuffer | null = null;
let currentAnalysis: PdfAnalysis | null = null;
let currentLayout: LayoutResult | null = null;
let entries = new Map<string, TranslationEntry>();
let selectedIds = new Set<string>();
let isAnalyzing = false;
let isTranslating = false;
let isGenerating = false;
/** Object URL of the last generated PDF, revoked when replaced or reset. */
let generatedUrl: string | null = null;
let providerLabel = 'OpenAI';

/**
 * One job per selected file. Selecting another file aborts the previous job:
 * its remaining batches are not sent and none of its results reach the UI.
 */
interface Job {
  id: number;
  controller: AbortController;
}
let jobCounter = 0;
let currentJob: Job | null = null;

function startJob(): Job {
  currentJob?.controller.abort();
  currentJob = { id: ++jobCounter, controller: new AbortController() };
  return currentJob;
}

const cache = new TranslationCache();
const client = new TranslateClient(WORKER_URL, undefined, {
  getToken: getSessionToken,
  onUnauthorized: () => lockApp(MSG_SESSION_EXPIRED),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function setText(el: HTMLElement, message: string | null): void {
  if (message === null) {
    el.hidden = true;
    el.textContent = '';
  } else {
    el.hidden = false;
    el.textContent = message;
  }
}

const setStatus = (m: string | null) => setText(statusEl, m);
const setError = (m: string | null) => setText(errorEl, m);
const setTranslateStatus = (m: string | null) => setText(translateStatus, m);
const setTestStatus = (m: string | null) => setText(testStatus, m);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function translationLabel(): string {
  return `${providerLabel} Translation:`;
}

/**
 * Parse the terminology textarea. Accepts either a JSON object or one
 * `english term = 中文` (or `english → 中文`) pair per line.
 */
function parseTerminology(raw: string): { map: Record<string, string>; error: string | null } {
  const text = raw.trim();
  if (!text) return { map: {}, error: null };

  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as unknown;
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { map: {}, error: 'JSON must be an object.' };
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v !== 'string') return { map: {}, error: `Value for "${k}" must be a string.` };
        if (k.trim() && v.trim()) map[k.trim()] = v.trim();
      }
      return { map, error: null };
    } catch (err) {
      return { map: {}, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const map: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^(.+?)\s*(?:=|→|->|:)\s*(.+)$/.exec(t);
    if (!m) return { map: {}, error: `Line ${i + 1}: expected "english term = 中文".` };
    map[m[1].trim()] = m[2].trim();
  }
  return { map, error: null };
}

function currentTerminology(): Record<string, string> | null {
  const { map, error } = parseTerminology(terminologyInput.value);
  setText(terminologyError, error);
  return error ? null : map;
}

function resetResults(): void {
  currentPdfBytes = null;
  currentAnalysis = null;
  currentLayout = null;
  entries = new Map();
  selectedIds = new Set();
  resetExport();
  resultsEl.hidden = true;
  warningEl.hidden = true;
  unsupportedEl.hidden = true;
  toolbar.hidden = true;
  blocksPanel.hidden = true;
  blocksList.replaceChildren();
  blocksToggle.textContent = 'Show Translation Blocks';
  debugPanel.hidden = true;
  debugList.replaceChildren();
  debugToggle.textContent = 'Show Debug Data';

  testSection.hidden = true;
  testList.replaceChildren();
  setTestStatus(null);
  testOkWrapper.hidden = true;
  testOkCheckbox.checked = false;

  fullSection.hidden = true;
  costStats.hidden = true;
  costStatsList.textContent = '';
  translateBtn.disabled = true;
  retryBtn.hidden = true;
  setTranslateStatus(null);
  previewEl.hidden = true;
  previewList.replaceChildren();
  updateSelectionUi();
}

/**
 * Accept a file only if it claims to be a PDF (MIME type or .pdf extension)
 * AND its first bytes contain the "%PDF-" signature.
 */
async function isProbablyPdf(file: File): Promise<boolean> {
  const claimsPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!claimsPdf) return false;
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  return new TextDecoder('latin1').decode(head).includes('%PDF-');
}

// ---------------------------------------------------------------------------
// Worker info
// ---------------------------------------------------------------------------

async function refreshWorkerInfo(): Promise<void> {
  workerInfo.textContent = `Worker endpoint: ${client.endpoint} (checking...)`;
  const health = await client.health();
  if (!health) {
    workerInfo.textContent = `Worker endpoint: ${client.endpoint} — not reachable. Start \`wrangler dev\` in worker/.`;
    return;
  }
  const provider = health.provider ?? 'unknown';
  providerLabel = provider === 'openai' ? 'OpenAI' : provider === 'anthropic' ? 'Claude' : provider;
  workerInfo.textContent =
    `Worker endpoint: ${client.endpoint} · provider: ${provider} · model: ${health.model ?? '?'} · reasoning: ${health.effort ?? '?'}`;
}

// ---------------------------------------------------------------------------
// Invite gate: the Worker checks the code and issues a signed session token.
// This screen is only a convenience; /translate itself rejects requests
// without a valid token, so hiding the gate in the browser unlocks nothing.
// ---------------------------------------------------------------------------

const MSG_INVITE_INVALID = '邀請碼不正確';
const MSG_SESSION_EXPIRED = '登入已過期，請重新輸入邀請碼。';
const MSG_NETWORK = '目前無法連線至翻譯服務，請稍後再試。';

function isLocked(): boolean {
  return document.documentElement.classList.contains('locked');
}

function unlockApp(): void {
  document.documentElement.classList.remove('locked');
  setText(inviteError, null);
  inviteInput.value = '';
  if (DEBUG_MODE) void refreshWorkerInfo();
}

/** Back to the invite screen. Called on any 401; stops the running job so no more batches are sent. */
function lockApp(message: string | null): void {
  clearSession();
  const wasLocked = isLocked();
  document.documentElement.classList.add('locked');
  if (message) setText(inviteError, message);
  if (wasLocked) return;
  if (!DEBUG_MODE) {
    currentJob?.controller.abort();
    currentJob = null;
    resetJobUi();
    fileInfo.hidden = true;
    currentFile = null;
  }
  inviteInput.focus();
}

inviteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitInvite();
});

async function submitInvite(): Promise<void> {
  const code = inviteInput.value.trim();
  if (!code) {
    setText(inviteError, '請輸入邀請碼。');
    inviteInput.focus();
    return;
  }
  inviteSubmit.disabled = true;
  setText(inviteError, null);
  try {
    const result = await client.verifyInvite(code);
    if (result.ok) {
      saveSession(result.token, result.expiresAt);
      unlockApp();
      return;
    }
    setText(inviteError, result.reason === 'invalid' ? MSG_INVITE_INVALID : MSG_NETWORK);
    if (result.reason === 'invalid') inviteInput.select();
  } finally {
    inviteSubmit.disabled = false;
  }
}

/** On load: a stored, unexpired token opens the app; the Worker confirms it in the background. */
async function initSession(): Promise<void> {
  if (!getSessionToken()) {
    clearSession();
    inviteInput.focus();
    return;
  }
  unlockApp();
  if ((await client.checkSession()) === 'invalid') lockApp(MSG_SESSION_EXPIRED);
  // 'unknown' (Worker unreachable): stay unlocked; the first /translate call decides.
}

void initSession();

// ---------------------------------------------------------------------------
// Phase A: file selection
// ---------------------------------------------------------------------------

async function handleFile(file: File | undefined): Promise<void> {
  const job = startJob();
  setError(null);
  setStatus(null);
  resetResults();
  resetJobUi();
  if (!file) return;

  const isPdf = await isProbablyPdf(file);
  if (job !== currentJob) return; // another file was chosen meanwhile
  if (!isPdf) {
    currentFile = null;
    fileInfo.hidden = true;
    analyzeBtn.disabled = true;
    setError(DEBUG_MODE ? `"${file.name}" is not a PDF file. Only application/pdf is accepted.` : '請選擇 PDF 檔案（.pdf）。');
    return;
  }

  currentFile = file;
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatBytes(file.size);
  fileInfo.hidden = false;
  analyzeBtn.disabled = false;

  if (!DEBUG_MODE) void runAutoPipeline(file, job);
}

chooseBtn.addEventListener('click', () => fileInput.click());
jobReset.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click', (event) => {
  if (event.target !== chooseBtn) fileInput.click();
});
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  void handleFile(fileInput.files?.[0]);
  fileInput.value = '';
});
for (const name of ['dragenter', 'dragover'] as const) {
  dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.add('is-dragover');
  });
}
for (const name of ['dragleave', 'dragend'] as const) {
  dropZone.addEventListener(name, () => dropZone.classList.remove('is-dragover'));
}
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('is-dragover');
  void handleFile(event.dataTransfer?.files?.[0]);
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

// ---------------------------------------------------------------------------
// Phase B + C: analysis
// ---------------------------------------------------------------------------

type AnalysisStep = { step: 'read' } | { step: 'extract'; done: number; total: number } | { step: 'layout' };

interface AnalyzedPdf {
  /** Untouched file bytes for pdf-lib. */
  buffer: ArrayBuffer;
  analysis: PdfAnalysis;
  /** Null when the PDF has no selectable text. Includes the translation blocks. */
  layout: LayoutResult | null;
}

/** Shared core: read the file, extract text, analyze layout, build translation blocks. */
async function analyzePdf(file: File, onStep: (s: AnalysisStep) => void): Promise<AnalyzedPdf> {
  onStep({ step: 'read' });
  // extractPdf() hands PDF.js a copy (the worker transfer would detach it);
  // these original bytes are what pdf-lib loads later.
  const buffer = await file.arrayBuffer();
  onStep({ step: 'extract', done: 0, total: 0 });
  const analysis = await extractPdf(buffer, file.name, {
    onProgress: (done, total) => onStep({ step: 'extract', done, total }),
  });

  let layout: LayoutResult | null = null;
  if (analysis.hasSelectableText) {
    onStep({ step: 'layout' });
    await new Promise((r) => requestAnimationFrame(r));
    layout = analyzeLayout(analysis);
    assessOverlay(layout, analysis);
  }
  logAnalysis(analysis, layout);
  return { buffer, analysis, layout };
}

async function runAnalysis(): Promise<void> {
  if (!currentFile || isAnalyzing) return;
  isAnalyzing = true;
  analyzeBtn.disabled = true;
  setError(null);
  resetResults();
  const file = currentFile;

  try {
    const { buffer, analysis, layout } = await analyzePdf(file, (s) => {
      if (s.step === 'read') setStatus('Reading file...');
      else if (s.step === 'extract') setStatus(s.total ? `Extracting text... page ${s.done} / ${s.total}` : 'Extracting text...');
      else setStatus('Analyzing layout...');
    });
    currentPdfBytes = buffer;
    currentAnalysis = analysis;
    currentLayout = layout;

    setStatus(null);
    renderResults(analysis, layout);
    if (layout && layout.stats.translationBlockCount > 0) {
      exportSection.hidden = false;
      updateExportUi();
    }
  } catch (err) {
    console.error('[PDF Analysis] failed', err);
    setStatus(null);
    setError(`Failed to analyze PDF: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    isAnalyzing = false;
    analyzeBtn.disabled = currentFile === null;
  }
}

/** Console debug data, printed in both modes. */
function logAnalysis(analysis: PdfAnalysis, layout: LayoutResult | null): void {
    console.log('[PDF Analysis]', analysis);
    console.log('[PDF Layout]', layout);
    if (layout) {
      console.table(
        layout.blocks.map((b) => ({
          id: b.id,
          page: b.page,
          type: b.type,
          column: b.column,
          x: b.x,
          y: b.y,
          w: b.width,
          h: b.height,
          fs: b.fontSize,
          lines: b.lineCount,
          section: b.sectionType,
          blockType: b.blockType,
          translate: b.translate,
          skip: b.skipReason ?? '',
          text: b.text.slice(0, 60),
        })),
      );
    }
    const w = window as unknown as { __pdfDebug: PdfAnalysis; __pdfLayout: LayoutResult | null };
    w.__pdfDebug = analysis;
    w.__pdfLayout = layout;
}

analyzeBtn.addEventListener('click', () => void runAnalysis());

function describeLayout(layout: LayoutResult): string {
  const { twoColumnPages, singleColumnPages } = layout.stats;
  if (twoColumnPages === 0) return 'Single Column';
  if (singleColumnPages === 0) return 'Two Columns';
  const twoCol = layout.pages.filter((p) => p.layout === 'TWO_COLUMN').map((p) => p.pageNumber);
  return `Two Columns on ${twoColumnPages} page(s) [${twoCol.slice(0, 12).join(', ')}${twoCol.length > 12 ? ', …' : ''}], Single on ${singleColumnPages}`;
}

function renderResults(analysis: PdfAnalysis, layout: LayoutResult | null): void {
  resFile.textContent = analysis.fileName;
  resPages.textContent = String(analysis.pageCount);
  resItems.textContent = String(analysis.textItemCount);
  resSelectable.textContent = analysis.hasSelectableText ? 'Yes' : 'No';
  resultsEl.hidden = false;

  if (!analysis.hasSelectableText || !layout) {
    resLayout.textContent = '–';
    resBodyFont.textContent = '–';
    resBlocks.textContent = '0';
    resTranslationBlocks.textContent = '0';
    unsupportedEl.hidden = false;
    return;
  }

  if (analysis.suspiciousRatio > 0.2) {
    setText(
      warningEl,
      `${analysis.suspiciousItemCount} text items look unreadable (for example "(cid:123)"). Translation quality will suffer.`,
    );
  }

  resLayout.textContent = describeLayout(layout);
  resBodyFont.textContent = `${layout.bodyFontSize} pt`;
  resBlocks.textContent = String(layout.stats.blockCount);
  resTranslationBlocks.textContent =
    `${layout.stats.translationBlockCount}` +
    ` (${layout.stats.mergedBlockCount} merged across column/page breaks, ${layout.stats.incompleteBlockCount} still incomplete)`;
  const st = layout.stats;
  resContext.textContent =
    `${st.inputChars.toLocaleString()} input chars · ${st.contextChars.toLocaleString()} context chars on ` +
    `${st.contextUnitCount} unit(s) (incomplete / merged / continuation only) · ${st.contextCharsSaved.toLocaleString()} context chars saved vs. sending 300 chars both ways for every unit`;
  debugLimitEl.textContent = String(Math.min(DEBUG_ITEM_LIMIT, analysis.textItemCount));
  toolbar.hidden = false;

  if (layout.stats.translationBlockCount > 0) {
    testSection.hidden = false;
    fullSection.hidden = false;
    translateBtn.disabled = true; // unlocked by the test checkbox
  }
  updateSelectionUi();
}

// ---------------------------------------------------------------------------
// Selection for Translation Test Mode
// ---------------------------------------------------------------------------

function selectedBlocks(): TranslationBlock[] {
  if (!currentLayout) return [];
  return currentLayout.translationBlocks.filter((b) => selectedIds.has(b.id));
}

function updateSelectionUi(): void {
  const n = selectedIds.size;
  selectionInfo.textContent = `${n} block(s) selected (choose ${TEST_MIN_BLOCKS}–${TEST_MAX_BLOCKS})`;
  testBtn.disabled = isTranslating || n < TEST_MIN_BLOCKS || n > TEST_MAX_BLOCKS;
  testBtn.textContent = `Test Translation (${n})`;
  for (const box of blocksList.querySelectorAll<HTMLInputElement>('input.pick')) {
    box.checked = selectedIds.has(box.value);
  }
}

function toggleSelection(id: string, on: boolean): void {
  if (on) selectedIds.add(id);
  else selectedIds.delete(id);
  updateSelectionUi();
}

/** Pick a representative sample: title, a heading, a caption, a footnote, then body text from different pages. */
function pickSample(): void {
  if (!currentLayout) return;
  const blocks = currentLayout.translationBlocks;
  const picked: string[] = [];
  const takeFirst = (type: TranslationBlock['type']) => {
    const b = blocks.find((x) => x.type === type && !picked.includes(x.id));
    if (b) picked.push(b.id);
  };
  takeFirst('TITLE');
  takeFirst('HEADING');
  takeFirst('CAPTION');
  takeFirst('FOOTNOTE');

  const bodies = blocks.filter((b) => b.type === 'BODY' && b.text.length >= 120);
  const seenPages = new Set<number>();
  for (const b of bodies) {
    if (picked.length >= SAMPLE_SIZE) break;
    if (seenPages.has(b.page)) continue;
    picked.push(b.id);
    seenPages.add(b.page);
  }
  for (const b of bodies) {
    if (picked.length >= SAMPLE_SIZE) break;
    if (!picked.includes(b.id)) picked.push(b.id);
  }

  selectedIds = new Set(picked.slice(0, TEST_MAX_BLOCKS));
  updateSelectionUi();
  if (blocksPanel.hidden) {
    blocksOnlyTranslate.checked = true;
    renderBlockCards(currentLayout);
    blocksPanel.hidden = false;
    blocksToggle.textContent = 'Hide Translation Blocks';
  }
}

pickSampleBtn.addEventListener('click', pickSample);

/**
 * Units of the abstract: from the first block on page 1–2 that starts with
 * "Abstract" up to (not including) the next heading, at most `limit` units.
 * Shared by the translation test and the "Abstract only" render range.
 */
function findAbstractUnits(layout: LayoutResult, limit: number): { ids: string[]; error: string | null; startId: string | null } {
  const blocks = layout.blocks;
  const start = blocks.findIndex((b) => b.page <= 2 && /^abstract\b/i.test(b.text));
  if (start < 0) {
    return { ids: [], error: 'No block starting with "Abstract" was found on pages 1–2. Pick blocks manually.', startId: null };
  }

  const unitBySource = new Map<string, string>();
  for (const unit of layout.translationBlocks) {
    for (const src of unit.sourceBlockIds) unitBySource.set(src, unit.id);
  }

  const picked: string[] = [];
  for (let i = start; i < blocks.length; i++) {
    const b = blocks[i];
    if (i > start && (b.type === 'HEADING' || b.type === 'TITLE')) break;
    if (b.page > blocks[start].page + 1) break;
    if (b.type === 'HEADER' || b.type === 'FOOTER') continue;
    if (!b.translate) continue;
    const unitId = unitBySource.get(b.id);
    if (!unitId) continue;
    if (!picked.includes(unitId)) picked.push(unitId);
    if (picked.length >= limit) break;
  }

  // The "Abstract" line may itself be a heading whose body follows as the next block.
  const startBlock = blocks[start];
  if (picked.length === 0 && startBlock.type === 'HEADING') {
    return { ids: [], error: 'Found the Abstract heading but no translatable body after it.', startId: startBlock.id };
  }
  return { ids: picked, error: null, startId: startBlock.id };
}

function pickAbstract(): void {
  if (!currentLayout) return;
  const { ids: picked, error, startId } = findAbstractUnits(currentLayout, TEST_MAX_BLOCKS);
  if (error) {
    setTestStatus(error);
    return;
  }

  selectedIds = new Set(picked);
  updateSelectionUi();
  setTestStatus(`Selected ${picked.length} unit(s) for the Abstract (from ${startId}).`);
  if (blocksPanel.hidden) {
    blocksOnlyTranslate.checked = true;
    renderBlockCards(currentLayout);
    blocksPanel.hidden = false;
    blocksToggle.textContent = 'Hide Translation Blocks';
  }
}

pickAbstractBtn.addEventListener('click', pickAbstract);
clearSelectionBtn.addEventListener('click', () => {
  selectedIds = new Set();
  updateSelectionUi();
});

// ---------------------------------------------------------------------------
// Translation Test Mode
// ---------------------------------------------------------------------------

type TranslateAllOptions = Omit<TranslateBlocksOptions, 'client' | 'cache' | 'targetLanguage'>;

/** Shared core: the translation pipeline (cache, batches, context, retries) for any set of units. */
async function translateAll(
  blocks: TranslationBlock[],
  into: Map<string, TranslationEntry>,
  options: TranslateAllOptions,
): Promise<TranslationStats> {
  const stats = await translateBlocks(blocks, into, {
    client,
    cache,
    targetLanguage: TARGET_LANGUAGE,
    documentOrder: currentLayout?.translationBlocks,
    ...options,
  });
  const w = window as unknown as { __translations: Record<string, TranslationEntry>; __translationStats: TranslationStats };
  w.__translations = Object.fromEntries(into);
  w.__translationStats = stats;
  renderCostStats(stats);
  return stats;
}

/** Developer Mode: requests, chars and tokens of the last translation run. */
function renderCostStats(s: TranslationStats): void {
  const u = s.usage;
  const currentInput = u ? u.inputTokens : s.estimatedInputTokens;
  const saved = s.baselineEstimatedInputTokens - currentInput;
  const pct = s.baselineEstimatedInputTokens > 0 ? Math.round((saved / s.baselineEstimatedInputTokens) * 100) : 0;
  const lines = [
    `API requests:            ${s.requests}  (provider calls ${s.providerCalls}, retry requests ${s.retryRequests})`,
    `translated blocks:       ${s.translatedBlocks}`,
    `cache hits:              ${s.cachedBlocks}`,
    `skipped blocks (no API): ${s.skippedBlocks}`,
    `failed blocks:           ${s.failedBlocks}`,
    `input chars:             ${s.inputChars.toLocaleString()}`,
    `context chars:           ${s.contextChars.toLocaleString()} sent on ${s.extraContextBlocks} block(s)  (assigned ${s.contextCharsAssigned.toLocaleString()}, dropped inside batches ${(s.contextCharsAssigned - s.contextChars).toLocaleString()})`,
    `estimated input tokens:  ${s.estimatedInputTokens.toLocaleString()}`,
    `estimated output tokens: ${s.estimatedOutputTokens.toLocaleString()}`,
    `total estimated tokens:  ${(s.estimatedInputTokens + s.estimatedOutputTokens).toLocaleString()}`,
    `retry tokens:            ${s.retryTokens.toLocaleString()} (${u ? 'API usage' : 'estimated'})`,
    u
      ? `API usage:               input ${u.inputTokens.toLocaleString()} (cached ${u.cachedInputTokens.toLocaleString()}) · output ${u.outputTokens.toLocaleString()} · total ${(u.inputTokens + u.outputTokens).toLocaleString()}`
      : 'API usage:               not reported by the Worker',
    '',
    `Before optimization estimate: ${s.baselineEstimatedInputTokens.toLocaleString()} input tokens (${s.baselineRequests} requests, 15 blocks / 12k chars, full prompt, 150-char contexts)`,
    `Current:                      ${currentInput.toLocaleString()} input tokens (${u ? 'API usage' : 'estimate'}, ${s.requests} requests)`,
    `Saved:                        ${saved.toLocaleString()} tokens (${pct}%)`,
    `translation time:             ${(s.durationMs / 1000).toFixed(1)}s`,
  ];
  costStatsList.textContent = lines.join('\n');
  costStats.hidden = false;
}

async function runTest(): Promise<void> {
  if (!currentLayout || isTranslating) return;
  const blocks = selectedBlocks();
  if (blocks.length < TEST_MIN_BLOCKS || blocks.length > TEST_MAX_BLOCKS) return;
  const terminology = currentTerminology();
  if (terminology === null) return;

  isTranslating = true;
  updateSelectionUi();
  testOkWrapper.hidden = true;
  testOkCheckbox.checked = false;
  translateBtn.disabled = true;
  setError(null);

  renderTestPanel(blocks);
  setTestStatus(`Translating ${blocks.length} test block(s) with ${providerLabel}...`);
  const started = performance.now();

  try {
    await translateAll(blocks, entries, {
      terminology,
      maxBlocksPerBatch: TEST_MAX_BLOCKS,
      concurrency: 1,
      onProgress: (p) => setTestStatus(`${p.message}  (${p.blocksDone} / ${p.blocksTotal})`),
      onEntry: (entry) => {
        updateTestEntry(entry);
        updateBlockCardEntry(entry);
      },
    });
  } finally {
    isTranslating = false;
    updateSelectionUi();
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const failed = blocks.filter((b) => entries.get(b.id)?.status === 'failed').length;
    if (failed === 0) {
      setTestStatus(`Test finished in ${seconds}s. Review the translations below, then confirm to unlock the full translation.`);
      testOkWrapper.hidden = false;
    } else {
      setTestStatus(`Test finished in ${seconds}s with ${failed} failed block(s). Fix the Worker/provider before running the full PDF.`);
    }
    console.log('[Translation Test]', blocks.map((b) => ({ id: b.id, entry: entries.get(b.id) })));
    updateExportUi();
  }
}

testBtn.addEventListener('click', () => void runTest());

testOkCheckbox.addEventListener('change', () => {
  translateBtn.disabled = !testOkCheckbox.checked || isTranslating;
});

function renderTestPanel(blocks: TranslationBlock[]): void {
  const fragment = document.createDocumentFragment();
  for (const block of blocks) {
    const card = el('article', 'preview-item');
    card.dataset.id = block.id;
    const head = el('div', 'preview-head');
    head.appendChild(el('span', 'tag', `Page ${block.page}`));
    head.appendChild(el('span', `tag tag-type tag-${block.type.toLowerCase()}`, block.type));
    head.appendChild(el('span', 'tag tag-id', block.id));
    head.appendChild(el('span', 'tag tag-status', entries.get(block.id)?.status ?? 'pending'));
    card.appendChild(head);
    appendUnitMeta(card, block, null);
    card.appendChild(el('div', 'label', 'Original:'));
    card.appendChild(el('p', 'original', block.text));
    card.appendChild(el('div', 'label', translationLabel()));
    card.appendChild(el('p', 'translation zh muted', 'Waiting…'));
    fragment.appendChild(card);
  }
  testList.replaceChildren(fragment);
}

function applyEntryToCard(card: HTMLElement | null, entry: TranslationEntry): void {
  if (!card) return;
  const status = card.querySelector<HTMLElement>('.tag-status');
  const translation = card.querySelector<HTMLElement>('.translation');
  if (status) {
    status.textContent = entry.status;
    status.dataset.status = entry.status;
  }
  if (!translation) return;
  if (entry.status === 'done' || entry.status === 'cached') {
    translation.textContent = entry.translation ?? '';
    translation.classList.remove('muted', 'error-text');
  } else if (entry.status === 'failed') {
    translation.textContent = `Failed: ${entry.error ?? 'unknown error'}`;
    translation.classList.remove('muted');
    translation.classList.add('error-text');
  } else {
    translation.textContent = entry.status === 'translating' ? 'Translating…' : 'Waiting…';
    translation.classList.add('muted');
  }
}

function updateTestEntry(entry: TranslationEntry): void {
  applyEntryToCard(testList.querySelector<HTMLElement>(`[data-id="${entry.id}"]`), entry);
}

// ---------------------------------------------------------------------------
// Full translation (unlocked after the test)
// ---------------------------------------------------------------------------

async function runTranslation(blocks: TranslationBlock[]): Promise<void> {
  if (!currentLayout || isTranslating || blocks.length === 0) return;
  if (!testOkCheckbox.checked) {
    setError('Run a translation test and confirm the quality before translating the full PDF.');
    return;
  }
  const terminology = currentTerminology();
  if (terminology === null) return;

  isTranslating = true;
  translateBtn.disabled = true;
  retryBtn.hidden = true;
  updateSelectionUi();
  setError(null);

  previewEl.hidden = false;
  renderPreview(currentLayout);

  try {
    await translateAll(blocks, entries, {
      terminology,
      onProgress: (p) => {
        setTranslateStatus(`${p.message}  (${p.blocksDone} / ${p.blocksTotal} blocks${p.blocksFailed ? `, ${p.blocksFailed} failed` : ''})`);
      },
      onEntry: (entry) => {
        updatePreviewEntry(entry);
        updateBlockCardEntry(entry);
      },
    });
  } finally {
    isTranslating = false;
    translateBtn.disabled = !testOkCheckbox.checked;
    updateSelectionUi();
    const failed = [...entries.values()].filter((e) => e.status === 'failed').length;
    retryBtn.hidden = failed === 0;
    if (failed > 0) retryBtn.textContent = `Retry Failed (${failed})`;
    renderPreviewSummary();
    console.log('[Translation]', Object.fromEntries(entries));
    updateExportUi();
  }
}

translateBtn.addEventListener('click', () => {
  if (!currentLayout) return;
  void runTranslation(currentLayout.translationBlocks);
});

retryBtn.addEventListener('click', () => {
  if (!currentLayout) return;
  const failedIds = new Set([...entries.values()].filter((e) => e.status === 'failed').map((e) => e.id));
  void runTranslation(currentLayout.translationBlocks.filter((b) => failedIds.has(b.id)));
});

// ---------------------------------------------------------------------------
// Rendering: translation preview
// ---------------------------------------------------------------------------

function renderPreview(layout: LayoutResult): void {
  const fragment = document.createDocumentFragment();
  for (const block of layout.translationBlocks) {
    const card = el('article', 'preview-item');
    card.dataset.id = block.id;

    const head = el('div', 'preview-head');
    head.appendChild(el('span', 'tag', `Page ${block.page}`));
    head.appendChild(el('span', `tag tag-type tag-${block.type.toLowerCase()}`, block.type));
    head.appendChild(el('span', 'tag tag-id', block.id));
    head.appendChild(el('span', 'tag tag-status', entries.get(block.id)?.status ?? 'pending'));
    card.appendChild(head);
    appendUnitMeta(card, block, null);

    card.appendChild(el('div', 'label', 'Original:'));
    card.appendChild(el('p', 'original', block.text));
    card.appendChild(el('div', 'label', translationLabel()));
    card.appendChild(el('p', 'translation zh muted', 'Waiting…'));
    fragment.appendChild(card);
  }
  previewList.replaceChildren(fragment);
  for (const entry of entries.values()) updatePreviewEntry(entry);
  renderPreviewSummary();
}

function updatePreviewEntry(entry: TranslationEntry): void {
  applyEntryToCard(previewList.querySelector<HTMLElement>(`[data-id="${entry.id}"]`), entry);
}

function renderPreviewSummary(): void {
  if (!currentLayout) return;
  const total = currentLayout.translationBlocks.length;
  let done = 0;
  let failed = 0;
  let skipped = 0;
  for (const e of entries.values()) {
    if (e.status === 'done' || e.status === 'cached') done++;
    else if (e.status === 'failed') failed++;
    else if (e.status === 'skipped') skipped++;
  }
  previewSummary.textContent =
    `${done} / ${total} blocks translated${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} kept as is (no API call)` : ''}. Cache entries: ${cache.size}.`;
}

// ---------------------------------------------------------------------------
// Rendering: translation blocks (debug + selection)
// ---------------------------------------------------------------------------

/**
 * One card per translation unit (a merged unit shows all its source blocks),
 * plus one card per skipped layout block when "only translatable" is off.
 */
function renderBlockCards(layout: LayoutResult): void {
  const onlyTranslate = blocksOnlyTranslate.checked;
  const unitBySource = new Map<string, TranslationBlock>();
  for (const unit of layout.translationBlocks) {
    for (const src of unit.sourceBlockIds) unitBySource.set(src, unit);
  }
  const blockById = new Map(layout.blocks.map((b) => [b.id, b]));
  const rendered = new Set<string>();
  const fragment = document.createDocumentFragment();

  for (const block of layout.blocks) {
    const unit = unitBySource.get(block.id);
    if (unit) {
      if (rendered.has(unit.id)) continue;
      rendered.add(unit.id);
      const sources = unit.sourceBlockIds.map((id) => blockById.get(id)).filter((b): b is TextBlock => !!b);
      fragment.appendChild(makeUnitCard(unit, sources));
    } else if (!onlyTranslate) {
      fragment.appendChild(makeSkippedCard(block));
    }
  }
  blocksList.replaceChildren(fragment);
  for (const entry of entries.values()) updateBlockCardEntry(entry);
  updateSelectionUi();
}

function geometryLine(block: TextBlock): string {
  return (
    `${block.id}  page ${block.page}  ${block.column}  x: ${block.x}  y: ${block.y}  width: ${block.width}  height: ${block.height}  top: ${block.top}\n` +
    `    fontSize: ${block.fontSize}  lines: ${block.lineCount}  font: ${block.fontRealName ?? block.fontName}\n` +
    `    sectionType=${block.sectionType}  blockType=${block.blockType}  translationEligible=${block.translate}  skipReason=${block.skipReason ?? '—'}`
  );
}

/** Tags + collapsible details shared by the block, test and preview cards. */
function appendUnitMeta(card: HTMLElement, unit: TranslationBlock, sources: TextBlock[] | null): void {
  const head = card.querySelector('.preview-head');
  if (head) {
    if (unit.wasMerged) head.appendChild(el('span', 'tag tag-merged', `merged ×${unit.sourceBlockIds.length}`));
    if (unit.incompleteSource) head.appendChild(el('span', 'tag tag-incomplete', 'incomplete source'));
    if (unit.pages.length > 1) head.appendChild(el('span', 'tag', `pages ${unit.pages.join('–')}`));
    if (unit.overlayEligible === true) head.appendChild(el('span', 'tag tag-overlay', 'overlay'));
    else if (unit.overlayEligible === false) head.appendChild(el('span', 'tag tag-no-overlay', `no overlay: ${unit.overlaySkippedReason}`));
  }

  const details = el('details', 'unit-details');
  details.appendChild(el('summary', undefined, `sourceBlockIds: ${unit.sourceBlockIds.join(', ')}`));
  const lines: string[] = [
    `sectionType:      ${unit.sectionType}`,
    `blockType:        ${unit.blockType}`,
    `translationEligible: true`,
    `wasMerged:        ${unit.wasMerged}`,
    `incompleteSource: ${unit.incompleteSource}`,
    `mergeReason:      ${unit.mergeReason ?? '—'}`,
    `contextReason:    ${unit.contextReason ?? '— (no extra context sent)'}`,
    `overlayEligible:  ${unit.overlayEligible ?? '—'}`,
    `overlaySkippedReason: ${unit.overlaySkippedReason ?? '—'}`,
  ];
  if (sources) {
    lines.push('', 'source blocks:');
    for (const s of sources) lines.push(geometryLine(s));
  }
  lines.push('', `previousContext:  ${unit.previousContext ?? '—'}`, '', `nextContext:      ${unit.nextContext ?? '—'}`);
  details.appendChild(el('pre', 'block-geom', lines.join('\n')));
  card.appendChild(details);
}

function makeUnitCard(unit: TranslationBlock, sources: TextBlock[]): HTMLElement {
  const card = el('article', 'block-item');
  card.dataset.id = unit.id;

  const head = el('div', 'preview-head');
  const pick = el('label', 'pick-label');
  const box = el('input', 'pick') as HTMLInputElement;
  box.type = 'checkbox';
  box.value = unit.id;
  box.checked = selectedIds.has(unit.id);
  box.addEventListener('change', () => toggleSelection(unit.id, box.checked));
  pick.appendChild(box);
  pick.appendChild(document.createTextNode(' test'));
  head.appendChild(pick);
  head.appendChild(el('span', 'tag tag-id', unit.id));
  head.appendChild(el('span', 'tag', `Page ${unit.page}`));
  head.appendChild(el('span', `tag tag-type tag-${unit.type.toLowerCase()}`, unit.type));
  if (unit.blockType !== unit.type) head.appendChild(el('span', 'tag', unit.blockType));
  if (unit.sectionType !== 'MAIN') head.appendChild(el('span', 'tag', unit.sectionType));
  head.appendChild(el('span', 'tag', sources[0]?.column ?? ''));
  head.appendChild(el('span', 'tag tag-yes', 'translate'));
  card.appendChild(head);

  appendUnitMeta(card, unit, sources);
  card.appendChild(el('div', 'label', 'Original:'));
  card.appendChild(el('p', 'original', unit.text));
  card.appendChild(el('div', 'label', translationLabel()));
  card.appendChild(el('p', 'translation zh muted', '—'));
  return card;
}

function makeSkippedCard(block: TextBlock): HTMLElement {
  const card = el('article', 'block-item is-skipped');
  card.dataset.id = block.id;
  const head = el('div', 'preview-head');
  head.appendChild(el('span', 'tag tag-id', block.id));
  head.appendChild(el('span', 'tag', `Page ${block.page}`));
  head.appendChild(el('span', `tag tag-type tag-${block.type.toLowerCase()}`, block.type));
  if (block.blockType !== block.type) head.appendChild(el('span', 'tag', block.blockType));
  if (block.sectionType !== 'MAIN') head.appendChild(el('span', 'tag', block.sectionType));
  head.appendChild(el('span', 'tag', block.column));
  head.appendChild(el('span', 'tag tag-no', `skip: ${block.skipReason}`));
  card.appendChild(head);
  card.appendChild(el('pre', 'block-geom', geometryLine(block)));
  card.appendChild(el('div', 'label', 'Original:'));
  card.appendChild(el('p', 'original', block.text));
  return card;
}

function updateBlockCardEntry(entry: TranslationEntry): void {
  const card = blocksList.querySelector<HTMLElement>(`[data-id="${entry.id}"]`);
  const translation = card?.querySelector<HTMLElement>('.translation');
  if (!translation) return;
  if (entry.status === 'done' || entry.status === 'cached') {
    translation.textContent = entry.translation ?? '';
    translation.classList.remove('muted', 'error-text');
  } else if (entry.status === 'failed') {
    translation.textContent = `Failed: ${entry.error ?? 'unknown error'}`;
    translation.classList.remove('muted');
    translation.classList.add('error-text');
  } else {
    translation.textContent = entry.status;
    translation.classList.add('muted');
  }
}

blocksToggle.addEventListener('click', () => {
  if (!currentLayout) return;
  const willShow = blocksPanel.hidden;
  if (willShow) renderBlockCards(currentLayout);
  blocksPanel.hidden = !willShow;
  blocksToggle.textContent = willShow ? 'Hide Translation Blocks' : 'Show Translation Blocks';
});

blocksOnlyTranslate.addEventListener('change', () => {
  if (currentLayout && !blocksPanel.hidden) renderBlockCards(currentLayout);
});

// ---------------------------------------------------------------------------
// Rendering: raw text items (Phase B debug)
// ---------------------------------------------------------------------------

function renderDebugItems(items: TextItemDebug[]): void {
  const fragment = document.createDocumentFragment();
  items.slice(0, DEBUG_ITEM_LIMIT).forEach((item, index) => {
    const card = el('article', 'debug-item');
    card.appendChild(el('h3', undefined, `#${index + 1}  Page ${item.page}`));
    card.appendChild(
      el(
        'pre',
        undefined,
        [
          `Text:      ${JSON.stringify(item.text)}`,
          `x:         ${item.x}`,
          `y:         ${item.y}`,
          `width:     ${item.width}`,
          `height:    ${item.height}`,
          `fontSize:  ${item.fontSize}`,
          `fontName:  ${item.fontName}${item.fontRealName ? ` (${item.fontRealName})` : item.fontFamily ? ` (${item.fontFamily})` : ''}`,
          `hasEOL:    ${item.hasEOL}`,
          `transform: [${item.transform.join(', ')}]`,
        ].join('\n'),
      ),
    );
    fragment.appendChild(card);
  });
  debugList.replaceChildren(fragment);
}

debugToggle.addEventListener('click', () => {
  if (!currentAnalysis) return;
  const willShow = debugPanel.hidden;
  if (willShow && debugList.childElementCount === 0) renderDebugItems(currentAnalysis.items);
  debugPanel.hidden = !willShow;
  debugToggle.textContent = willShow ? 'Hide Debug Data' : 'Show Debug Data';
});

// ---------------------------------------------------------------------------
// Phase D–F: PDF export (pdf-lib overlay)
// ---------------------------------------------------------------------------

type RenderRange = 'page1' | 'first3' | 'abstract' | 'full';

function translatedUnitCount(): number {
  if (!currentLayout) return 0;
  let n = 0;
  for (const unit of currentLayout.translationBlocks) {
    const e = entries.get(unit.id);
    if (e && (e.status === 'done' || e.status === 'cached') && e.translation) n++;
  }
  return n;
}

function resetExport(): void {
  if (generatedUrl) {
    URL.revokeObjectURL(generatedUrl);
    generatedUrl = null;
  }
  exportSection.hidden = true;
  downloadLink.hidden = true;
  downloadLink.removeAttribute('href');
  renderProgress.hidden = true;
  renderProgress.value = 0;
  renderWarnings.hidden = true;
  renderWarningsList.textContent = '';
  setText(renderStatus, null);
  setText(renderError, null);
  generateBtn.disabled = true;
  (window as unknown as { __pdfRender?: unknown }).__pdfRender = undefined;
}

/** Enable the button when there is something to render; explain what will happen. */
function updateExportUi(): void {
  if (!currentLayout || !currentAnalysis) {
    generateBtn.disabled = true;
    return;
  }
  const units = currentLayout.translationBlocks;
  const eligible = units.filter((u) => u.overlayEligible).length;
  const translated = translatedUnitCount();
  const debug = renderDebug.checked;
  const bilingual = currentExportMode() === 'bilingual';
  generateBtn.textContent = debug
    ? `Generate Debug PDF (${bilingual ? 'spreads with boxes' : 'bounding boxes'})`
    : bilingual
      ? 'Generate Bilingual PDF'
      : 'Generate Translated PDF';
  generateBtn.disabled = isGenerating || (!debug && translated === 0);
  exportSummary.textContent =
    `${translated} / ${units.length} units translated · ${eligible} units eligible for overlay ` +
    `(TITLE / HEADING / BODY / CAPTION / FOOTNOTE / TABLE without image overlap) · fonts: ${FONT_SOURCES.cjk.label} for Chinese, ` +
    `${FONT_SOURCES.latin.label} for Latin/digits, ${FONT_SOURCES.symbol.label} for symbols, fallback ${FONT_SOURCES.fallback.label}` +
    (bilingual
      ? ' · each output page = [ original page | translated page ], same height, double width'
      : ' · original pages are rewritten in place') +
    (debug
      ? ' · debug mode draws boxes only, nothing is masked'
      : translated === 0
        ? ' · run a translation test or the full translation first'
        : '');
}

function currentExportMode(): RenderOutput {
  return exportMode.value === 'translated' ? 'translated' : 'bilingual';
}

function rangeToPages(range: RenderRange): { pages: Set<number> | null; unitIds: Set<string> | null; label: string } {
  if (!currentLayout || !currentAnalysis) return { pages: new Set([1]), unitIds: null, label: 'page 1' };
  const pageCount = currentAnalysis.pageCount;
  switch (range) {
    case 'page1':
      return { pages: new Set([1]), unitIds: null, label: 'page 1' };
    case 'first3':
      return {
        pages: new Set([1, 2, 3].filter((p) => p <= pageCount)),
        unitIds: null,
        label: `first ${Math.min(3, pageCount)} pages`,
      };
    case 'abstract': {
      const { ids } = findAbstractUnits(currentLayout, 50);
      const unitById = new Map(currentLayout.translationBlocks.map((u) => [u.id, u]));
      const pages = new Set<number>();
      for (const id of ids) for (const p of unitById.get(id)?.pages ?? []) pages.add(p);
      return { pages: pages.size ? pages : new Set([1]), unitIds: new Set(ids), label: `abstract (${ids.length} units)` };
    }
    default:
      return { pages: null, unitIds: null, label: `all ${pageCount} pages` };
  }
}

function showRenderWarnings(result: RenderResult): void {
  const skipped = result.reports.filter((r) => r.skipped);
  const lines: string[] = [];
  for (const w of result.warnings) {
    lines.push(
      `${w.unitId}  page ${w.page}  ${w.type}  reason=${w.reason}  fontSize ${w.fontSize} → ${w.finalFontSize}  lines=${w.lines}` +
        (w.message ? `\n    ${w.message}` : ''),
    );
  }
  if (skipped.length) {
    lines.push('', `skipped units (${skipped.length}):`);
    const byReason = new Map<string, string[]>();
    for (const s of skipped) {
      const key = s.reason ?? '?';
      const list = byReason.get(key) ?? [];
      list.push(s.unitId);
      byReason.set(key, list);
    }
    for (const [reason, ids] of byReason) {
      lines.push(`  ${reason}: ${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ` … (+${ids.length - 20})` : ''}`);
    }
  }
  renderWarningsSummary.textContent = `${result.warnings.length} layout warning(s), ${skipped.length} skipped unit(s)`;
  renderWarningsList.textContent = lines.join('\n') || 'none';
  renderWarnings.hidden = false;
}

interface BuildPdfOptions {
  pdf: AnalyzedPdf & { layout: LayoutResult };
  fileName: string;
  entries: Map<string, TranslationEntry>;
  mode: RenderMode;
  output: RenderOutput;
  pages: Set<number> | null;
  unitIds: Set<string> | null;
  onStatus: (message: string) => void;
  onProgress: (p: RenderProgress) => void;
}

interface BuiltPdf {
  result: RenderResult;
  /** Object URL of the PDF Blob; the caller owns (and revokes) it. */
  url: string;
  size: number;
  fontNotes: string[];
}

/** Shared core: load fonts, run the pdf-lib overlay / side-by-side export, wrap the bytes in a Blob URL. */
async function buildPdf(o: BuildPdfOptions): Promise<BuiltPdf> {
  let fonts: FontSetBytes | null = null;
  if (o.mode === 'overlay') {
    o.onStatus('Loading fonts...');
    fonts = await loadFontSet(o.onStatus);
  }
  o.onStatus('Preparing PDF...');
  const result = await generateTranslatedPdf({
    pdfBytes: o.pdf.buffer,
    fileName: o.fileName,
    analysis: o.pdf.analysis,
    layout: o.pdf.layout,
    entries: o.entries,
    mode: o.mode,
    output: o.output,
    pages: o.pages,
    unitIds: o.unitIds,
    fonts,
    onProgress: o.onProgress,
  });
  // The Blob copies the bytes; the Uint8Array is dropped with `result`.
  const blob = new Blob([result.bytes as BlobPart], { type: 'application/pdf' });
  (window as unknown as { __pdfRender: unknown }).__pdfRender = { reports: result.reports, warnings: result.warnings, stats: result.stats };
  console.log('[PDF Render] done', { mode: o.mode, output: o.output, stats: result.stats, warnings: result.warnings });
  return { result, url: URL.createObjectURL(blob), size: blob.size, fontNotes: fonts?.notes ?? [] };
}

async function runGenerate(): Promise<void> {
  if (!currentLayout || !currentAnalysis || !currentPdfBytes || !currentFile || isGenerating) return;
  const mode: RenderMode = renderDebug.checked ? 'debug' : 'overlay';
  const output = currentExportMode();
  const range = renderRange.value as RenderRange;
  const { pages, unitIds, label } = rangeToPages(range);

  isGenerating = true;
  updateExportUi();
  setText(renderError, null);
  downloadLink.hidden = true;
  renderWarnings.hidden = true;
  if (generatedUrl) {
    URL.revokeObjectURL(generatedUrl);
    generatedUrl = null;
  }
  renderProgress.hidden = false;
  renderProgress.value = 0;
  const started = performance.now();

  try {
    const built = await buildPdf({
      pdf: { buffer: currentPdfBytes, analysis: currentAnalysis, layout: currentLayout },
      fileName: currentFile.name,
      entries,
      mode,
      output,
      pages,
      unitIds,
      onStatus: (message) => setText(renderStatus, message),
      onProgress: (p) => {
        renderProgress.value = p.percent;
        setText(renderStatus, `${p.stage}  Page ${p.page} / ${p.pageCount}  ${p.percent}%`);
      },
    });
    const { result } = built;
    if (mode === 'overlay') setText(fontNote, built.fontNotes.length ? built.fontNotes.join('\n') : null);

    generatedUrl = built.url;
    downloadLink.href = generatedUrl;
    downloadLink.download = result.fileName;
    downloadLink.textContent = `Download ${result.fileName} (${formatBytes(built.size)})`;
    downloadLink.hidden = false;

    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const s = result.stats;
    const pagesWord = output === 'bilingual' ? 'spread(s)' : 'page(s)';
    setText(
      renderStatus,
      mode === 'debug'
        ? `Debug PDF ready (${label}): ${s.pagesRendered} ${pagesWord} with bounding boxes in ${seconds}s. ` +
            'Red = eligible block, blue = its lines, grey dashed = translated but not overlaid, green dashed = image' +
            (output === 'bilingual' ? '; boxes are drawn on the right half only.' : '.')
        : `Done (${label}, ${output === 'bilingual' ? 'side-by-side' : 'translated only'}) in ${seconds}s: ` +
            `${s.pagesRendered} ${pagesWord}, ${s.unitsWritten} unit(s) written, ${s.masksDrawn} lines masked, ` +
            `${s.unitsSkipped} unit(s) skipped, ${result.warnings.length} layout warning(s)` +
            (s.replacedChars ? `, ${s.replacedChars} character(s) not in any font` : '') +
            `. Fonts: ${result.fonts}; fallback glyphs: ${s.fontFallbackCount}.`,
    );
    showRenderWarnings(result);
  } catch (err) {
    console.error('[PDF Render] failed', err);
    const message =
      err instanceof RenderError || err instanceof FontLoadError
        ? err.message
        : err instanceof RangeError
          ? `The browser ran out of memory (${err.message}). Try a smaller page range.`
          : err instanceof Error
            ? err.message
            : String(err);
    setText(renderStatus, null);
    setText(renderError, `PDF generation failed: ${message}`);
  } finally {
    isGenerating = false;
    renderProgress.hidden = true;
    updateExportUi();
  }
}

generateBtn.addEventListener('click', () => void runGenerate());
renderDebug.addEventListener('change', updateExportUi);
exportMode.addEventListener('change', updateExportUi);

// ---------------------------------------------------------------------------
// User Mode: automatic analyze → translate → side-by-side bilingual PDF
// ---------------------------------------------------------------------------

type JobStep = 'read' | 'analyze' | 'translate' | 'generate' | 'done';
const JOB_STEPS: JobStep[] = ['read', 'analyze', 'translate', 'generate', 'done'];

/** Failures a general user can act on; the message never contains technical details. */
class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

const MSG_UNSUPPORTED = '目前只支援可選取文字的 PDF，掃描型 PDF 暫不支援。';
const MSG_READ_FAILED = '無法讀取這個 PDF，請確認檔案是否完整後再試一次。';
const MSG_PASSWORD = '這個 PDF 有密碼保護，目前無法處理。';
const MSG_TRANSLATE_FAILED = '翻譯服務暫時發生問題，請稍後再試。';
const MSG_GENERATE_FAILED = 'PDF 產生失敗，請重新嘗試。';
const MSG_OUT_OF_MEMORY = '這個 PDF 太大，瀏覽器記憶體不足，請關閉其他分頁後重新嘗試。';

function resetJobUi(): void {
  jobCard.hidden = true;
  jobReset.hidden = true;
  dropZone.hidden = false;
  uploadNote.hidden = false;
  jobProgress.hidden = false;
  jobDone.hidden = true;
  setText(jobNote, null);
  setText(jobError, null);
  jobDownload.removeAttribute('href');
  jobDownload.removeAttribute('download');
  jobBar.value = 0;
  jobPercent.textContent = '0%';
  for (const li of jobSteps.querySelectorAll('li')) li.classList.remove('is-active', 'is-done');
}

function setJobProgress(step: JobStep, percent: number, label: string): void {
  jobCard.hidden = false;
  // While a file is processed the page shows only the file line and the progress.
  dropZone.hidden = true;
  uploadNote.hidden = true;
  const value = Math.max(jobBar.value, Math.min(100, Math.round(percent))); // never goes backwards
  jobBar.value = value;
  jobPercent.textContent = `${value}%`;
  jobStage.textContent = label;
  const current = JOB_STEPS.indexOf(step);
  for (const li of jobSteps.querySelectorAll<HTMLLIElement>('li')) {
    const index = JOB_STEPS.indexOf(li.dataset.step as JobStep);
    li.classList.toggle('is-done', index < current || step === 'done');
    li.classList.toggle('is-active', index === current && step !== 'done');
  }
}

function showDownloadButton(url: string, fileName: string, failedUnits: number): void {
  setJobProgress('done', 100, '完成');
  jobProgress.hidden = true;
  jobDone.hidden = false;
  jobDownload.href = url;
  jobDownload.download = fileName;
  jobReset.hidden = false;
  setText(jobNote, failedUnits > 0 ? `有 ${failedUnits} 段文字未能翻譯，已保留英文原文。` : null);
}

function friendlyError(step: JobStep, err: unknown): string {
  if (err instanceof UserFacingError) return err.message;
  if (err instanceof RangeError || (err instanceof RenderError && err.kind === 'MEMORY')) return MSG_OUT_OF_MEMORY;
  if (err instanceof Error && err.name === 'PasswordException') return MSG_PASSWORD;
  if (err instanceof RenderError && err.kind === 'ENCRYPTED') return MSG_PASSWORD;
  if (step === 'read' || step === 'analyze') return MSG_READ_FAILED;
  if (step === 'translate') return MSG_TRANSLATE_FAILED;
  return MSG_GENERATE_FAILED;
}

/**
 * handleFileSelected → analyzePdf → (translation blocks) → translateAll →
 * buildPdf (side-by-side) → showDownloadButton. Same core functions as
 * Developer Mode; every await is followed by a check that this job is still
 * the current one, so a newer file always wins.
 */
async function runAutoPipeline(file: File, job: Job): Promise<void> {
  const alive = () => job === currentJob && !job.controller.signal.aborted;
  const jobEntries = entries; // fresh map from resetResults(); a newer job gets its own
  let step: JobStep = 'read';

  try {
    setJobProgress('read', 1, '正在讀取 PDF...');
    const pdf = await analyzePdf(file, (s) => {
      if (!alive()) return;
      if (s.step === 'read') setJobProgress('read', 2, '正在讀取 PDF...');
      else {
        step = 'analyze';
        const pct = s.step === 'layout' ? 18 : 5 + (s.total ? (12 * s.done) / s.total : 0);
        setJobProgress('analyze', pct, '正在分析 PDF...');
      }
    });
    if (!alive()) return;
    currentPdfBytes = pdf.buffer;
    currentAnalysis = pdf.analysis;
    currentLayout = pdf.layout;
    const layout = pdf.layout;
    if (!pdf.analysis.hasSelectableText || !layout || layout.translationBlocks.length === 0) {
      throw new UserFacingError(MSG_UNSUPPORTED);
    }

    // Translate every eligible unit (TITLE / HEADING / BODY / CAPTION / FOOTNOTE; references stay English).
    step = 'translate';
    setJobProgress('translate', 20, '正在翻譯...');
    void loadFontSet().catch(() => undefined); // warm the font download while translating
    const blocks = layout.translationBlocks;
    const stats = await translateAll(blocks, jobEntries, {
      signal: job.controller.signal,
      onProgress: (p) => {
        if (!alive() || p.blocksTotal === 0) return;
        setJobProgress('translate', 20 + (60 * (p.blocksDone + p.blocksFailed)) / p.blocksTotal, '正在翻譯...');
      },
    });
    if (!alive()) return;
    let translated = 0;
    for (const b of blocks) {
      const e = jobEntries.get(b.id);
      if (e && (e.status === 'done' || e.status === 'cached') && e.translation) translated++;
    }
    console.log('[Translation]', Object.fromEntries(jobEntries));
    if (translated === 0) throw new UserFacingError(client.lastFailure === 'network' ? MSG_NETWORK : MSG_TRANSLATE_FAILED);

    step = 'generate';
    setJobProgress('generate', 81, '正在產生中英對照 PDF...');
    const built = await buildPdf({
      pdf: { ...pdf, layout },
      fileName: file.name,
      entries: jobEntries,
      mode: 'overlay',
      output: 'bilingual',
      pages: null,
      unitIds: null,
      onStatus: () => undefined,
      onProgress: (p) => {
        if (alive()) setJobProgress('generate', 83 + (16 * p.percent) / 100, '正在產生中英對照 PDF...');
      },
    });
    if (!alive()) {
      URL.revokeObjectURL(built.url);
      return;
    }
    if (built.fontNotes.length) console.warn('[fonts]', built.fontNotes.join('\n'));
    generatedUrl = built.url; // revoked by resetExport() when the next file is chosen
    showDownloadButton(built.url, built.result.fileName, stats.failedBlocks);
  } catch (err) {
    if (!alive()) return;
    console.error(`[User Mode] ${step} failed`, err);
    jobProgress.hidden = true;
    jobCard.hidden = false;
    jobReset.hidden = false;
    setText(jobError, friendlyError(step, err));
  } finally {
    if (currentJob === job) currentJob = null;
  }
}
