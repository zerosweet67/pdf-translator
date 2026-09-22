import { defineConfig } from 'vite';

// Public base path of the deployed site, set in ONE place:
//   BASE_PATH env var at build time. The GitHub Pages workflow sets it from
//   actions/configure-pages (e.g. "/pdf-translator/" for a project site,
//   "/" for a <user>.github.io site or a custom domain), so renaming the repo
//   needs no code change.
// Default './' makes every asset URL relative, which also works under any
// sub-path, e.g. for `npm run build && npm run preview` locally.
// Fonts use import.meta.env.BASE_URL and the PDF.js worker is imported with
// ?url, so both follow this setting.
function normalizeBase(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return './';
  if (value === './') return value;
  return `/${value.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
}

export default defineConfig({
  base: normalizeBase(process.env.BASE_PATH),
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
