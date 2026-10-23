import { Marp } from '@marp-team/marp-core';
import { describe, expect, it } from 'vitest';
import { createEngine, resolveCursor } from '../src/editing';
import { applyEdit, joinEols, splitEols } from '../src/document';
import { mapBlockLines } from '../src/editing/blocks';
import type { Token } from '../src/editing/markdown-types';

function setup(source: string, options = {}) {
  const marp = new Marp({ script: false, ...options });
  const engine = createEngine(marp);
  return { engine, analysis: engine.analyze(source), marp };
}
function editRun(source: string, oldText: string, next: string, occurrence = 0) {
  const { engine, analysis } = setup(source);
  const run = analysis.runs.filter(r => r.text === oldText)[occurrence];
  expect(run, JSON.stringify(analysis.runs)).toBeDefined();
  expect(run.editable, JSON.stringify(run)).toBe(true);
  const result = engine.applyRunEdit(source, run.id, next);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.reason.description);
  return result;
}

describe('source mappings and validated edits', () => {
  it.each([
    'before <b>HTML</b> after',
    'before <b><i>HTML</i></b> after',
    'before <b title="a > b">HTML</b> after',
  ])('rejects edits inside HTML while preserving surrounding editable text: %s', source => {
    const { engine, analysis } = setup(source);
    const html = analysis.runs.find(run => run.text === 'HTML')!;
    expect(html).toMatchObject({ editable: false, reason: { code: 'html' } });
    expect(engine.applyRunEdit(source, html.id, 'Changed')).toMatchObject({ ok: false, reason: { code: 'html' } });
    expect(analysis.runs.find(run => run.text === 'before ')?.editable).toBe(true);
    expect(analysis.runs.find(run => run.text === ' after')?.editable).toBe(true);
  });
  it.each([
    'before <b>HTML after',
    'before </b>HTML after',
    'before <b><i>HTML</b></i> after',
    'before <b/>HTML after',
  ])('makes the block read-only when HTML boundaries are uncertain: %s', source => {
    const { engine, analysis } = setup(source);
    expect(analysis.blocks[0]).toMatchObject({ editable: false, reason: { code: 'html' } });
    expect(analysis.runs.length).toBeGreaterThan(0);
    for (const run of analysis.runs) {
      expect(run).toMatchObject({ editable: false, reason: { code: 'html' } });
      expect(engine.applyRunEdit(source, run.id, 'Changed')).toMatchObject({ ok: false, reason: { code: 'html' } });
    }
  });
  it.each(['before <br> after', 'before <img src="x"/> after', 'before <!-- comment --> after'])('keeps text beside standalone HTML editable: %s', source => {
    expect(setup(source).analysis.runs.every(run => run.editable)).toBe(true);
  });
  it('changes the selected repeated text, never its siblings', () => {
    const source = '# same\n\nsame\n\n- same\n- same';
    expect(editRun(source, 'same', 'only this', 2).newText).toBe('# same\n\nsame\n\n- only this\n- same');
  });
  it.each([
    ['# Title', 'Title', '# Changed'],
    ['### Title ###  ', 'Title', '### Changed ###  '],
    ['Title\n=====', 'Title', 'Changed\n====='],
    ['Title\n-----', 'Title', 'Changed\n-----'],
    ['first\nsecond', 'second', 'first\nChanged'],
    ['- parent\n  - nested', 'nested', '- parent\n  - Changed'],
    ['> quoted\n> next', 'next', '> quoted\n> Changed'],
    ['> - nested', 'nested', '> - Changed'],
    ['1. item\n   continued', 'continued', '1. item\n   Changed'],
    ['before **bold** after', 'bold', 'before **Changed** after'],
    ['before *italic* after', 'italic', 'before *Changed* after'],
    ['before _italic_ after', 'italic', 'before _Changed_ after'],
    ['before ~~strike~~ after', 'strike', 'before ~~Changed~~ after'],
    ['[label](https://example.com "title")', 'label', '[Changed](https://example.com "title")'],
    ['[label][id]\n\n[id]: https://example.com', 'label', '[Changed][id]\n\n[id]: https://example.com'],
    ['left `code` right', ' right', 'left `code`Changed'],
  ])('edits %j preserving markers', (source, text, expected) => {
    expect(editRun(source, text, 'Changed').newText).toBe(expected);
  });
  it.each([
    ['hello \\* world', 'hello * world', 'hello X world', 'hello X world'],
    ['A &amp; B', 'A & B', 'A and B', 'A and B'],
    ['A &#x1F600; B', 'A 😀 B', 'A X B', 'A X B'],
    ['\\*same\\* &amp; same', '*same* & same', '*same* & changed', '\\*same\\* &amp; changed'],
  ])('preserves or replaces special segments in %j', (source, text, replacement, expected) => {
    expect(editRun(source, text, replacement).newText).toBe(expected);
  });
  it('keeps unedited raw bytes in mixed-EOL documents and metadata', () => {
    const raw = '---\r\nmarp: true\ntheme: default\r\n---\n<!-- color: red -->\r\n<style>section { color: red; }</style>\n\n# Title\r\n\r\nTarget\n\nTail  ';
    const normalized = splitEols(raw);
    const result = editRun(normalized.text, 'Target', 'Edited');
    const next = joinEols(applyEdit(normalized, result.edit).text, applyEdit(normalized, result.edit).eols);
    expect(next).toBe(raw.slice(0, raw.indexOf('Target')) + 'Edited' + raw.slice(raw.indexOf('Target') + 6));
  });
  it.each(['# text', '1. text', '* text', '---', '[label](https://example.com)', '*x*', '**x**', '<script>alert(1)</script>', '&amp;'])('escapes structural input %j or rejects it', input => {
    const source = 'text';
    const { engine, analysis } = setup(source);
    const result = engine.applyRunEdit(source, analysis.runs[0].id, input);
    if (result.ok) {
      expect(result.analysis.runs[0].text).toBe(input);
      expect(result.analysis.structure).toBe(analysis.structure);
      expect(result.analysis.html).not.toContain('<script>');
    } else expect(result.reason.code).toBe('structure-changed');
  });
  it('rejects empty whole runs that remove structure, newlines and stale revisions', () => {
    const { engine, analysis } = setup('hello');
    expect(engine.applyRunEdit('hello', analysis.runs[0].id, '')).toMatchObject({ ok: false, reason: { code: 'structure-changed' } });
    expect(engine.applyRunEdit('hello', analysis.runs[0].id, 'a\nb')).toMatchObject({ ok: false, reason: { code: 'newline' } });
    expect(engine.applyRunEdit('other', analysis.runs[0].id, 'x')).toMatchObject({ ok: false, reason: { code: 'stale-run' } });
    const next = engine.analyze('hello');
    expect(next.runs[0].id).not.toBe(analysis.runs[0].id);
    expect(engine.applyRunEdit('hello', analysis.runs[0].id, 'x')).toMatchObject({ ok: false, reason: { code: 'stale-run' } });
  });
  // This fixture initializes highlight.js and MathJax; allow headroom on busy runners.
  it('returns read-only reasons for unsupported source and generated content', () => {
    const source = '---\nmarp: true\nheader: Generated\n---\n\n| A | B |\n| - | - |\n| a | b |\n\n```ts\nconst x = 1\n```\n\nleft `code` ![alt](image.png) $x$ :smile: 😀 <b>HTML</b>\n\n<!-- note -->';
    const { analysis } = setup(source);
    const codes = analysis.readonly.map(r => r.reason.code);
    expect(codes).toEqual(expect.arrayContaining(['table', 'code', 'image', 'math', 'emoji', 'html', 'generated']));
    for (const block of analysis.blocks.filter(b => b.reason?.code === 'table')) {
      expect(block.editable).toBe(false);
    }
  }, 15_000);
  it('disables NUL and rejects non-normalized source', () => {
    const { engine, analysis } = setup('a\0b');
    expect(analysis.runs.every(r => !r.editable)).toBe(true);
    expect(analysis.readonly.some(r => r.reason.code === 'nul')).toBe(true);
    expect(() => engine.analyze('a\r\nb')).toThrow();
    expect(() => engine.analyze('\uFEFFtext')).toThrow();
  });
  it('guards against lost position metadata and renderer transforms', () => {
    const marp = new Marp({ script: false });
    const original = marp.markdown.renderer.rules.text;
    marp.markdown.renderer.rules.text = (...args: unknown[]) => `<i>${original(...args)}</i>`;
    const engine = createEngine(marp);
    expect(engine.analyze('text').runs[0]).toMatchObject({ editable: false, reason: { code: 'renderer-transform' } });
  });
  it('installs once and does not affect another Marp instance', () => {
    const marp = new Marp({ script: false });
    expect(createEngine(marp)).toBe(createEngine(marp));
    createEngine(marp).analyze('text');
    expect(new Marp({ script: false }).render('text').html).not.toContain('data-sm-run');
  });
  it('retains run identity across accepted edits for same-run history grouping', () => {
    const { engine, analysis } = setup('hello');
    const id = analysis.runs[0].id;
    const first = engine.applyRunEdit('hello', id, 'hello!');
    expect(first).toMatchObject({ ok: true });
    const second = engine.applyRunEdit('hello!', id, 'hello!!');
    expect(second).toMatchObject({ ok: true, newText: 'hello!!' });
    const redrawn = engine.analyze('hello!!');
    expect(resolveCursor(redrawn, { runId: id, offset: 7 })).toEqual({ runId: redrawn.runs[0].id, offset: 7 });
    expect(resolveCursor(redrawn, { runId: id, offset: 99 })?.offset).toBe(7);
    expect(resolveCursor(redrawn, { runId: 'unknown', offset: 0 })).toBeUndefined();
  });
  it.each(['# text', '1. text', '*x*'])('accepts %j using verified escaping', input => {
    const result = editRun('text', 'text', input);
    expect(result.escaped).toBe(true);
    expect(result.newText).toContain('\\');
  });
  it('fails closed when the parser rejects a candidate and keeps the old run usable', () => {
    const { marp, engine, analysis } = setup('text');
    const render = marp.render.bind(marp);
    marp.render = () => { throw new Error('Parser rejected source'); };
    expect(engine.applyRunEdit('text', analysis.runs[0].id, 'changed')).toMatchObject({ ok: false, reason: { code: 'invalid-source' } });
    marp.render = render;
    expect(engine.applyRunEdit('text', analysis.runs[0].id, 'changed')).toMatchObject({ ok: true, newText: 'changed' });
  });
  it('preserves multi-codepoint special segments as indivisible source ranges', () => {
    const source = 'a &NotEqualTilde; z';
    const result = editRun(source, 'a ≂̸ z', 'a ≂X̸ z');
    expect(result.edit).toEqual({ start: 2, end: 17, insert: '≂X̸' });
    expect(result.newText).toBe('a ≂X̸ z');
  });
  it('refuses ambiguous line alignments', () => {
    const inline = { content: '#', map: [0, 1] } as Token;
    const heading = { type: 'heading_open', markup: '#', map: [0, 1] } as Token;
    expect(mapBlockLines('# #', inline, heading)).toBeUndefined();
    const { analysis } = setup('# #');
    expect(analysis.runs.every(run => !run.editable)).toBe(true);
  });
  it('reports source metadata without editing it', () => {
    const { analysis } = setup('---\nmarp: true\n---\n<!-- color: red -->\n<style>section{color:red}</style>\n\ntext');
    expect(analysis.readonly.map(r => r.reason.code)).toEqual(expect.arrayContaining(['front-matter', 'comment', 'html']));
  });
});

