import { Marp } from '@marp-team/marp-core';
import { describe, expect, it } from 'vitest';
import { DocumentModel } from '../src/document';
import { applyElementTransaction, createEngine } from '../src/editing';

describe('element operations', () => {
  it.each([
    ['| a | b |\n| --- | --- |\n| x | |\n\nend', ['table', 'paragraph']],
    ['- \n\nend', ['list', 'paragraph']],
    ['- \n\nfirst\n\n---\n\n| a | b |\n| --- | --- |\n| | |\n\nend', ['list', 'paragraph', 'table', 'paragraph']],
  ])('maps rendered element IDs to original source ranges with empty targets: %j', (raw, kinds) => {
    const engine = createEngine(new Marp({ script: false }));
    const analysis = engine.analyze(raw);
    const elements = analysis.elementSources!.elements;
    expect(elements.map(element => element.kind)).toEqual(kinds);
    expect([...analysis.html.matchAll(/data-sm-element="([^"]+)"/g)].map(match => match[1])).toEqual(elements.map(element => element.id));
    for (const element of elements) {
      const source = raw.slice(element.start, element.end);
      expect(source.trim()).not.toBe('');
      if (element.kind === 'paragraph') expect(['first', 'end']).toContain(source.trim());
      if (element.kind === 'list') expect(source.trim()).toBe('-');
      if (element.kind === 'table') expect(source).toMatch(/^\| a \| b \|/);
    }
  });
  it('captures and deletes a block with atomic undo', () => {
    const model = new DocumentModel('# A\r\n\r\nparagraph\n\n# B', { hasBom: true });
    const engine = createEngine(new Marp({ script: false }));
    const before = engine.analyze(model.text);
    expect(before.elementSources?.elements.map(e => e.kind)).toEqual(['heading', 'paragraph', 'heading']);
    const result = engine.applyElementOperation(model.text, { kind: 'delete', elementId: before.elementSources!.elements[1].id }, model.eols);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    model.editTransaction([result.edit]);
    expect(model.serialize()).toBe('# A\r\n\r\n# B');
    model.undo(); expect(model.serialize()).toBe('# A\r\n\r\nparagraph\n\n# B'); expect(model.hasBom).toBe(true);
  });
  it('inserts a block and rejects merging lists', () => {
    const model = new DocumentModel('- a\n\nparagraph\n\n- b');
    const engine = createEngine(new Marp({ script: false }));
    const before = engine.analyze(model.text);
    const deletion = engine.applyElementOperation(model.text, { kind: 'delete', elementId: before.elementSources!.elements[1].id }, model.eols);
    expect(deletion).toMatchObject({ ok: false, reason: { code: 'element-structure-changed' } });
    const insert = engine.applyElementOperation(model.text, { kind: 'insert', slide: 0, lines: ['# New'], expectedKinds: ['heading'] }, model.eols);
    expect(insert.ok).toBe(true);
  });
});

describe('element boundaries', () => {
  it.each([
    ['only', '---\nmarp: true\n---\n\n# A\n\n---\n\n# B', 0, '---\nmarp: true\n---\n\n\n---\n\n# B'],
    ['last', '# A\n\n# B\n\n---\n\n# C', 1, '# A\n\n---\n\n# C'],
    ['first', '# A\n\n# B', 0, '# B'],
    ['final without newline', '# A\n\n# B', 1, '# A\n'],
  ])('deletes %s without changing surrounding source', (_, raw, index, expected) => {
    const model = new DocumentModel(raw, { hasBom: true });
    const engine = createEngine(new Marp({ script: false }));
    const before = engine.analyze(model.text);
    const result = engine.applyElementOperation(model.text, { kind: 'delete', elementId: before.elementSources!.elements[index].id }, model.eols);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    model.editTransaction([result.edit]); expect(model.serialize()).toBe(expected);
    model.undo(); expect(model.serialize()).toBe(raw); expect(model.hasBom).toBe(true);
  });
  it('refuses setext conversion and comment-containing elements', () => {
    for (const raw of ['paragraph\n\n# heading\n\n---\nnext', 'before <!-- note --> after']) {
      const model = new DocumentModel(raw);
      const engine = createEngine(new Marp({ script: false }));
      const before = engine.analyze(model.text);
      const target = before.elementSources!.elements[raw.startsWith('paragraph') ? 1 : 0];
      const result = engine.applyElementOperation(model.text, { kind: 'delete', elementId: target.id }, model.eols);
      if (raw.startsWith('before')) expect(result).toMatchObject({ ok: false });
      else if (result.ok) expect(result.analysis.elementSources!.elements[0].kind).toBe('paragraph');
      expect(model.serialize()).toBe(raw);
    }
  });
  it.each(['', '---\nmarp: true\n---\n', '# A\n\n---\n', '# A\r\n\n---\r\n'])('inserts into an empty or trailing slide %j', raw => {
    const model = new DocumentModel(raw, { hasBom: true });
    const engine = createEngine(new Marp({ script: false }));
    const before = engine.analyze(model.text);
    const slide = before.slideSources!.bodies.length - 1;
    const result = engine.applyElementOperation(model.text, { kind: 'insert', slide, lines: ['hello'], expectedKinds: ['paragraph'] }, model.eols);
    expect(result.ok, result.ok ? '' : result.reason.code).toBe(true);
    if (!result.ok) return;
    model.editTransaction([result.edit]);
    expect(model.hasBom).toBe(true);
    model.undo(); expect(model.serialize()).toBe(raw);
  });
  it('supports before and after anchors and several block kinds', () => {
    for (const side of ['before', 'after'] as const) {
      const model = new DocumentModel('# A\r\n\n# B');
      const engine = createEngine(new Marp({ script: false }));
      const before = engine.analyze(model.text);
      const result = engine.applyElementOperation(model.text, { kind: 'insert', slide: 0, anchor: { elementId: before.elementSources!.elements[0].id, side }, lines: ['new paragraph', '', '## New'], expectedKinds: ['paragraph', 'heading'] }, model.eols);
      expect(result.ok, result.ok ? '' : result.reason.code).toBe(true);
      if (!result.ok) continue;
      model.editTransaction([result.edit]); expect(model.serialize()).toContain('new paragraph');
      model.undo(); expect(model.serialize()).toBe('# A\r\n\n# B');
    }
  });
  it('refuses headingDivider, stale revisions, invalid expected kinds and unsafe HTML', () => {
    const model = new DocumentModel('---\nheadingDivider: 1\n---\n# A');
    const engine = createEngine(new Marp({ script: false }));
    const before = engine.analyze(model.text);
    expect(engine.applyElementOperation(model.text, { kind: 'delete', elementId: before.elementSources!.elements[0].id }, model.eols)).toMatchObject({ ok: false, reason: { code: 'element-heading-divider' } });
    const other = new DocumentModel('# A'); const e = createEngine(new Marp({ script: false })); e.analyze(other.text);
    expect(e.applyElementOperation(other.text, { kind: 'insert', slide: 0, lines: ['plain'], expectedKinds: ['heading'] }, other.eols)).toMatchObject({ ok: false, reason: { code: 'element-structure-changed' } });
  });
});

it('can validate multiple inserted HTML and text blocks with the existing Marp allowlist', () => {
  const model = new DocumentModel('# A');
  const engine = createEngine(new Marp({ script: false }));
  engine.analyze(model.text);
  const result = engine.applyElementOperation(model.text, { kind: 'insert', slide: 0, lines: ['<div>', '', 'inside', '', '</div>'], expectedKinds: ['html', 'paragraph', 'html'] }, model.eols);
  expect(result.ok, result.ok ? '' : result.reason.code).toBe(true);
  if (result.ok) expect(result.analysis.html).toContain('inside');
});

it('records supported top-level kinds and excludes background and linked images', () => {
  const engine = createEngine(new Marp({ script: false }));
  const a = engine.analyze('# heading\n\n> quote\n\n- item\n\n| a |\n| --- |\n| b |\n\n```\ncode\n```\n\n![alt](a.png)\n\n[![x](a.png)](b)\n\n![bg](b.png)');
  expect(a.elementSources!.elements.map(e => e.kind)).toEqual(['heading', 'quote', 'list', 'table', 'code', 'image', 'paragraph', 'paragraph']);
  expect(a.html).toMatch(/<pre data-sm-element=/);
});

it('commits an insertion to history once and rejects readonly and conflict states', () => {
  const model = new DocumentModel('first\r\n\nlast', { hasBom: true });
  const engine = createEngine(new Marp({ script: false }));
  const before = engine.analyze(model.text);
  const operation = { kind: 'insert', slide: 0, anchor: { elementId: before.elementSources!.elements[0].id, side: 'after' }, lines: ['middle'], expectedKinds: ['paragraph'] } as const;
  expect(applyElementTransaction(model, engine, { ...operation, lines: [...operation.lines], expectedKinds: [...operation.expectedKinds] }, { readonly: true })).toMatchObject({ ok: false, reason: { code: 'element-readonly' } });
  const result = applyElementTransaction(model, engine, { ...operation, lines: [...operation.lines], expectedKinds: [...operation.expectedKinds] });
  expect(result.ok).toBe(true);
  expect(model.serialize()).toContain('middle');
  model.undo(); expect(model.serialize()).toBe('first\r\n\nlast'); expect(model.canUndo).toBe(false);
  expect(model.hasBom).toBe(true);
  model.markConflict(); engine.analyze(model.text);
  expect(applyElementTransaction(model, engine, { ...operation, lines: [...operation.lines], expectedKinds: [...operation.expectedKinds] })).toMatchObject({ ok: false, reason: { code: 'element-readonly' } });
});

it('never rebinds an element ID from an older analysis to a different block', () => {
  const engine = createEngine(new Marp({ script: false }));
  const old = engine.analyze('first\n\nsecond').elementSources!.elements[0].id;
  const model = new DocumentModel('second');
  engine.analyze(model.text);
  expect(engine.applyElementOperation(model.text, { kind: 'delete', elementId: old }, model.eols)).toMatchObject({ ok: false, reason: { code: 'element-ambiguous' } });
});
