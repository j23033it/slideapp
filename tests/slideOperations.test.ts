import { Marp } from '@marp-team/marp-core';
import { describe, expect, it } from 'vitest';
import { DocumentModel, applyEdit, type SourceEdit } from '../src/document';
import { createEngine, resolveCursor, type SlideOperation, type SlideOperationResult } from '../src/editing';
import { applySessionSlideOperation, planHistoryRestore, type EditorSession } from '../src/app/session';
import { MarpRenderer } from '../src/marp/renderer';
import { renderedSlideSignatures } from '../src/editing/slideValidation';
import type { Token } from '../src/editing/markdown-types';

function setup(raw: string, options = {}) {
  const model = new DocumentModel(raw, { hasBom: true });
  const marp = new Marp({ script: false, ...options });
  const engine = createEngine(marp);
  const analysis = engine.analyze(model.text);
  const operate = (operation: SlideOperation) => engine.applySlideOperation(model.text, operation, model.eols);
  return { model, engine, analysis, operate, marp };
}
function accepted(result: SlideOperationResult) {
  expect(result.ok, result.ok ? '' : result.reason.description).toBe(true);
  if (!result.ok) throw new Error(result.reason.description);
  return result;
}
function apply(model: DocumentModel, result: SlideOperationResult) {
  const success = accepted(result);
  model.editTransaction(success.edits);
  expect(model.text).toBe(success.newText);
  return success;
}

describe('recorded slide source boundaries', () => {
  it('excludes front matter and records only Marpit level-zero hr delimiters', () => {
    const text = '---\nmarp: true\n---\n\n# A\n\n> quote\n>\n> ---\n\n```\n---\n```\n\n***\n\n# B';
    const { analysis } = setup(text);
    expect(analysis.slideSources?.reason).toBeUndefined();
    expect(analysis.slideSources?.frontMatter).toEqual({ start: 0, end: 19 });
    expect(analysis.slideSources?.separators.map(range => text.slice(range.start, range.end))).toEqual(['***\n']);
    expect(analysis.slideSources?.bodies.map(range => text.slice(range.start, range.end))).toEqual([
      '\n# A\n\n> quote\n>\n> ---\n\n```\n---\n```\n\n', '\n# B',
    ]);
  });
  it('does not treat a setext heading underline as a separator', () => {
    const { analysis, operate } = setup('Title\n---\n');
    expect(analysis.slideSources?.separators).toHaveLength(0);
    expect(accepted(operate({ kind: 'add', index: 0 })).analysis.slideSources?.bodies).toHaveLength(2);
  });
});

