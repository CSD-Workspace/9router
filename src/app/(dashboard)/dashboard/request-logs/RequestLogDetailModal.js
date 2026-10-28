"use client";

import { useState, useEffect, useCallback } from "react";
import { Modal, Button } from "@/shared/components";

// Sanitize fields that should never be visible in the UI
const SECRET_KEYS = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie",
  "x-api-key", "api-key", "access-token", "refresh-token",
  "password", "secret", "token",
]);

function redactObject(value) {
  if (Array.isArray(value)) return value.map(redactObject);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = redactObject(child);
    }
  }
  return out;
}

function formatJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(redactObject(value), null, 2);
  } catch {
    return String(value);
  }
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback((e) => {
    e.stopPropagation();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      className={`text-[11px] font-medium px-3 py-1 rounded-md border transition-all ${
        copied
          ? "border-success/30 bg-success/10 text-success"
          : "border-border text-text-muted hover:text-text-main hover:bg-bg-subtle hover:border-text-muted/50"
      }`}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function PayloadSection({ title, value, defaultOpen = false, colorClass = "text-primary" }) {
  const [open, setOpen] = useState(defaultOpen);
  const formatted = formatJson(value);

  if (formatted === null || formatted === undefined) return null;

  return (
    <div className="border border-border/60 rounded-xl overflow-hidden bg-bg-base transition-all shrink-0">
      <div
        className="flex items-center justify-between bg-bg-subtle/50 hover:bg-bg-subtle cursor-pointer transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex-1 flex items-center gap-3 px-4 py-3">
          <span className={`text-[10px] transform transition-transform ${open ? "rotate-90" : ""} text-text-muted`}>
            ▶
          </span>
          <span className="text-xs font-bold uppercase tracking-wider text-text-main">
            {title}
          </span>
        </div>
        <div className="pr-4" onClick={(e) => e.stopPropagation()}>
          <CopyButton text={formatted} />
        </div>
      </div>
      {open && (
        <div className="overflow-auto max-h-[500px] bg-[#0a0a0a] p-4 font-mono text-xs border-t border-border/50">
          <pre className={`whitespace-pre-wrap break-all ${colorClass}`}>
            {formatted}
          </pre>
        </div>
      )}
    </div>
  );
}

// Normalize a top-level system prompt into renderable content (string | content-blocks array).
// Covers Claude (body.system: string | blocks[]) and Gemini (systemInstruction: {parts:[{text}]}).
function normalizeSystem(sys) {
  if (!sys) return null;
  if (typeof sys === "string") return sys.trim() ? sys : null;
  if (Array.isArray(sys)) return sys.length ? sys : null; // content blocks — render loop handles text blocks
  if (Array.isArray(sys.parts)) {
    const t = sys.parts.map((p) => p?.text || "").join("\n").trim();
    return t || null;
  }
  if (typeof sys.text === "string") return sys.text.trim() ? sys.text : null;
  return null;
}

function ConversationContext({ detail }) {
  const [open, setOpen] = useState(true);

  // Extract messages from clientRawRequest body or request body
  const requestMessages = detail?.clientRawRequest?.body?.messages ||
    detail?.request?.messages ||
    [];

  const messages = Array.isArray(requestMessages) ? [...requestMessages] : [];

  // Prepend the top-level system prompt (Claude/Gemini keep it outside `messages`).
  // Skip if a system message is already present (OpenAI format carries it inline).
  if (!messages.some((m) => m?.role === "system")) {
    const body = detail?.clientRawRequest?.body || detail?.request || {};
    const sys = normalizeSystem(body.system ?? body.systemInstruction);
    if (sys) messages.unshift({ role: "system", content: sys });
  }

  // Append the final response as an assistant message
  if (detail?.response?.content || detail?.response?.thinking) {
    const assistantMsg = { role: "assistant" };
    if (detail.response.thinking) {
      assistantMsg.content = [
        { type: "thinking", thinking: detail.response.thinking },
        { type: "text", text: detail.response.content || "" }
      ];
    } else {
      assistantMsg.content = detail.response.content;
    }
    messages.push(assistantMsg);
  }

  if (messages.length === 0) return null;

  return (
    <div className="border border-border/60 rounded-xl overflow-hidden bg-bg-base shrink-0">
      <div
        className="flex items-center justify-between bg-bg-subtle/50 hover:bg-bg-subtle cursor-pointer transition-colors px-4 py-3"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <span className={`text-[10px] transform transition-transform ${open ? "rotate-90" : ""} text-text-muted`}>
            ▶
          </span>
          <span className="text-xs font-bold uppercase tracking-wider text-text-main">
            Conversation Context
          </span>
        </div>
        <span className="text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-primary/15 text-primary">
          {messages.length} message{messages.length !== 1 ? "s" : ""}
        </span>
      </div>
      {open && (
        <div className="divide-y divide-border/40 max-h-[500px] overflow-y-auto bg-bg-base border-t border-border/50">
          {messages.map((msg, i) => {
            const role = msg.role || "unknown";
            const roleConfig = {
              system: { color: "text-yellow-500", bg: "bg-yellow-500/5", label: "SYSTEM" },
              user: { color: "text-blue-400", bg: "bg-blue-400/5", label: "USER" },
              assistant: { color: "text-green-500", bg: "bg-green-500/5", label: "ASSISTANT" },
              tool: { color: "text-purple-400", bg: "bg-purple-400/5", label: "TOOL" },
            };
            const config = roleConfig[role] || { color: "text-text-muted", bg: "bg-transparent", label: role.toUpperCase() };

            let content = msg.content;
            if (Array.isArray(content)) {
              content = content.map((c) => {
                if (typeof c === "string") return c;
                if (c.type === "text") return c.text || "";
                if (c.type === "image_url") return "[image]";
                if (c.type === "thinking") return `[thinking]\n${c.thinking}\n[/thinking]`;
                return JSON.stringify(c);
              }).join("\n\n");
            }
            if (typeof content !== "string") content = JSON.stringify(content || "");

            return (
              <div key={i} className={`px-5 py-4 ${config.bg}`}>
                <div className={`text-[11px] font-bold tracking-wider mb-2 flex items-center gap-2 ${config.color}`}>
                  {config.label}
                </div>
                <div className="text-[13px] leading-relaxed text-text-main font-mono whitespace-pre-wrap break-words opacity-90">
                  {content}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MetaTile({ label, value, mono = false, color = "text-text-main" }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex flex-col gap-1 p-3 rounded-lg bg-bg-subtle/30 border border-border/30 hover:bg-bg-subtle/50 transition-colors">
      <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`text-sm truncate font-medium ${mono ? "font-mono" : ""} ${color}`} title={String(value)}>
        {String(value)}
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const isSuccess = status === "success" || status === "OK" || (typeof status === "number" && status >= 200 && status < 400);
  const isError = status === "error" || (typeof status === "number" && status >= 400);
  const colorClass = isSuccess
    ? "bg-success/15 text-success border-success/30"
    : isError
      ? "bg-error/15 text-error border-error/30"
      : "bg-primary/15 text-primary border-primary/30";

  return (
    <span className={`px-2.5 py-1 text-[11px] font-bold rounded-md border tracking-wider ${colorClass}`}>
      {String(status ?? "\u2014").toUpperCase()}
    </span>
  );
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function maskAccount(id) {
  if (!id) return null;
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

export default function RequestLogDetailModal({ logId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);

  const loadDetail = useCallback(async () => {
    if (!logId) return;
    setLoading(true);
    setFetchError(null);
    setDetail(null);
    try {
      const res = await fetch(`/api/usage/request-details/${encodeURIComponent(logId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail(await res.json());
    } catch (err) {
      setFetchError(err.message);
    } finally {
      setLoading(false);
    }
  }, [logId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDetail();
  }, [loadDetail]);

  const endpoint = detail?.clientRawRequest?.endpoint || detail?.endpoint || "/v1/chat/completions";
  const durationMs = detail?.durationMs ?? detail?.latency?.total ?? null;
  const startedAt = detail?.startedAt || detail?.timestamp;
  const endedAt = detail?.endedAt;
  // Model the client actually asked for (alias/combo) before resolution to provider/model.
  const requestedModel = detail?.requestedModel || detail?.clientRawRequest?.body?.model || null;
  const inputTokens = detail?.tokens?.prompt_tokens ?? detail?.tokens?.input_tokens ?? 0;
  const outputTokens = detail?.tokens?.completion_tokens ?? detail?.tokens?.output_tokens ?? 0;
  const cachedTokens = detail?.tokens?.cached_tokens ?? 0;
  const reasoningTokens = detail?.tokens?.reasoning_tokens ?? 0;

  return (
    <Modal isOpen={!!logId} onClose={onClose} title="Request Log Detail" size="xl">
      {loading ? (
        <div className="p-12 text-center text-text-muted">Loading details...</div>
      ) : fetchError ? (
        <div className="p-12 text-center text-error">Failed to load detail: {fetchError}</div>
      ) : !detail ? (
        <div className="p-12 text-center text-text-muted">No detail found.</div>
      ) : (
        <div className="flex flex-col gap-4 max-h-[80vh] overflow-y-auto pr-2 pb-4">

          {/* Header: status + method + endpoint */}
          <div className="flex items-center gap-4 p-4 bg-bg-subtle/50 rounded-xl border border-border/60 shrink-0">
            <StatusBadge status={detail.status} />
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              <div className="text-[15px] font-mono font-semibold text-text-main truncate">
                POST {endpoint}
              </div>
              <div className="text-[11px] text-text-muted font-mono truncate" title={detail.id}>
                ID: {detail.id}
              </div>
            </div>
          </div>

          {/* Summary tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 shrink-0">
            <MetaTile label="Started At" value={formatDate(startedAt)} />
            <MetaTile label="Ended At" value={formatDate(endedAt)} />
            <MetaTile label="Duration" value={formatDuration(durationMs)} mono />
            <MetaTile label="Model" value={detail.model} mono />
            <MetaTile label="Requested Model" value={requestedModel && requestedModel !== detail.model ? requestedModel : null} mono />
            <MetaTile label="Provider" value={detail.provider?.toUpperCase()} color="text-primary" />
            <MetaTile label="Account" value={maskAccount(detail.connectionId)} mono />
            <MetaTile label="Input Tokens" value={inputTokens > 0 ? inputTokens : null} mono />
            <MetaTile label="Output Tokens" value={outputTokens > 0 ? outputTokens : null} mono />
            <MetaTile label="Cached Tokens" value={cachedTokens > 0 ? cachedTokens : null} mono />
            <MetaTile label="Reasoning Tokens" value={reasoningTokens > 0 ? reasoningTokens : null} mono />
            <MetaTile label="TTFT" value={detail.latency?.ttft ? `${detail.latency.ttft}ms` : null} mono />
          </div>

          {/* Conversation Context */}
          <ConversationContext detail={detail} />

          {/* Payload stages, in request lifecycle order. Each PayloadSection
              renders null when its data is absent, so stages only appear when real. */}
          <PayloadSection
            title="CLIENT RAW REQUEST"
            value={detail.clientRawRequest || detail.request}
            defaultOpen={false}
            colorClass="text-[#a6e22e]"
          />

          <PayloadSection
            title="PROVIDER REQUEST"
            value={detail.providerRequest}
            colorClass="text-[#66d9ef]"
          />

          <PayloadSection
            title="PROVIDER RESPONSE"
            value={detail.providerResponse}
            colorClass="text-[#e6db74]"
          />

          <PayloadSection
            title="CLIENT RESPONSE"
            value={detail.response}
            colorClass="text-[#fd971f]"
          />
        </div>
      )}
    </Modal>
  );
}
