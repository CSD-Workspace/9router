const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * ThinkStripper removes `<think>...</think>` spans at the stream chunk level.
 * Ported from agentrouter-spoof-proxy/internal/proxy/thinkstrip.go.
 *
 * It uses a state machine with a 6-byte/char trailing holdback (tagPrefixPending)
 * to reliably catch split tags across TCP chunk boundaries (e.g. "...<thi" | "nk>secret</think>").
 * If the stream ends while a <think> tag is still open, unterminated() reports true.
 */
export class ThinkStripper {
  constructor() {
    this.insideThinkTag = false;
    this.thinkBuf = "";
    this.tagPrefixPending = "";
  }

  /**
   * Process one chunk (string or Uint8Array) and return the stripped text.
   * @param {string|Uint8Array} chunk
   * @returns {string}
   */
  process(chunk) {
    if (!chunk || (chunk.length === 0 && typeof chunk !== "string")) {
      return "";
    }

    const str = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    if (!str) return "";

    let buf = this.tagPrefixPending ? this.tagPrefixPending + str : str;
    this.tagPrefixPending = "";

    if (this.insideThinkTag || buf.includes(THINK_OPEN)) {
      this.thinkBuf += buf;
      const out = [];
      let pos = 0;

      while (pos < this.thinkBuf.length) {
        if (this.insideThinkTag) {
          const endIdx = this.thinkBuf.indexOf(THINK_CLOSE, pos);
          if (endIdx === -1) {
            break;
          }
          this.insideThinkTag = false;
          pos = endIdx + THINK_CLOSE.length;
        } else {
          const startIdx = this.thinkBuf.indexOf(THINK_OPEN, pos);
          if (startIdx === -1) {
            out.push(this.thinkBuf.slice(pos));
            pos = this.thinkBuf.length;
            break;
          }
          out.push(this.thinkBuf.slice(pos, startIdx));
          this.insideThinkTag = true;
          pos = startIdx + THINK_OPEN.length;
        }
      }

      if (this.insideThinkTag) {
        // Unresolved span: retain only the unclosed <think> and onward
        const spanStart = this.thinkBuf.lastIndexOf(THINK_OPEN);
        this.thinkBuf = spanStart === -1 ? this.thinkBuf : this.thinkBuf.slice(spanStart);
        return out.join("");
      }

      this.thinkBuf = "";
      return out.join("");
    }

    // No tag boundary in this chunk: check if trailing chars could be a prefix of <think>
    let hold = 0;
    for (let l = 6; l >= 1; l--) {
      if (buf.length >= l && buf.endsWith(THINK_OPEN.slice(0, l))) {
        hold = l;
        break;
      }
    }

    if (hold > 0) {
      this.tagPrefixPending = buf.slice(-hold);
      return buf.slice(0, -hold);
    }

    return buf;
  }

  /**
   * Reports whether an unclosed <think> span is still buffered.
   * @returns {boolean}
   */
  unterminated() {
    return this.thinkBuf.length > 0 || this.insideThinkTag;
  }

  /**
   * Flush handles stream end. If an unclosed span remains, returns unterminated: true.
   * Otherwise returns any held-back prefix (legitimate text that never formed a tag).
   * @returns {{ forward: string, unterminated: boolean }}
   */
  flush() {
    if (this.insideThinkTag || this.thinkBuf.length > 0) {
      return { forward: "", unterminated: true };
    }
    if (this.tagPrefixPending.length > 0) {
      const f = this.tagPrefixPending;
      this.tagPrefixPending = "";
      return { forward: f, unterminated: false };
    }
    return { forward: "", unterminated: false };
  }
}

/**
 * Helper to strip thinking tags from a full non-streaming string.
 * @param {string} text
 * @returns {string}
 */
export function stripThinkingNonStreaming(text) {
  if (typeof text !== "string") return text;
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/g, "");
}

/**
 * Creates a TransformStream that strips thinking tags from streamed byte chunks.
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createThinkingStripperTransformStream() {
  const stripper = new ThinkStripper();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const clean = stripper.process(text);
      if (clean.length > 0) {
        controller.enqueue(encoder.encode(clean));
      }
    },
    flush(controller) {
      const { forward, unterminated } = stripper.flush();
      if (unterminated) {
        controller.error(new Error("Unterminated <think> tag detected in stream"));
        return;
      }
      if (forward && forward.length > 0) {
        controller.enqueue(encoder.encode(forward));
      }
    },
  });
}