describe('slide addition and duplication', () => {
  it.each(['# First', 'paragraph', 'paragraph\n', 'paragraph\n\n', ''])('adds an empty slide after a final body %j', raw => {
    const { model, operate } = setup(raw);
    const result = apply(model, operate({ kind: 'add', index: 0 }));
    expect(result.selectedSlide).toBe(1);
    expect(result.newToOld).toEqual([0, null]);
    expect(result.analysis.slideSources?.bodies).toHaveLength(2);
    expect(model.text.startsWith(raw)).toBe(true);
    const empty = result.analysis.slideSources!.bodies[1];
    expect(model.text.slice(empty.start, empty.end)).toBe('');
    expect(model.text).toMatch(/\n---\n$/);
    model.undo(); expect(model.serialize()).toBe(raw);
    model.redo(); expect(model.text).toBe(result.newText);
  });
  it('adds after a middle slide while preserving both old bodies and delimiters', () => {
    const { model, operate } = setup('# A\n\n***\n\n# B');
    const result = apply(model, operate({ kind: 'add', index: 0 }));
    expect(model.text).toBe('# A\n\n\n---\n***\n\n# B');
    expect(result.newToOld).toEqual([0, null, 1]);
    expect(result.selectedSlide).toBe(1);
  });
  it.each(['add', 'duplicate'] as const)('places an empty line before a new separator after an unterminated empty last slide: %s', kind => {
    const { model, operate } = setup('# A\n\n---');
    const result = apply(model, operate({ kind, index: 1 }));
    expect(model.text).toBe('# A\n\n---\n\n---\n');
    expect(result.selectedSlide).toBe(2);
    expect(result.analysis.slideSources!.bodies).toHaveLength(3);
    model.undo(); expect(model.serialize()).toBe('# A\n\n---');
  });
  it.each([0, 1])('duplicates body %i verbatim, including trailing spaces', index => {
    const raw = '# A  \n\n---\n\n# B  ';
    const { model, analysis, operate } = setup(raw);
    const original = analysis.slideSources!.bodies[index];
    const copy = raw.slice(original.start, original.end);
    const result = apply(model, operate({ kind: 'duplicate', index }));
    const duplicate = result.analysis.slideSources!.bodies[index + 1];
    expect(model.text.slice(duplicate.start, duplicate.end)).toBe(copy);
    expect(result.selectedSlide).toBe(index + 1);
    expect(result.newToOld).toEqual(index === 0 ? [0, 0, 1] : [0, 1, 1]);
    model.undo(); expect(model.serialize()).toBe(raw);
  });
  it.each([
    ['LF', '# A\n\n---\n\nparagraph\n***\n\nlast\n',
      '# A\n\n---\n\nparagraph\n\n---\n\nparagraph\n\n***\n\nlast\n'],
    ['CRLF', '# A\r\n\r\n---\r\n\r\nparagraph\r\n***\r\n\r\nlast\r\n',
      '# A\r\n\r\n---\r\n\r\nparagraph\r\n\r\n---\r\n\r\nparagraph\r\n\r\n***\r\n\r\nlast\r\n'],
    ['mixed EOLs', '# A\r\n\r\n---\r\n\nparagraph\r\n***\n\nlast\r\n',
      '# A\r\n\r\n---\r\n\nparagraph\r\n\n---\n\nparagraph\r\n\n***\n\nlast\r\n'],
  ])('separates a duplicated paragraph with one trailing EOL from the following delimiter: %s', (_, raw, expected) => {
    const { model, operate } = setup(raw);
    const result = apply(model, operate({ kind: 'duplicate', index: 1 }));
    expect(model.serialize()).toBe(expected);
    expect(result.newToOld).toEqual([0, 1, 1, 2]);
    expect(result.analysis.blocks.map(block => block.tag)).toEqual(['h1', 'p', 'p', 'p']);
    model.undo(); expect(model.serialize()).toBe(raw); expect(model.canUndo).toBe(false);
    model.redo(); expect(model.serialize()).toBe(expected);
  });
  it.each(['', '\n', '\n\n'])('preserves a final duplicate ending in %j and safely moves it before ---', ending => {
    const raw = '# A\n\n---\n\nlast' + ending;
    const { model, operate } = setup(raw);
    const duplicate = apply(model, operate({ kind: 'duplicate', index: 1 }));
    const finalBody = duplicate.analysis.slideSources!.bodies[2];
    expect(model.text.slice(finalBody.start, finalBody.end)).toBe('\nlast' + ending);
    const duplicatedRaw = model.serialize();
    const moved = apply(model, operate({ kind: 'move', index: 2, to: 0 }));
    expect(moved.newToOld).toEqual([2, 0, 1]);
    expect(model.text.startsWith('\nlast\n\n---\n')).toBe(true);
    model.undo(); expect(model.serialize()).toBe(duplicatedRaw);
    model.undo(); expect(model.serialize()).toBe(raw);
  });
  it.each([
    ['LF', '# A\n\n---\n\nlast\n', '\n---\n', '\nlast\n'],
    ['CRLF', '# A\r\n\r\n---\r\n\r\nlast\r\n', '\r\n---\r\n', '\r\nlast\r\n'],
    ['mixed EOLs', '# A\r\n\r\n---\r\n\nlast\n', '\r\n---\r\n', '\nlast\n'],
  ])('adds or duplicates after a final paragraph with one trailing EOL: %s', (_, raw, separator, copy) => {
    for (const kind of ['add', 'duplicate'] as const) {
      const { model, operate } = setup(raw);
      const result = apply(model, operate({ kind, index: 1 }));
      const expected = raw + separator + (kind === 'duplicate' ? copy : '');
      expect(model.serialize()).toBe(expected);
      expect(result.analysis.slideSources!.bodies).toHaveLength(3);
      model.undo(); expect(model.serialize()).toBe(raw);
      model.redo(); expect(model.serialize()).toBe(expected);
    }
  });
});

