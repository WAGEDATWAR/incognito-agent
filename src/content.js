// Helpers for chat message content, which is a string or (with images) an array of OpenAI content parts.

const IMAGE_COST_CHARS = 6000; // rough: an image is ~1500 tokens, and we count ~4 chars per token

/**
 * Converts an ACP prompt (content blocks) into message content. Returns a plain string unless the prompt
 * has images the model can see. Images for a model without vision become a short text note instead.
 */
export function promptToContent(blocks, { vision = false } = {}) {
  const text = [];
  const images = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text': text.push(b.text); break;
      case 'resource': {
        const r = b.resource ?? {};
        text.push(r.text !== undefined ? `<file uri="${r.uri}">\n${r.text}\n</file>` : `[resource ${r.uri}]`);
        break;
      }
      case 'resource_link': text.push(`[file: ${b.uri}]`); break;
      case 'image':
        if (vision && b.data) images.push({ type: 'image_url', image_url: { url: `data:${b.mimeType ?? 'image/png'};base64,${b.data}` } });
        else text.push('[An image was attached, but the selected model cannot view images.]');
        break;
      default: break;
    }
  }
  const joined = text.filter(Boolean).join('\n\n');
  return images.length ? [{ type: 'text', text: joined || 'See the attached image.' }, ...images] : joined;
}

/** Text of a message's content (images are dropped). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

/** Approximate size in characters, used for the context meter and history trimming. */
export function contentLength(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : IMAGE_COST_CHARS), 0);
}
