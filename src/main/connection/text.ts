/**
 * Prometheus REST/WS sometimes returns message content as a Python repr of Anthropic
 * content blocks, e.g. `[TextBlock(type='text', text='Hello')]`. Collapse those to plain
 * text; pass anything else through unchanged. (Step 0.C porting note — the renderer-side
 * gateway-store does the same. Tool/result blocks are left for the richer Step-4 renderer.)
 */
export function extractText(raw: unknown): string {
  if (typeof raw !== 'string') return String(raw ?? '')
  if (!raw.startsWith('[') || !raw.includes('TextBlock')) return raw

  const parts: string[] = []
  for (const m of raw.matchAll(/TextBlock\(type='text',\s*text='((?:[^'\\]|\\.)*)'\)/g)) {
    parts.push(m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n'))
  }
  for (const m of raw.matchAll(/TextBlock\(type='text',\s*text="((?:[^"\\]|\\.)*)"\)/g)) {
    parts.push(m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'))
  }
  return parts.length > 0 ? parts.join('\n') : raw
}