describe('slide deletion', () => {
  const raw = '# A\n\n***\n\n# B\n\n___\n\n# C';
  it.each([
    [0, '\n# B\n\n___\n\n# C', 0, [1, 2]],
    [1, '# A\n\n___\n\n# C', 1, [0, 2]],
    [2, '# A\n\n***\n\n# B\n\n', 1, [0, 1]],
  ] as const)('deletes slide %i and the specified adjacent separator', (index, expected, selected, mapping) => {
    const { model, operate } = setup(raw);
    const result = apply(model, operate({ kind: 'delete', index }));
    expect(model.serialize()).toBe(expected);
    expect(result.selectedSlide).toBe(selected);
    expect(result.newToOld).toEqual(mapping);
    model.undo(); expect(model.serialize()).toBe(raw);
  });
  it('refuses deleting the only slide', () => {
    expect(setup('# A').operate({ kind: 'delete', index: 0 })).toMatchObject({ ok: false, reason: { code: 'slide-only-slide' } });
  });
});

describe('slide movement', () => {
  it.each([
    [0, 2, [1, 2, 0]], [2, 0, [2, 0, 1]], [0, 1, [1, 0, 2]], [2, 1, [0, 2, 1]], [1, 1, [0, 1, 2]],
  ] as const)('moves %i to final index %i with delimiters left in place', (index, to, mapping) => {
    const raw = '# A\n\n***\n\n# B\n\n___\n\n# C\n';
    const { model, operate } = setup(raw);
    const result = apply(model, operate({ kind: 'move', index, to }));
    expect(result.newToOld).toEqual(mapping);
    expect(result.selectedSlide).toBe(to);
    expect(result.analysis.slideSources!.separators.map(range => model.text.slice(range.start, range.end))).toEqual(['***\n', '___\n']);
    expect(result.analysis.runs.map(run => run.text)).toEqual(mapping.map(old => ['A', 'B', 'C'][old]));
    if (index !== to) {
      model.undo(); expect(model.serialize()).toBe(raw);
      model.redo(); expect(model.text).toBe(result.newText);
    } else expect(model.canUndo).toBe(false);
  });
  it('adds a safe EOL when moving an unterminated last heading to the middle', () => {
    const { model, operate } = setup('# A\n\n---\n\n# B');
    const result = apply(model, operate({ kind: 'move', index: 1, to: 0 }));
    expect(result.analysis.runs.map(run => run.text)).toEqual(['B', 'A']);
    model.undo(); expect(model.serialize()).toBe('# A\n\n---\n\n# B');
  });
  it('adds an empty line when moving an unterminated last paragraph before ---', () => {
    const { model, operate } = setup('first\n\n---\n\nlast');
    const result = apply(model, operate({ kind: 'move', index: 1, to: 0 }));
    expect(result.analysis.blocks.map(block => block.tag)).toEqual(['p', 'p']);
    expect(result.analysis.runs.map(run => run.text)).toEqual(['last', 'first']);
    expect(model.text).toBe('\nlast\n\n---\nfirst\n\n');
  });
  it.each([
    ['LF', '# A\n\n---\n\nlast\n', '\nlast\n\n---\n# A\n\n'],
    ['CRLF', '# A\r\n\r\n---\r\n\r\nlast\r\n', '\r\nlast\r\n\r\n---\r\n# A\r\n\r\n'],
    ['mixed EOLs', '# A\r\n\n---\r\n\nlast\n', '\nlast\n\r\n---\r\n# A\r\n\n'],
  ])('moves a final paragraph with one trailing EOL before ---: %s', (_, raw, expected) => {
    const { model, operate } = setup(raw);
    const result = apply(model, operate({ kind: 'move', index: 1, to: 0 }));
    expect(model.serialize()).toBe(expected);
    expect(result.analysis.blocks.map(block => block.tag)).toEqual(['p', 'h1']);
    expect(result.analysis.runs.map(run => run.text)).toEqual(['last', 'A']);
    model.undo(); expect(model.serialize()).toBe(raw); expect(model.canUndo).toBe(false);
    model.redo(); expect(model.serialize()).toBe(expected);
  });
  it.each([
    [0, '\nlast\n\n---\n# A\n\n---\r\n\nmiddle\r\n\r\n', [2, 0, 1]],
    [1, '# A\n\n---\n\nlast\n\r\n---\r\n\nmiddle\r\n\r\n', [0, 2, 1]],
  ] as const)('pads only relocated bodies when moving the final paragraph to %i', (to, expected, mapping) => {
    const raw = '# A\n\n---\n\nmiddle\r\n\r\n---\r\n\nlast\n';
    const { model, analysis, operate } = setup(raw);
    const result = apply(model, operate({ kind: 'move', index: 2, to }));
    expect(model.serialize()).toBe(expected);
    expect(result.newToOld).toEqual(mapping);
    expect(result.edits.every(edit => analysis.slideSources!.bodies.some(body => body.start === edit.start && body.end === edit.end))).toBe(true);
    if (to === 1) expect(result.edits.some(edit => edit.start === 0)).toBe(false);
    model.undo(); expect(model.serialize()).toBe(raw);
    model.redo(); expect(model.serialize()).toBe(expected);
  });
  it.each(['\n', '\n\n', '\n \t\n'])('keeps a middle paragraph ending %j unchanged when moving it to the end', ending => {
    const raw = '# A\r\n\r\n---\r\n\nmiddle' + ending + '***\n\nlast\n';
    const expected = '# A\r\n\r\n---\r\n\nlast\n\n***\n\nmiddle' + ending;
    const { model, operate } = setup(raw);
    const result = apply(model, operate({ kind: 'move', index: 1, to: 2 }));
    expect(model.serialize()).toBe(expected);
    expect(result.analysis.runs.map(run => run.text)).toEqual(['A', 'last', 'middle']);
    model.undo(); expect(model.serialize()).toBe(raw);
  });
  it.each(['\n\n', '\n \t\n'])('does not pad a moved paragraph that already ends with a blank line %j', ending => {
    const raw = '# A\n\n---\n\nlast' + ending;
    const { model, operate } = setup(raw);
    apply(model, operate({ kind: 'move', index: 1, to: 0 }));
    expect(model.serialize()).toBe('\nlast' + ending + '---\n# A\n\n');
    model.undo(); expect(model.serialize()).toBe(raw);
  });
});

