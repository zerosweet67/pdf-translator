/**
 * PDF outline reader: native / nested outlines, named and direct
 * destinations, unresolved and invalid destinations (pdf/outline.ts).
 */
import { describe, expect, it } from 'vitest';
import { destinationTop, readOutline, resolveOutlineDestination, type OutlineSource, type RawOutlineItem } from '../outline';

/** Fake PDFDocumentProxy: page refs are { num }, named destinations come from a map. */
function source(items: RawOutlineItem[] | null, named: Record<string, unknown[] | null> = {}, pages = 20): OutlineSource {
  return {
    async getOutline() {
      return items;
    },
    async getDestination(name) {
      if (name === 'boom') throw new Error('corrupt name tree');
      return named[name] ?? null;
    },
    async getPageIndex(ref) {
      const num = (ref as { num?: number }).num;
      if (typeof num !== 'number' || num < 1 || num > pages) throw new Error(`bad ref ${JSON.stringify(ref)}`);
      return num - 1;
    },
  };
}

const ref = (page: number) => ({ num: page, gen: 0 });
const xyz = (page: number, top: number | null): unknown[] => [ref(page), { name: 'XYZ' }, null, top, null];

describe('destinationTop', () => {
  it('reads the top of /XYZ, /FitH, /FitBH and /FitR and nothing for the other kinds', () => {
    expect(destinationTop(xyz(1, 614))).toBe(614);
    expect(destinationTop([ref(1), { name: 'FitH' }, 500])).toBe(500);
    expect(destinationTop([ref(1), { name: 'FitBH' }, 480])).toBe(480);
    expect(destinationTop([ref(1), { name: 'FitR' }, 10, 20, 300, 400])).toBe(400);
    expect(destinationTop([ref(1), { name: 'Fit' }])).toBeNull();
    expect(destinationTop([ref(1), { name: 'FitV' }, 10])).toBeNull();
    expect(destinationTop(xyz(1, null))).toBeNull();
    expect(destinationTop([ref(1), 'XYZ', 1, 2, 3])).toBeNull();
  });
});

describe('resolveOutlineDestination', () => {
  it('4. resolves a direct destination array to a 1-based page and Y', async () => {
    const r = await resolveOutlineDestination(xyz(3, 700), source([]));
    expect(r).toEqual({ page: 3, y: 700 });
  });

  it('3. resolves a named destination through getDestination()', async () => {
    const r = await resolveOutlineDestination('section.1', source([], { 'section.1': xyz(2, 462) }));
    expect(r).toEqual({ page: 2, y: 462 });
  });

  it('accepts a plain page index in place of a reference', async () => {
    const r = await resolveOutlineDestination([4, { name: 'Fit' }], source([]));
    expect(r).toEqual({ page: 5, y: null });
  });

  it('5. reports an unresolved destination instead of throwing', async () => {
    expect(await resolveOutlineDestination('missing', source([]))).toMatchObject({ error: expect.stringContaining('not found') });
    expect(await resolveOutlineDestination('boom', source([]))).toMatchObject({ error: expect.stringContaining('corrupt') });
    expect(await resolveOutlineDestination(xyz(99, 10), source([]))).toMatchObject({ error: expect.stringContaining('page reference') });
    expect(await resolveOutlineDestination(null, source([]))).toMatchObject({ error: 'no destination' });
  });

  it('reports an invalid destination array', async () => {
    expect(await resolveOutlineDestination([], source([]))).toMatchObject({ error: 'invalid destination array' });
    expect(await resolveOutlineDestination(['nope', { name: 'XYZ' }], source([]))).toMatchObject({ error: 'invalid page reference' });
    expect(await resolveOutlineDestination([-1, { name: 'XYZ' }], source([]))).toMatchObject({ error: expect.stringContaining('invalid page') });
  });
});

describe('readOutline', () => {
  it('1. reads a native outline with resolved pages and anchors', async () => {
    const r = await readOutline(
      source([
        { title: 'Introduction', dest: xyz(2, 462) },
        { title: 'Methods', dest: 'sec.2' },
        { title: 'Results', dest: [ref(5), { name: 'Fit' }] },
      ], { 'sec.2': [ref(3), { name: 'FitH' }, 500] }),
    );
    expect(r.warnings).toEqual([]);
    expect(r.items).toEqual([
      { title: 'Introduction', page: 2, y: 462, children: [] },
      { title: 'Methods', page: 3, y: 500, children: [] },
      { title: 'Results', page: 5, y: null, children: [] },
    ]);
  });

  it('2. keeps the nested hierarchy', async () => {
    const r = await readOutline(
      source([
        {
          title: 'Paper',
          dest: xyz(1, 700),
          items: [
            { title: '1. Introduction', dest: xyz(2, 462) },
            {
              title: '2. Background',
              dest: xyz(9, 226),
              items: [
                { title: '2.1 The transformer', dest: xyz(9, 203) },
                { title: '2.2 Training', dest: xyz(10, 240), items: [{ title: '2.2.1 Data', dest: xyz(10, 100) }] },
              ],
            },
          ],
        },
      ]),
    );
    expect(r.items).toHaveLength(1);
    const root = r.items[0];
    expect(root.children.map((c) => c.title)).toEqual(['1. Introduction', '2. Background']);
    expect(root.children[1].children.map((c) => c.title)).toEqual(['2.1 The transformer', '2.2 Training']);
    expect(root.children[1].children[1].children[0]).toEqual({ title: '2.2.1 Data', page: 10, y: 100, children: [] });
  });

  it('5./6. skips only the item whose destination fails and keeps its children', async () => {
    const r = await readOutline(
      source([
        { title: 'Good', dest: xyz(1, 700) },
        { title: 'Broken parent', dest: 'nowhere', items: [{ title: 'Child', dest: xyz(4, 300) }] },
        { title: 'Beyond', dest: xyz(50, 300) },
        { title: 'Also good', dest: xyz(6, 200) },
      ], {}, 20),
    );
    expect(r.items.map((i) => [i.title, i.page])).toEqual([
      ['Good', 1],
      ['Broken parent', null],
      ['Beyond', null],
      ['Also good', 6],
    ]);
    expect(r.items[1].children).toEqual([{ title: 'Child', page: 4, y: 300, children: [] }]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain('Broken parent');
    expect(r.warnings[1]).toContain('Beyond');
  });

  it('10. an empty or unreadable outline yields no items and never throws', async () => {
    expect(await readOutline(source(null))).toEqual({ items: [], warnings: [] });
    expect(await readOutline(source([]))).toEqual({ items: [], warnings: [] });
    const broken: OutlineSource = {
      ...source([]),
      async getOutline() {
        throw new Error('xref broken');
      },
    };
    const r = await readOutline(broken);
    expect(r.items).toEqual([]);
    expect(r.warnings[0]).toContain('xref broken');
  });
});
