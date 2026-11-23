import { resolveProviderAlias } from "../../../open-sse/services/model.js";
import { applyCaseInsensitiveHeaders } from "../../../open-sse/providers/compatibleHeaders.js";

export { applyCaseInsensitiveHeaders };

/**
 * Look up custom headers from settings.providerOverrides by trying all candidate keys:
 * - connectionId
 * - raw provider string
 * - canonical provider alias
 * - provider node id
 * - provider node prefix
 * - provider node name
 * - model prefix (e.g. from "xingchiapi2/gpt-6.1-sol")
 *
 * @param {object} overridesMap - settings.providerOverrides object
 * @param {object} options
 * @param {string} [options.provider]
 * @param {string} [options.model]
 * @param {string} [options.connectionId]
 * @param {Array} [options.providerNodes]
 * @returns {object} Merged custom headers
 */
export function lookupCustomHeaders(overridesMap, { provider, model, connectionId, providerNodes = [] } = {}) {
  if (!overridesMap || typeof overridesMap !== "object") return {};

  const candidateKeys = new Set();
  if (connectionId) candidateKeys.add(String(connectionId).toLowerCase());

  const addCandidate = (val) => {
    if (!val || typeof val !== "string") return;
    const clean = val.trim();
    if (!clean) return;
    candidateKeys.add(clean.toLowerCase());
    try {
      const alias = resolveProviderAlias(clean);
      if (alias) candidateKeys.add(alias.toLowerCase());
    } catch {}
  };

  addCandidate(provider);

  // Model prefix (e.g. "xingchiapi2/gpt-6.1-sol" -> "xingchiapi2")
  if (model && typeof model === "string" && model.includes("/")) {
    addCandidate(model.split("/")[0]);
  }

  // Match against provider nodes
  if (Array.isArray(providerNodes) && providerNodes.length > 0) {
    for (const node of providerNodes) {
      if (!node) continue;
      let nodePrefix = node.prefix;
      if (!nodePrefix && node.data) {
        try {
          const parsed = typeof node.data === "string" ? JSON.parse(node.data) : node.data;
          nodePrefix = parsed?.prefix;
        } catch {}
      }

      const nodeCandidates = [node.id, nodePrefix, node.name].filter(Boolean).map((s) => String(s).toLowerCase());
      const hasMatch = nodeCandidates.some((c) => candidateKeys.has(c));
      if (hasMatch) {
        for (const c of nodeCandidates) {
          candidateKeys.add(c);
        }
      }
    }
  }

  // Collect headers from overridesMap where lowercase key matches any candidate
  const result = {};
  for (const [key, entry] of Object.entries(overridesMap)) {
    if (!entry || typeof entry !== "object") continue;
    const lowerKey = key.toLowerCase();
    if (candidateKeys.has(lowerKey)) {
      if (entry.headers && typeof entry.headers === "object") {
        applyCaseInsensitiveHeaders(result, entry.headers);
      }
    }
  }

  return result;
}