describe('front matter, BOM and per-newline preservation', () => {
  const front = '---\r\nmarp: true\r\npaginate: true\r\n---\r\n';
  it.each<SlideOperation>([
    { kind: 'add', index: 0 }, { kind: 'duplicate', index: 0 }, { kind: 'delete', index: 0 },
    { kind: 'delete', index: 1 }, { kind: 'move', index: 1, to: 0 },
  ])('retains front matter and BOM through $kind and undo/redo', operation => {
    const raw = front + '\r\n# A\r\n\r\n---\n\n# B';
    const { model, operate } = setup(raw);
    const result = apply(model, operate(operation));
    expect(model.serialize().startsWith(front)).toBe(true);
    expect(model.hasBom).toBe(true);
    const final = model.serialize();
    model.undo(); expect(model.serialize()).toBe(raw); expect(model.hasBom).toBe(true);
    model.redo(); expect(model.serialize()).toBe(final); expect(model.text).toBe(result.newText);
  });
  it('copies every mixed EOL with a duplicated body, using the separator EOL for inserted lines', () => {
    const raw = '# A\r\nbody\n\r\n---\r\n\n# B';
    const { model, operate } = setup(raw);
    apply(model, operate({ kind: 'duplicate', index: 0 }));
    expect(model.serialize()).toBe('# A\r\nbody\n\r\n\r\n---\r\n# A\r\nbody\n\r\n---\r\n\n# B');
  });
  it('moves each body EOL while leaving mixed separator EOLs untouched', () => {
    const { model, operate } = setup('# A\r\n\n***\r\n\r\n# B\n\r\n___\n\n# C');
    apply(model, operate({ kind: 'move', index: 0, to: 1 }));
    expect(model.serialize()).toBe('\r\n# B\n\r\n***\r\n# A\r\n\n___\n\n# C');
  });
  it.each(['# A\r\n', '# A\r\nbody\r\n', '# A\nbody\r\n'])('uses majority EOL without separators: %j', raw => {
    const { model, operate } = setup(raw);
    apply(model, operate({ kind: 'add', index: 0 }));
    expect(model.serialize()).toBe(raw + (raw === '# A\nbody\r\n' ? '\n---\n' : '\r\n---\r\n'));
  });
});

