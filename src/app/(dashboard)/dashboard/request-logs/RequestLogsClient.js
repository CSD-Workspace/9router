"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, ConfirmModal } from "@/shared/components";
import Pagination from "@/shared/components/Pagination";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";
import RequestLogDetailModal from "./RequestLogDetailModal";

const REFRESH_MS = 5000;
const TIME_PRESETS = [
  { label: "All time", value: "all" },
  { label: "Last 24h", value: "1" },
  { label: "Last 3 days", value: "3" },
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
];

let providerNameCache = null;
async function loadProviderNames() {
  if (providerNameCache) return providerNameCache;
  const nodes = await fetch("/api/provider-nodes").then((r) => r.json()).then((d) => d.nodes || []).catch(() => []);
  providerNameCache = { ...AI_PROVIDERS };
  for (const node of nodes) providerNameCache[node.id] = node.name;
  return providerNameCache;
}
function providerName(id, cache) {
  if (!id) return "-";
  const cached = cache?.[id];
  if (typeof cached === "string") return cached;
  if (cached?.name) return cached.name;
  return getProviderByAlias(id)?.name || AI_PROVIDERS[id]?.name || id;
}

function formatDuration(ms) {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function StatusCell({ status }) {
  const isSuccess = status === "success" || status === "OK" || (typeof status === "number" && status >= 200 && status < 400);
  const isFailed = status === "error" || (typeof status === "number" && status >= 400) || String(status).toUpperCase().includes("FAILED");
  const isPending = status === "PENDING";
  const color = isSuccess ? "text-green-600" : isFailed ? "text-red-600" : isPending ? "text-primary animate-pulse" : "text-text-muted";
  return <span className={`font-semibold ${color}`}>{String(status ?? "-")}</span>;
}

export default function RequestLogsClient() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selectedLogId, setSelectedLogId] = useState(null);
  const [nameCache, setNameCache] = useState(null);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, totalItems: 0, totalPages: 1 });
  const [stats, setStats] = useState(null);
  const [filterOptions, setFilterOptions] = useState({ providers: [], models: [], statuses: [] });

  // Filter state
  const [timePreset, setTimePreset] = useState("all");
  const [filterProvider, setFilterProvider] = useState("");
  const [filterModel, setFilterModel] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [clearing, setClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const { page, pageSize } = pagination;

  const buildFilterParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set("page", page);
    params.set("pageSize", pageSize);
    if (timePreset !== "all") {
      const days = parseInt(timePreset, 10);
      params.set("startDate", new Date(Date.now() - days * 86400000).toISOString());
    }
    if (filterProvider) params.set("provider", filterProvider);
    if (filterModel) params.set("model", filterModel);
    if (filterStatus) params.set("status", filterStatus);
    return params.toString();
  }, [page, pageSize, timePreset, filterProvider, filterModel, filterStatus]);

  const fetchLogs = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/usage/request-details?${buildFilterParams()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLogs(data.details || []);
      if (data.pagination) setPagination((prev) => ({ ...prev, ...data.pagination }));
    } catch (error) {
      console.error("Failed to fetch request logs:", error);
      setLoadError(error.message);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [buildFilterParams]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/usage/request-details/filters");
      if (!res.ok) return;
      const data = await res.json();
      setFilterOptions({
        providers: data.providers || [],
        models: data.models || [],
        statuses: data.statuses || [],
      });
      const statsRes = await fetch("/api/usage/request-details?page=1&pageSize=1");
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData.pagination);
      }
    } catch {}
  }, []);

  useEffect(() => {
    loadProviderNames().then(setNameCache).catch(() => {});
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchLogs(true);
    fetchStats();
  }, [fetchLogs, fetchStats]);

  // Live tail — silent polling keeps data fresh even with detail modal open
  useEffect(() => {
    const interval = setInterval(() => fetchLogs(false), REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  const resetFilters = () => {
    setTimePreset("all");
    setFilterProvider("");
    setFilterModel("");
    setFilterStatus("");
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const handleClearAll = async () => {
    setClearing(true);
    try {
      await fetch("/api/usage/request-details", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "all" }),
      });
      setShowClearConfirm(false);
      await fetchLogs(true);
      await fetchStats();
    } catch {} finally {
      setClearing(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 px-1 sm:px-0">
      {/* Filter bar */}
      <Card>
        <div className="flex flex-wrap items-center gap-3 p-4">
          {/* Time presets */}
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-text-muted whitespace-nowrap">Time:</span>
            <div className="flex gap-1">
              {TIME_PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => { setTimePreset(p.value); setPagination((prev) => ({ ...prev, page: 1 })); }}
                  className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                    timePreset === p.value
                      ? "border-primary bg-primary/10 text-primary font-medium"
                      : "border-border text-text-muted hover:border-primary/40 hover:text-text-main"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="w-px h-6 bg-border self-center" />

          {/* Dropdown filters */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filterStatus}
              onChange={(e) => { setFilterStatus(e.target.value); setPagination((prev) => ({ ...prev, page: 1 })); }}
              className="h-8 px-2 rounded-lg border border-black/10 dark:border-white/10 bg-surface text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer"
              style={{ colorScheme: "auto" }}
            >
              <option value="">All statuses</option>
              {filterOptions.statuses.map((s) => (
                <option key={s} value={s}>{s || "-"}</option>
              ))}
            </select>

            <select
              value={filterProvider}
              onChange={(e) => { setFilterProvider(e.target.value); setPagination((prev) => ({ ...prev, page: 1 })); }}
              className="h-8 px-2 rounded-lg border border-black/10 dark:border-white/10 bg-surface text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer"
              style={{ colorScheme: "auto" }}
            >
              <option value="">All providers</option>
              {filterOptions.providers.map((p) => (
                <option key={p} value={p}>{providerName(p, nameCache)}</option>
              ))}
            </select>

            <select
              value={filterModel}
              onChange={(e) => { setFilterModel(e.target.value); setPagination((prev) => ({ ...prev, page: 1 })); }}
              className="h-8 px-2 rounded-lg border border-black/10 dark:border-white/10 bg-surface text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer"
              style={{ colorScheme: "auto" }}
            >
              <option value="">All models</option>
              {filterOptions.models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {/* Actions */}
          <div className="ml-auto flex items-center gap-2">
            {(timePreset !== "all" || filterProvider || filterModel || filterStatus) && (
              <Button size="sm" variant="ghost" onClick={resetFilters} className="text-xs">
                Clear filters
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowClearConfirm(true)}
              disabled={!stats || stats.totalItems === 0}
              className="text-xs text-error border-error/40 hover:bg-error/10"
            >
              Clear logs
            </Button>
          </div>
        </div>
      </Card>

      {/* Stats row */}
      {stats && (
        <div className="flex gap-4 text-xs text-text-muted px-1">
          <span><span className="font-medium text-text-main">{stats.totalItems}</span> records</span>
          <span>Page {stats.page} / {stats.totalPages}</span>
        </div>
      )}

      {/* Table */}
      <Card padding="none">
        <div className="overflow-x-auto">
          {loading && logs.length === 0 ? (
            <div className="p-8 text-center text-text-muted">
              <span className="material-symbols-outlined animate-spin text-[20px] align-middle mr-2">progress_activity</span>
              Loading request logs...
            </div>
          ) : loadError ? (
            <div className="p-8 text-center">
              <div className="text-error mb-2">Failed to load request logs.</div>
              <Button size="sm" variant="outline" onClick={() => fetchLogs(true)}>Retry</Button>
            </div>
          ) : logs.length === 0 ? (
            <div className="p-8 text-center text-text-muted">
              <div className="mb-1">No request logs found.</div>
              <div className="text-xs opacity-70">Try adjusting your filters or generate a request through 9Router.</div>
            </div>
          ) : (
            <table className="w-full min-w-[880px]">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/5">
                  <th className="text-left p-4 text-sm font-semibold text-text-main">Timestamp</th>
                  <th className="text-left p-4 text-sm font-semibold text-text-main">Status</th>
                  <th className="text-left p-4 text-sm font-semibold text-text-main">Model</th>
                  <th className="text-left p-4 text-sm font-semibold text-text-main">Provider</th>
                  <th className="text-left p-4 text-sm font-semibold text-text-main">Account</th>
                  <th className="text-right p-4 text-sm font-semibold text-text-main">Tokens In/Out</th>
                  <th className="text-right p-4 text-sm font-semibold text-text-main">Duration</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, index) => {
                  const durationMs = log.durationMs ?? log.latency?.total ?? null;
                  const inputTokens = log.tokens?.prompt_tokens ?? log.tokens?.input_tokens ?? 0;
                  const outputTokens = log.tokens?.completion_tokens ?? log.tokens?.output_tokens ?? 0;
                  return (
                    <tr
                      key={`${log.id}-${index}`}
                      onClick={() => setSelectedLogId(log.id)}
                      className="border-b border-black/5 dark:border-white/5 last:border-b-0 cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="whitespace-nowrap p-4 text-sm text-text-muted">
                        {new Date(log.timestamp).toLocaleString()}
                      </td>
                      <td className="p-4 text-sm"><StatusCell status={log.status} /></td>
                      <td className="max-w-[220px] truncate p-4 font-mono text-sm text-primary" title={log.model}>
                        {log.model || "-"}
                      </td>
                      <td className="max-w-[180px] truncate p-4 text-sm font-medium text-text-main" title={log.provider}>
                        {providerName(log.provider, nameCache)}
                      </td>
                      <td className="max-w-[130px] truncate p-4 text-sm text-text-muted font-mono" title={log.connectionId}>
                        {log.connectionId ? `${log.connectionId.slice(0, 8)}...` : "-"}
                      </td>
                      <td className="whitespace-nowrap p-4 text-right text-sm font-mono">
                        <span className="text-text-muted">IN </span>
                        <span className="text-primary">{inputTokens}</span>
                        <span className="mx-1 text-border">|</span>
                        <span className="text-text-muted">OUT </span>
                        <span className="text-green-600">{outputTokens}</span>
                      </td>
                      <td className="p-4 text-right text-sm font-mono text-text-main">
                        {formatDuration(durationMs)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {!loadError && logs.length > 0 && (
          <div className="border-t border-black/5 dark:border-white/5">
            <Pagination
              currentPage={page}
              pageSize={pageSize}
              totalItems={pagination.totalItems}
              onPageChange={(p) => setPagination((prev) => ({ ...prev, page: p }))}
              onPageSizeChange={(s) => setPagination((prev) => ({ ...prev, pageSize: s, page: 1 }))}
            />
          </div>
        )}
      </Card>

      {selectedLogId && (
        <RequestLogDetailModal logId={selectedLogId} onClose={() => setSelectedLogId(null)} />
      )}

      <ConfirmModal
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={handleClearAll}
        title="Clear all request logs?"
        message={`This will permanently delete all ${stats?.totalItems ?? 0} request log records. This action cannot be undone.`}
        confirmText="Clear all"
        variant="danger"
        loading={clearing}
      />
    </div>
  );
}