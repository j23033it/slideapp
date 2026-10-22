export type Eol = '\r\n' | '\n' | '';
export interface NormalizedText { text: string; eols: Eol[] }

/** BOM is handled separately by the file boundary; never strip it here. */
export function splitEols(raw: string): NormalizedText {
  if (/\r(?!\n)/.test(raw)) throw new Error('Unsupported lone CR line ending');
  const eols: Eol[] = [];
  const text = raw.replace(/\r\n|\n/g, (eol) => { eols.push(eol as Eol); return '\n'; });
  eols.push('');
  return { text, eols };
}

export function joinEols(text: string, eols: readonly Eol[]): string {
  const lines = text.split('\n');
  if (lines.length !== eols.length || eols.at(-1) !== '' || eols.slice(0, -1).some(e => !e)) {
    throw new Error('Line endings do not match normalized text');
  }
  return lines.map((line, index) => line + eols[index]).join('');
}

export function preferredEol(eols: readonly Eol[]): Exclude<Eol, ''> {
  return eols.filter(e => e === '\r\n').length > eols.filter(e => e === '\n').length ? '\r\n' : '\n';
}
