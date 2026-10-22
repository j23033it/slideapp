/** Narrow view of the pinned markdown-it internals used by this plugin. */
export interface Token {
  type: string; tag: string; nesting: number; level: number; content: string; markup: string; info: string;
  map: [number, number] | null; hidden: boolean; block: boolean;
  children: Token[] | null; attrs: [string, string][] | null; meta: Record<string, unknown> | null;
  attrSet(name: string, value: string): void;
}
export interface InlineState {
  src: string; pos: number; posMax: number; pending: string; tokens: Token[]; md: Markdown;
  pushPending(): Token;
}
export type InlineRule = (state: InlineState, silent: boolean) => boolean;
interface Rule<T> { name: string; fn: T; enabled: boolean; alt: string[] }
export interface Ruler<T> {
  __rules__: Rule<T>[];
  at(name: string, rule: T, options?: { alt: string[] }): void;
  before(name: string, newName: string, rule: T): void;
  push(name: string, rule: T): void;
}
export interface CoreState { src: string; tokens: Token[] }
export type RenderRule = (tokens: Token[], index: number, options: unknown, env: unknown, self: Renderer) => string;
export interface Renderer { rules: Record<string, RenderRule>; renderToken: RenderRule }
export interface Markdown {
  inline: { ruler: Ruler<InlineRule>; ruler2: Ruler<(state: InlineState) => void>; State: new (...args: any[]) => InlineState };
  core: { ruler: Ruler<(state: CoreState) => void> };
  renderer: Renderer;
  utils: { escapeHtml(text: string): string };
}
export interface MarpLike {
  markdown: Markdown;
  render(text: string): { html: string; css: string };
}
