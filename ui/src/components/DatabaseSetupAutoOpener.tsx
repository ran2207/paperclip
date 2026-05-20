import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { healthApi } from "../api/health";
import { instanceDatabaseApi } from "../api/instanceDatabase";
import { queryKeys } from "../lib/queryKeys";

/**
 * Headless component. Auto-opens the database setup wizard once per session
 * when the destination database is reachable but the schema isn't initialized.
 *
 * Gated on `deploymentMode === "local_trusted"` because we can't tell from the
 * client whether the current user is instance-admin in authenticated mode —
 * surfacing the wizard to a non-admin would just produce 403s on apply. In
 * authenticated installations, admins reach the wizard via Instance Settings.
 *
 * Mount once at the App root, next to <DatabaseSetupWizard />. Returns null.
 */
export function DatabaseSetupAutoOpener() {
  const { databaseSetupOpen, openDatabaseSetup } = useDialog();
  const firedOnce = useRef(false);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const statusQuery = useQuery({
    queryKey: ["instance", "database", "status"] as const,
    queryFn: () => instanceDatabaseApi.getStatus(),
    enabled: healthQuery.data?.deploymentMode === "local_trusted",
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (firedOnce.current) return;
    if (databaseSetupOpen) return;
    if (healthQuery.data?.deploymentMode !== "local_trusted") return;
    const status = statusQuery.data;
    if (!status || !status.reachable || status.schemaPresent) return;
    firedOnce.current = true;
    openDatabaseSetup();
  }, [databaseSetupOpen, healthQuery.data, statusQuery.data, openDatabaseSetup]);

  return null;
}
