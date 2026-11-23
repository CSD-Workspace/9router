/**
 * Pre-configured Custom Header presets for spoofing / tool compatibility.
 * Mirrors patterns from agentrouterPolicy.js.
 */

export const HEADER_PRESETS = [
  {
    id: "claude-code",
    name: "Claude Code CLI",
    description: "Spoof Claude Code CLI (User-Agent, X-App, Anthropic headers)",
    headers: {
      "User-Agent": "claude-cli/2.1.280 (external, sdk-cli)",
      "X-App": "cli",
      "Anthropic-Dangerous-Direct-Browser-Access": "true",
      "Anthropic-Version": "2023-06-01",
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "Spoof OpenCode client",
    headers: {
      "User-Agent": "opencode/1.18.25",
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "Spoof Cursor IDE",
    headers: {
      "User-Agent": "Cursor/1.5.0 (external, cursor)",
      "X-App": "cursor",
    },
  },
  {
    id: "codex",
    name: "Codex CLI",
    description: "Spoof Codex CLI client",
    headers: {
      "User-Agent": "codex-cli/0.52.0 (external, codex)",
      "X-App": "codex",
    },
  },
  {
    id: "cline",
    name: "Cline",
    description: "Spoof Cline VS Code extension",
    headers: {
      "User-Agent": "Cline/3.18.0 (external, cline)",
      "X-App": "cline",
    },
  },
  {
    id: "roo-code",
    name: "Roo Code",
    description: "Spoof Roo Code extension",
    headers: {
      "User-Agent": "Roo-Code/3.20.0 (external, roo)",
      "X-App": "roo-code",
    },
  }
];
