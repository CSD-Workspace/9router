import { describe, it, expect } from "vitest";
import { ThinkStripper, stripThinkingNonStreaming } from "../../open-sse/utils/thinkstrip.js";

function runStripper(chunks = []) {
  const stripper = new ThinkStripper();
  let result = "";
  for (const c of chunks) {
    result += stripper.process(c);
  }
  const { forward, unterminated } = stripper.flush();
  if (forward) result += forward;
  return { result, unterminated };
}

describe("AgentRouter ThinkStripper (State Machine with 6-byte holdback)", () => {
  it("passes chunks without thinking tags untouched", () => {
    const { result, unterminated } = runStripper(["Hello, ", "World!"]);
    expect(result).toBe("Hello, World!");
    expect(unterminated).toBe(false);
  });

  it("strips thinking tags within a single chunk", () => {
    const cases = [
      { in: "a<think>secret</think>b", want: "ab" },
      { in: "<think>secret</think>b", want: "b" },
      { in: "a<think>secret</think>", want: "a" },
      { in: "<think>secret</think>", want: "" },
      { in: "a<think>1</think>b<think>2</think>c", want: "abc" },
      { in: "<think>1</think><think>2</think>", want: "" },
      { in: "a<think></think>b", want: "ab" },
    ];

    for (const tc of cases) {
      const { result, unterminated } = runStripper([tc.in]);
      expect(result).toBe(tc.want);
      expect(unterminated).toBe(false);
    }
  });

  it("handles opening tag split across chunks via holdback window", () => {
    // "<thi" in chunk 1, "nk>secret</think>tail" in chunk 2
    const { result, unterminated } = runStripper(["a<thi", "nk>secret</think>tail"]);
    expect(result).toBe("atail");
    expect(unterminated).toBe(false);

    // Single-character split across multiple chunks
    const { result: r2, unterminated: u2 } = runStripper(["<", "t", "h", "i", "n", "k>hidden</think>done"]);
    expect(r2).toBe("done");
    expect(u2).toBe(false);
  });

  it("handles closing tag split across chunks", () => {
    // "<think>secret</th" in chunk 1, "ink>final" in chunk 2
    const { result, unterminated } = runStripper(["prefix<think>secret</th", "ink>final"]);
    expect(result).toBe("prefixfinal");
    expect(unterminated).toBe(false);
  });

  it("preserves multi-byte UTF-8 characters and emoji", () => {
    // Tiếng Việt có dấu
    const { result: vn } = runStripper(["Xin chào Việt Nam ", "<think>đang suy nghĩ...</think>", "chúc bạn một ngày tốt lành!"]);
    expect(vn).toBe("Xin chào Việt Nam chúc bạn một ngày tốt lành!");

    // CJK and Emoji
    const { result: cjk } = runStripper(["你好👋<think>hidden</think>世界🚀"]);
    expect(cjk).toBe("你好👋世界🚀");

    // Multibyte character right before a held back tag prefix
    const stripper = new ThinkStripper();
    const out1 = stripper.process("Chào bạn<th");
    expect(out1).toBe("Chào bạn");
    const out2 = stripper.process("ink>bí mật</think> xong!");
    expect(out2).toBe(" xong!");
    expect(stripper.unterminated()).toBe(false);
  });

  it("flags unterminated span when stream ends prematurely", () => {
    const stripper = new ThinkStripper();
    const out = stripper.process("Clean prefix<think>unclosed thoughts...");
    expect(out).toBe("Clean prefix");
    expect(stripper.unterminated()).toBe(true);

    const { forward, unterminated } = stripper.flush();
    expect(unterminated).toBe(true);
    expect(forward).toBe("");
  });

  it("flushes legitimate held-back prefix that never formed a tag", () => {
    const stripper = new ThinkStripper();
    const out = stripper.process("Giá trị nhỏ hơn <thi");
    expect(out).toBe("Giá trị nhỏ hơn ");
    expect(stripper.unterminated()).toBe(false);

    const { forward, unterminated } = stripper.flush();
    expect(unterminated).toBe(false);
    expect(forward).toBe("<thi");
  });

  it("materializes held-back prefix when next chunk does not continue the tag", () => {
    const { result, unterminated } = runStripper(["abc<thi", "ZZZ"]);
    expect(result).toBe("abc<thiZZZ");
    expect(unterminated).toBe(false);
  });

  it("handles empty or null chunks without failing", () => {
    const stripper = new ThinkStripper();
    expect(stripper.process("")).toBe("");
    expect(stripper.process(null)).toBe("");
    expect(stripper.unterminated()).toBe(false);
    const { forward, unterminated } = stripper.flush();
    expect(forward).toBe("");
    expect(unterminated).toBe(false);
  });

  it("stripThinkingNonStreaming utility removes thinking spans cleanly", () => {
    expect(stripThinkingNonStreaming("abc<think>hidden</think>def")).toBe("abcdef");
    expect(stripThinkingNonStreaming("<think>all</think>")).toBe("");
    expect(stripThinkingNonStreaming("normal text")).toBe("normal text");
    expect(stripThinkingNonStreaming("unclosed<think>still thinking")).toBe("unclosed");
  });
});