describe('conservative refusals and rendering validation', () => {
  it.each([
    '---\nheadingDivider: 2\n---\n# A\n\n## B',
    '<!-- headingDivider: 1 -->\n# A\n\n# B',
    '---\nheadingDivider: false\n---\n# A\n\n---\n# B',
  ])('disables all operations for headingDivider %j', text => {
    for (const operation of [
      { kind: 'add', index: 0 }, { kind: 'duplicate', index: 0 }, { kind: 'delete', index: 0 }, { kind: 'move', index: 0, to: 1 },
    ] as SlideOperation[]) {
      expect(setup(text).operate(operation)).toMatchObject({ ok: false, reason: { code: 'slide-heading-divider' } });
    }
  });
  it('refuses headingDivider set by renderer options', () => {
    expect(setup('# A\n\n# B', { headingDivider: 1 }).operate({ kind: 'add', index: 0 })).toMatchObject({ ok: false, reason: { code: 'slide-heading-divider' } });
  });
  it.each([
    '<!-- class: inherited -->', '<!-- paginate: true -->', '<!-- backgroundColor: red -->',
    '<!-- theme: gaia -->', '<!-- style: section {color:red} -->', '<style>section {color:red}</style>',
    'inline <!-- color: red --> text',
  ])('refuses duplicate/delete/move of a slide with inherited settings: %s', setting => {
    for (const kind of ['duplicate', 'delete', 'move'] as const) {
      const { operate } = setup(`# A\n\n${setting}\n\n---\n\n# B`);
      expect(operate(kind === 'move' ? { kind, index: 0, to: 1 } : { kind, index: 0 })).toMatchObject({ ok: false, reason: { code: 'slide-inherited-settings' } });
    }
  });
  it('permits scoped directives and scoped styles whose generated scope keys change', () => {
    const { model, operate } = setup('# A\n\n<!-- _class: own -->\n<style scoped>section {color:red}</style>\n\n---\n\n# B');
    expect(apply(model, operate({ kind: 'move', index: 0, to: 1 })).selectedSlide).toBe(1);
  });
  it('refuses moving a plain slide across an inherited class and keeps the prior engine analysis usable', () => {
    const raw = '# A\n\n---\n\n<!-- class: blue -->\n# B\n\n---\n\n# C';
    const { model, analysis, engine, operate } = setup(raw);
    expect(operate({ kind: 'move', index: 0, to: 2 })).toMatchObject({ ok: false, reason: { code: 'slide-render-changed' } });
    expect(model.serialize()).toBe(raw); expect(model.canUndo).toBe(false);
    expect(engine.applyRunEdit(raw, analysis.runs[0].id, 'Updated').ok).toBe(true);
  });
  it('allows deleting a slide with a setting limited to that slide', () => {
    const { operate } = setup('<!-- class: red -->\n# A\n\n---\n\n<!-- _class: blue -->\n# B\n\n---\n\n# C');
    // Deleting the spotted slide is safe: C still inherits red, not blue.
    expect(operate({ kind: 'delete', index: 1 }).ok).toBe(true);
  });
  it('permits pagination changes and preserves all class/style/content attributes', () => {
    const { model, operate } = setup('---\npaginate: true\n---\n# A\n\n---\n\n# B');
    expect(apply(model, operate({ kind: 'duplicate', index: 1 })).analysis.html).toContain('data-marpit-pagination-total="3"');
  });
  it('refuses relocation that changes link reference resolution', () => {
    // The first of two reference definitions wins; changing their order changes links.
    const { operate } = setup('# A\n\n[link][id]\n\n[id]: https://a.example\n\n---\n\n# B\n\n[id]: https://b.example');
    expect(operate({ kind: 'move', index: 0, to: 1 })).toMatchObject({ ok: false, reason: { code: 'slide-render-changed' } });
  });
  it.each([-1, 2, 0.5, NaN])('rejects invalid source and destination indices: %s', index => {
    expect(setup('# A\n\n---\n\n# B').operate({ kind: 'delete', index })).toMatchObject({ ok: false, reason: { code: 'slide-invalid-index' } });
    expect(setup('# A\n\n---\n\n# B').operate({ kind: 'move', index: 0, to: index })).toMatchObject({ ok: false, reason: { code: 'slide-invalid-index' } });
  });
  it('rejects stale source, mismatched EOLs, NUL and unfinished drafts', () => {
    const { model, engine, analysis } = setup('paragraph');
    expect(engine.applySlideOperation('changed', { kind: 'add', index: 0 }, [''])).toMatchObject({ ok: false, reason: { code: 'slide-stale-analysis' } });
    expect(engine.applySlideOperation(model.text, { kind: 'add', index: 0 }, ['\n', ''])).toMatchObject({ ok: false, reason: { code: 'slide-stale-analysis' } });
    const newline = engine.applyNewline(model.text, analysis.runs[0].id, 9, 'paragraph');
    expect(newline.ok).toBe(true);
    if (newline.ok) {
      model.edit(newline.edit);
      expect(engine.applySlideOperation(model.text, { kind: 'add', index: 0 }, model.eols)).toMatchObject({ ok: false, reason: { code: 'slide-pending-edit' } });
    }
    expect(setup('# A\0').operate({ kind: 'add', index: 0 })).toMatchObject({ ok: false, reason: { code: 'slide-readonly' } });
  });
  it('rejects a generated hr with no unique source range', () => {
    const marp = new Marp({ script: false });
    marp.markdown.core.ruler.before('marpit_slide', 'ambiguous_hr', (state: { Token: new (type: string, tag: string, nesting: number) => Token; tokens: Token[] }) => {
      const token = new state.Token('hr', 'hr', 0); token.map = null;
      state.tokens.push(token);
    });
    const engine = createEngine(marp); engine.analyze('# A');
    expect(engine.applySlideOperation('# A', { kind: 'add', index: 0 }, [''])).toMatchObject({ ok: false, reason: { code: 'slide-ambiguous-boundary' } });
  });
});

