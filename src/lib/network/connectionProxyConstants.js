// Shared between the server resolver and the dashboard UI.
//
// Deliberately dependency-free: the resolver module imports the database layer,
// so a client component must not import it just to read this sentinel.

// Stored in providerSpecificData.proxyPoolId when a connection uses "Random".
// It is not a pool id, so every lookup path has to special-case it.
export const randomProxyPool = "__random__";
