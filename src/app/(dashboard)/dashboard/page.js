import { getMachineId } from "@/shared/utils/machine";
import { getLocalEndpointUrls } from "@/shared/utils/localAddresses";
import EndpointPageClient from "./endpoint/EndpointPageClient";

// Same endpoint card as /dashboard/endpoint, so the LAN address has to be resolved
// per request here too — a prerendered copy would bake in the build machine's IP.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const machineId = await getMachineId();
  return <EndpointPageClient machineId={machineId} localUrls={await getLocalEndpointUrls()} />;
}
