import { getMachineId } from "@/shared/utils/machine";
import { getLocalEndpointUrls } from "@/shared/utils/localAddresses";
import EndpointPageClient from "./EndpointPageClient";

// The LAN address is a property of the running host, so it must be resolved per
// request — a prerendered copy would bake in whichever machine ran the build.
export const dynamic = "force-dynamic";

export default async function EndpointPage() {
  const machineId = await getMachineId();
  // Resolved here rather than in the browser: a page cannot see this host's interfaces.
  const localUrls = await getLocalEndpointUrls();
  return <EndpointPageClient machineId={machineId} localUrls={localUrls} />;
}