describe('document CSS depending on slide position', () => {
  const selectors = [
    'section[id="2"] h1', '[id]', '[ id ^= "2"]', 'section#2 h1', String.raw`section#\32 h1`,
    '[data-marpit-pagination="2"]', '[data-marpit-pagination-total]',
    'section:nth-child(2)', 'section:nth-of-type(2)', 'section:nth-last-child(2)', 'section:nth-last-of-type(2)',
    'section:first-child', 'section:last-child', 'section:first-of-type', 'section:last-of-type',
    'section:only-child', 'section:only-of-type', 'section:has(h1:first-child)',
    'SECTION[ID="2"]', 'section:/**/nth-child(2)', String.raw`section:n\74h-child(2)`,
  ];
  it.each(selectors)('rejects every structural operation for %s', selector => {
    const raw = `<style>${selector} {color:red}</style>\n\n# A\n\n---\n\n# B\n\n---\n\n# C`;
    for (const operation of [
      { kind: 'add', index: 0 }, { kind: 'duplicate', index: 1 },
      { kind: 'delete', index: 1 }, { kind: 'move', index: 1, to: 2 },
    ] satisfies SlideOperation[]) {
      const { model, engine, analysis, operate } = setup(raw);
      expect(operate(operation)).toMatchObject({ ok: false, reason: { code: 'slide-position-css' } });
      expect(model.serialize()).toBe(raw);
      expect(model.canUndo).toBe(false);
      expect(engine.applyRunEdit(raw, analysis.runs[0].id, 'Updated').ok).toBe(true);
    }
  });
  it.each([
    '<style scoped>section:nth-child(2) {color:red}</style>',
    '<!-- style: section[id="2"] h1 {color:red} -->',
    '---\nstyle: |\n  section[id="2"] h1 {color:red}\n---',
  ])('also rejects scoped style and style directives: %s', style => {
    const { operate } = setup(`${style}\n\n# A\n\n---\n\n# B`);
    expect(operate({ kind: 'add', index: 0 })).toMatchObject({ ok: false, reason: { code: 'slide-position-css' } });
  });
  it.each([
    'section h1 {color:red}', 'section#title {color:red}', 'section[data-kind="id"] {color:red}',
    'section {color:#123456;content:":nth-child(2) [id]"}', '/* section[id="2"] {} */ section {color:red}',
    '@media screen { section h1 {color:red} }',
  ])('allows unrelated CSS when adding a slide: %s', css => {
    expect(setup(`<style>${css}</style>\n\n# A\n\n---\n\n# B`).operate({ kind: 'add', index: 0 }).ok).toBe(true);
  });
  it('ignores CSS-looking prose and fenced examples', () => {
    const { operate } = setup('`section:nth-child(2)`\n\n```html\n<style>section[id="2"] h1 {color:red}</style>\n```\n\n---\n\n# B');
    expect(operate({ kind: 'add', index: 0 }).ok).toBe(true);
  });
  it('does not inspect custom theme CSS', () => {
    const { marp, engine, model } = setup('---\ntheme: positional\n---\n# A\n\n---\n\n# B');
    marp.themeSet.add('/* @theme positional */\nsection:nth-child(2) h1 {color:red}');
    engine.analyze(model.text);
    expect(engine.applySlideOperation(model.text, { kind: 'add', index: 0 }, model.eols).ok).toBe(true);
  });
});

