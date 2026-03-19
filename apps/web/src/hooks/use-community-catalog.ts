import type { SkillhubCatalogData } from "@/types/desktop";
import "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getApiV1SkillhubCatalog,
  postApiV1SkillhubInstall,
  postApiV1SkillhubUninstall,
} from "../../lib/api/sdk.gen";

const CATALOG_QUERY_KEY = ["skillhub", "catalog"] as const;
const DETAIL_QUERY_KEY = ["skillhub", "detail"] as const;

const isElectron =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

type NexuHostBridge = {
  invoke(
    channel: "skillhub:get-catalog",
    payload: undefined,
  ): Promise<SkillhubCatalogData>;
  invoke(
    channel: "skillhub:install",
    payload: { slug: string },
  ): Promise<{ ok: boolean; error?: string }>;
  invoke(
    channel: "skillhub:uninstall",
    payload: { slug: string },
  ): Promise<{ ok: boolean; error?: string }>;
  invoke(
    channel: "skillhub:refresh-catalog",
    payload: undefined,
  ): Promise<{ ok: boolean; skillCount: number }>;
};

function getHostBridge(): NexuHostBridge | null {
  if (!isElectron) return null;
  const host = (window as Window & { nexuHost?: NexuHostBridge }).nexuHost;
  return host ?? null;
}

export function useCommunitySkills(opts?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: async (): Promise<SkillhubCatalogData> => {
      const host = getHostBridge();
      if (host) {
        return host.invoke("skillhub:get-catalog", undefined);
      }
      const { data, error } = await getApiV1SkillhubCatalog();
      if (error) throw new Error("Catalog fetch failed");
      return data as unknown as SkillhubCatalogData;
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: opts?.refetchInterval,
  });
}

export function useInstallSkill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (slug: string) => {
      const host = getHostBridge();
      if (host) {
        const result = await host.invoke("skillhub:install", { slug });
        if (!result.ok) throw new Error(result.error ?? "Install failed");
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: DETAIL_QUERY_KEY }),
        ]);
        return result;
      }
      const { data, error } = await postApiV1SkillhubInstall({
        body: { slug },
      });
      if (error) throw new Error("Install request failed");
      const result = data as { ok: boolean; error?: string };
      if (!result.ok) {
        throw new Error(result.error ?? "Install failed");
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: DETAIL_QUERY_KEY }),
      ]);
      return result;
    },
  });
}

export function useUninstallSkill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (slug: string) => {
      const host = getHostBridge();
      if (host) {
        const result = await host.invoke("skillhub:uninstall", { slug });
        if (!result.ok) throw new Error(result.error ?? "Uninstall failed");
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: DETAIL_QUERY_KEY }),
        ]);
        return result;
      }
      const { data, error } = await postApiV1SkillhubUninstall({
        body: { slug },
      });
      if (error) throw new Error("Uninstall request failed");
      const result = data as { ok: boolean; error?: string };
      if (!result.ok) {
        throw new Error(result.error ?? "Uninstall failed");
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: DETAIL_QUERY_KEY }),
      ]);
      return result;
    },
  });
}

export function useRefreshCatalog() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const host = getHostBridge();
      if (host) {
        return host.invoke("skillhub:refresh-catalog", undefined);
      }
      return { ok: true, skillCount: 0 };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
    },
  });
}
