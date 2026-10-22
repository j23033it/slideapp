import type { InlineState, Markdown, Token } from './markdown-types';
import type { Segment } from './types';

interface Trace { segments: Segment[] }
// Marp clones every text token in its Unicode emoji pass, even without emoji.
// An enumerable symbol survives an unchanged clone; content equality rejects splits.
const traceKey = Symbol('slidemark-source');
type TracedToken = Token & { [traceKey]?: Trace };
const traces = {
  get: (token: Token) => (token as TracedToken)[traceKey],
  has: (token: Token) => traceKey in token,
  set: (token: Token, trace: Trace) => { (token as TracedToken)[traceKey] = trace; },
  delete: (token: Token) => { delete (token as TracedToken)[traceKey]; },
};
export function getSegments(token: Token): Segment[] | undefined {
  const segments = traces.get(token)?.segments;
  return segments?.map(s => s.text).join('') === token.content ? segments : undefined;
}
function mark(token: Token, start: number, end: number, source: string): void {
  if (!token.content) return;
  traces.set(token, { segments: [{ start, end, text: token.content,
    kind: source.slice(start, end) === token.content ? 'literal' : 'special' }] });
}

/** Merge exactly as markdown-it does, retaining a piecewise source map. */
function join(tokens: Token[], special: boolean): void {
  if (special) for (const token of tokens) if (token.type === 'text_special') token.type = 'text';
  for (let i = 0; i + 1 < tokens.length; i++) {
    const left = tokens[i], right = tokens[i + 1];
    if (left.type !== 'text' || right.type !== 'text') continue;
    const a = left.content ? getSegments(left) : [];
    const b = right.content ? getSegments(right) : [];
    right.content = left.content + right.content;
    if (a && b) traces.set(right, { segments: [...a, ...b] });
    else traces.delete(right);
    // Empty the left token so the native join keeps identical token order/levels.
    left.content = '';
    traces.set(left, { segments: [] });
  }
}

export function installTracking(md: Markdown): void {
  const pendingStart = new WeakMap<InlineState, number>();
  const BaseState = md.inline.State;
  md.inline.State = class TrackedInlineState extends BaseState {
    pushPending(): Token {
      const start = pendingStart.get(this) ?? this.pos - this.pending.length;
      const pending = this.pending;
      const token = super.pushPending();
      // Pending is raw source text. Refuse unexplained transformations.
      if (this.src.slice(start, start + pending.length) === pending) mark(token, start, start + pending.length, this.src);
      pendingStart.delete(this);
      return token;
    }
  };
  for (const { name, fn, alt } of [...md.inline.ruler.__rules__]) {
    md.inline.ruler.at(name, (state, silent) => {
      if (silent) return fn(state, silent);
      if (state.pending && !pendingStart.has(state)) pendingStart.set(state, state.pos - state.pending.length);
      const start = state.pos, count = state.tokens.length, pending = state.pending;
      const accepted = fn(state, silent);
      if (accepted) {
        const created = state.tokens.slice(count).filter(t => !traces.has(t));
        if (name === 'emphasis' || name === 'strikethrough') {
          let offset = start;
          for (const token of created) {
            if (token.type === 'text') { mark(token, offset, offset + token.content.length, state.src); offset += token.content.length; }
          }
        } else if (name === 'escape' || name === 'entity') {
          for (const token of created) if (token.type === 'text_special') mark(token, start, state.pos, state.src);
        } else if (name === 'autolink' || name === 'linkify') {
          const token = created.find(t => t.type === 'text');
          const offset = name === 'autolink' ? start + 1 : start - (pending.match(/([a-z][a-z0-9.+-]*)$/i)?.[1].length ?? 0);
          const end = name === 'autolink' ? state.pos - 1 : state.pos;
          if (token && state.src.slice(offset, end) === token.content) mark(token, offset, end, state.src);
        }
      }
      if (state.pending && !pendingStart.has(state)) pendingStart.set(state, state.pos - state.pending.length);
      if (!state.pending) pendingStart.delete(state);
      return accepted;
    }, { alt });
  }
  md.inline.ruler2.before('fragments_join', 'sm_fragments_join', state => join(state.tokens, false));
  md.core.ruler.before('text_join', 'sm_text_join', state => {
    for (const token of state.tokens) if (token.type === 'inline' && token.children) join(token.children, true);
  });
}