describe('atomic history and session integration', () => {
  function session(raw = '# A\r\n\r\n---\n\n# B') {
    const model = new DocumentModel(raw, { hasBom: true });
    const renderer = new MarpRenderer(path => path);
    return { model, renderer, baseDir: 'C:/deck', ...renderer.analyze(model.text, 'C:/deck') } as EditorSession;
  }
  it.each<SlideOperation>([
    { kind: 'add', index: 0 }, { kind: 'duplicate', index: 1 },
    { kind: 'delete', index: 0 }, { kind: 'move', index: 1, to: 0 },
  ])('updates model and rendering together and restores selection with one undo/redo: $kind', operation => {
    const state = session(), raw = state.model.serialize();
    const result = accepted(applySessionSlideOperation(state, operation, 1));
    const final = state.model.serialize();
    expect(state.analysis).toBe(result.analysis);
    expect(state.deck.slides).toHaveLength(result.newToOld.length);
    expect(state.focus).toBeUndefined();
    const undoCursor = state.model.undo()!;
    const before = state.renderer.analyze(state.model.text, state.baseDir);
    expect(planHistoryRestore(before.deck, resolveCursor(before.analysis, undoCursor), result.selectedSlide)).toEqual({ cursor: undefined, current: 1 });
    expect(state.model.serialize()).toBe(raw); expect(state.model.canUndo).toBe(false);
    const redoCursor = state.model.redo()!;
    const after = state.renderer.analyze(state.model.text, state.baseDir);
    expect(planHistoryRestore(after.deck, resolveCursor(after.analysis, redoCursor), 1)).toEqual({ cursor: undefined, current: result.selectedSlide });
    expect(state.model.serialize()).toBe(final); expect(state.model.hasBom).toBe(true);
  });
  it('keeps rejected session operations and history unchanged', () => {
    const state = session('<!-- class: red -->\n# A\n\n---\n\n# B');
    const analysis = state.analysis, deck = state.deck;
    expect(applySessionSlideOperation(state, { kind: 'delete', index: 0 }, 0).ok).toBe(false);
    expect(state.analysis).toBe(analysis); expect(state.deck).toBe(deck); expect(state.model.canUndo).toBe(false);
  });
  it('records and restores a move that changes only EOLs and slide selection', () => {
    const raw = '# Same\r\n\r\n---\n# Same\n\n';
    const state = session(raw), normalized = state.model.text;
    accepted(applySessionSlideOperation(state, { kind: 'move', index: 0, to: 1 }, 0));
    expect(state.model.text).toBe(normalized);
    expect(state.model.serialize()).toBe('# Same\n\n---\n# Same\r\n\r\n');
    expect(state.model.canUndo).toBe(true);
    expect(state.model.undo()?.slideIndex).toBe(0);
    expect(state.model.serialize()).toBe(raw);
    expect(state.model.redo()?.slideIndex).toBe(1);
    expect(state.model.serialize()).toBe('# Same\n\n---\n# Same\r\n\r\n');
  });
  it('keeps structural history separate from text before and after it', () => {
    const state = session('# A\n\n---\n\n# B');
    const run = state.analysis.runs[0];
    const first = state.renderer.editing.applyRunEdit(state.model.text, run.id, 'AA');
    if (!first.ok) throw new Error('Text edit rejected');
    state.model.edit(first.edit, { before: { runId: run.id, offset: 1 }, after: { runId: run.id, offset: 2 } });
    state.analysis = first.analysis; state.deck = state.renderer.update(first.analysis, state.baseDir);
    accepted(applySessionSlideOperation(state, { kind: 'move', index: 0, to: 1 }, 0));
    state.model.undo(); expect(state.model.text).toBe('# AA\n\n---\n\n# B');
    state.model.undo(); expect(state.model.text).toBe('# A\n\n---\n\n# B');
  });
  it('validates transactions completely before changing model or history', () => {
    const model = new DocumentModel('A\r\nB\n');
    const invalid: SourceEdit[] = [{ start: 3, end: 3, insert: 'x' }, { start: 0, end: 1, insert: '\n', eols: [] }];
    expect(() => model.editTransaction(invalid)).toThrow();
    expect(model.serialize()).toBe('A\r\nB\n'); expect(model.canUndo).toBe(false);
    expect(() => applyEdit(model, { start: 0, end: 0, insert: '\n', eols: [] })).toThrow();
  });
});

describe('rendered markup comparison', () => {
  it('keeps quoted attributes, class, style, contents and non-position ids significant', () => {
    const html = '<div><svg data-marpit-svg=""><section id="1" class="a" style="color:red"><span data-sm-run="r1-0">A</span><img title="a > b" src="x"></section></svg></div>';
    const signatures = renderedSlideSignatures(html)!;
    expect(signatures).toHaveLength(1);
    expect(renderedSlideSignatures(html.replace('r1-0', 'r9-0'))).toEqual(signatures);
    for (const [from, to] of [['class="a"', 'class="b"'], ['color:red', 'color:blue'], ['>A<', '>B<'], ['id="1"', 'id="custom"'], ['src="x"', 'src="y"']]) {
      expect(renderedSlideSignatures(html.replace(from, to))).not.toEqual(signatures);
    }
  });
});
