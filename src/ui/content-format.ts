export type JSONContainer = Record<string, unknown> | unknown[];
export type ContentBlock = { type: 'text'; text: string } | { type: 'json'; value: JSONContainer };

function parseContainer(text: string): JSONContainer | null {
  if (!/^[\[{]/.test(text.trimStart())) return null;
  try {
    const value: unknown = JSON.parse(text, (_key, value: unknown) => {
      // Do not silently round large IDs or timestamps in the readable view.
      if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new Error('Unsafe number');
      return value;
    });
    return value !== null && typeof value === 'object' ? value as JSONContainer : null;
  } catch { return null; }
}

// Only recognize complete JSON containers, never fragments embedded in prose or code.
export function formatContent(text: string): ContentBlock[] {
  const whole = parseContainer(text);
  if (whole) return [{ type: 'json', value: whole }];
  const blocks: ContentBlock[] = [];
  let pending = '';
  let fence: { character: string; length: number } | null = null;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      pending += line;
      continue;
    }
    const value = fence ? null : parseContainer(line);
    if (value) {
      if (pending) blocks.push({ type: 'text', text: pending });
      blocks.push({ type: 'json', value });
      pending = '';
    } else pending += line;
  }
  if (pending || !blocks.length) blocks.push({ type: 'text', text: pending });
  return blocks;
}
