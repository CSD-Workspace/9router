// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  registerActiveRequest, unregisterActiveRequest,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs, clearUsageData, deleteUsageDataBefore,
  saveRequestDetail, getRequestDetails, getRequestDetailById,
  getDistinctProviders, getDistinctModels, getDistinctStatuses,
  getRequestDetailsStats, clearRequestDetails, deleteRequestDetailsBefore,
} from "@/lib/db/index.js";