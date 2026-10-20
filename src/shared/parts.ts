// Pure, React-free content-parts model + the content_json adapter. Lives in `shared` so the main
// process (and its headless smokes) and the renderer use ONE definition. The daemon persists the
// structured block list as a JSON string (`content_json`, Prometheus feat/lcm-structured-content);
// this maps it to the renderer's ContentPart[] — the HISTORY analog of the live tool_call_* frames.

/** A renderer-facing content part. Loosely-typed union (optional fields per `type`). */
export interface ContentPart {
  type: 'text' | 'toolCall' | 'toolResult' | 'image' | 'file' | 'thinking'
  /** text; ALSO the thinking body for type 'thinking' (PARITY-PLAN B2). */
  text?: string
  /** thinking only: a redacted_thinking block — content withheld by the provider; the disclosure
   * says so instead of rendering an empty reveal. */
  redacted?: boolean
  // toolCall (from daemon tool_use)
  id?: string
  name?: string
  args?: unknown
  // toolResult (from daemon tool_result). Correlate to its call via toolUseId === toolCall.id
  // — the history analog of the live call_id.
  toolUseId?: string
  output?: string
  error?: boolean
  // image / file: originally OPTIMISTIC renderer-only parts from the composer. Since the daemon's
  // image blocks (Prometheus#278) image parts ALSO come from content_json (PARITY-PLAN B3):
  // `dataUrl` present → an inline thumbnail (composer-optimistic, or a stored block that kept its
  // bytes because it had no source_path to recover from). `dataUrl` absent but `sourcePath` set →
  // the daemon holds the bytes and Beacon cannot fetch them until the media endpoint (Phase 3b)
  // lands — rendered as an HONEST placeholder carrying `description` when one was generated.
  dataUrl?: string
  fileName?: string
  fileSize?: number
  mimeType?: string
  /** image (B3): the daemon-side file reference — displayed-from, never dereferenced client-side. */
  sourcePath?: string
  /** image (B3): the daemon's generated description, the placeholder's caption. */
  description?: string
}

/** The daemon's persisted block shapes — content_json is a JSON array of these. */
interface DaemonBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  /** thinking blocks (B2): the Anthropic wire shape is {type:'thinking', thinking:'…'} (plus a
   * signature Beacon ignores); redacted_thinking carries an opaque `data` field instead. */
  thinking?: string
  /** image blocks (B3, Prometheus#278): data kept ONLY when there is no source_path to recover
   * from; media_type beside it; description when the daemon generated one. */
  media_type?: string
  data?: string
  source_path?: string
  description?: string | null
}

/**
 * Parse the daemon's `content_json` (a JSON string of content blocks) into ContentPart[]:
 *   text        {type:"text",text}                                → {type:"text", text}
 *   tool_use    {type:"tool_use",id,name,input}                   → {type:"toolCall", id, name, args:input}
 *   tool_result {type:"tool_result",tool_use_id,content,is_error} → {type:"toolResult", toolUseId, output, error}
 *   thinking    {type:"thinking",thinking}                        → {type:"thinking", text}   (B2)
 *   redacted_thinking                                             → {type:"thinking", redacted:true}
 * Truly unknown block types are still DROPPED. The thinking mapping is Beacon's side of the B2
 * daemon contract (persist model thinking blocks in content_json, Anthropic wire shape) — stated
 * here so the daemon half can match it, same pattern as @shared/connectors for issue 332.
 * `content_json` null / empty / invalid → fall back to the flat `content` text (legacy rows).
 */
export function partsFromContentJson(
  contentJson: string | null | undefined,
  flatContent: string
): ContentPart[] {
  const fallback = (): ContentPart[] => (flatContent ? [{ type: 'text', text: flatContent }] : [])
  if (!contentJson) return fallback()

  let blocks: unknown
  try {
    blocks = JSON.parse(contentJson)
  } catch {
    return fallback()
  }
  if (!Array.isArray(blocks)) return fallback()

  const parts: ContentPart[] = []
  for (const raw of blocks as DaemonBlock[]) {
    if (!raw || typeof raw !== 'object') continue
    if (raw.type === 'text') {
      parts.push({ type: 'text', text: typeof raw.text === 'string' ? raw.text : '' })
    } else if (raw.type === 'tool_use') {
      parts.push({ type: 'toolCall', id: raw.id, name: raw.name, args: raw.input })
    } else if (raw.type === 'tool_result') {
      const output =
        typeof raw.content === 'string' ? raw.content : raw.content == null ? '' : JSON.stringify(raw.content)
      parts.push({ type: 'toolResult', toolUseId: raw.tool_use_id, output, error: !!raw.is_error })
    } else if (raw.type === 'thinking') {
      // An empty thinking body renders nothing useful — treated as absent, not as an empty reveal.
      if (typeof raw.thinking === 'string' && raw.thinking) parts.push({ type: 'thinking', text: raw.thinking })
    } else if (raw.type === 'redacted_thinking') {
      parts.push({ type: 'thinking', redacted: true })
    } else if (raw.type === 'image') {
      // B3 (Prometheus#278): a stored image block. Bytes travel only when no source_path could
      // recover them — then Beacon renders the thumbnail directly. Otherwise the bytes live on
      // the daemon and the part is a REFERENCE the renderer shows as an honest placeholder until
      // the media endpoint (Phase 3b) exists to fetch them.
      const hasBytes = typeof raw.data === 'string' && raw.data.length > 0
      const sourcePath = typeof raw.source_path === 'string' && raw.source_path ? raw.source_path : undefined
      const description = typeof raw.description === 'string' && raw.description ? raw.description : undefined
      // A block with no bytes, no reference and no description says nothing — dropped, not an
      // empty placeholder.
      if (hasBytes || sourcePath || description)
        parts.push({
          type: 'image',
          dataUrl: hasBytes
            ? `data:${typeof raw.media_type === 'string' && raw.media_type ? raw.media_type : 'image/png'};base64,${raw.data}`
            : undefined,
          sourcePath,
          description
        })
    }
    // else: unknown block type — dropped (no renderer + no data source)
  }
  // A turn whose blocks are ONLY thinking still owes the reader its visible text — the flat
  // content rides along rather than being displaced by a disclosure with nothing under it.
  if (parts.length > 0 && parts.every((p) => p.type === 'thinking') && flatContent)
    parts.push({ type: 'text', text: flatContent })
  // Nothing usable parsed out → flat-content fallback (e.g. a turn of only unknown blocks).
  return parts.length > 0 ? parts : fallback()
}