describe('Marp render equivalence', () => {
  it.each([
    '# Title\n\nbody **bold** *italic* ~~strike~~ [link](https://example.com)',
    'Title\n=====\n\nfirst  \nsecond\nthird\\\nfourth\n\n- parent\n  - child\n\n> quote',
    '# fit title <!-- fit -->\n\nA &amp; B \\* &NotEqualTilde; `code` :smile: 😀',
    '---\nmarp: true\npaginate: true\nheader: Hi **there**\nfooter: Footer\n---\n\n# first\n\n---\n\n# second',
    '<style>section { color: red; }</style>\n\n![bg](image.png)\n\n| a | b |\n| - | - |\n| c | d |\n\n```ts\nconst x = 1\n```',
    'Visit https://example.com or <https://example.com> or test@example.com.\n\n$x+1$\n\n$$x^2$$',
    'unmatched ** and ***bold italic*** and ~~~odd~~~ and \\! &lt;x&gt;',
  ])('preserves original rendering for %j', source => {
    const expected = new Marp({ script: false }).render(source);
    const { analysis } = setup(source);
    const unmarked = analysis.html.replace(/<span data-sm-run="[^"]+">([\s\S]*?)<\/span>/g, '$1').replace(/ data-sm-block="[^"]+"/g, '');
    expect(unmarked).toBe(expected.html);
    expect(analysis.css).toBe(expected.css);
  });
});
