// Minimal Node declarations for the tests that read the shipped font files
// (vitest runs in Node; the app itself has no Node types).
declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(path: string, data: Uint8Array | string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

declare module 'node:url' {
  export function pathToFileURL(path: string): { href: string };
}

declare const process: { env: Record<string, string | undefined> };
