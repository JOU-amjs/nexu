import * as amplitude from "@amplitude/unified";
import { Identify } from "@amplitude/unified";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { Toaster, toast } from "sonner";
import type {
  DesktopRuntimeConfig,
  RuntimeState,
  RuntimeUnitId,
  RuntimeUnitPhase,
  RuntimeUnitState,
} from "../shared/host";
import { apiFetch } from "./lib/api-client";
import {
  getRuntimeConfig,
  getRuntimeIdentifiers,
  getRuntimeState,
  startAllUnits,
  startUnit,
  stopAllUnits,
  stopUnit,
} from "./lib/host-api";
import "./runtime-page.css";

type ModelProviderConfig = {
  id: string;
  poolId: string;
  providerKey: string;
  baseUrl: string;
  apiType: string;
  status: "active" | "disabled";
  models: Array<{
    id: string;
    name?: string;
    reasoning?: boolean;
    input?: string[];
    contextWindow?: number;
    maxTokens?: number;
  }>;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
};

const amplitudeApiKey = import.meta.env.VITE_AMPLITUDE_API_KEY;

if (amplitudeApiKey) {
  amplitude.initAll(amplitudeApiKey, {
    analytics: { autocapture: true },
    sessionReplay: { sampleRate: 1 },
  });
  const env = new Identify();
  env.set("environment", import.meta.env.MODE);
  amplitude.identify(env);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function phaseTone(phase: RuntimeUnitPhase): string {
  switch (phase) {
    case "running":
      return "is-running";
    case "failed":
      return "is-failed";
    case "starting":
    case "stopping":
      return "is-busy";
    default:
      return "is-idle";
  }
}

function kindLabel(unit: RuntimeUnitState): string {
  return `${unit.kind} / ${unit.launchStrategy}`;
}

function RuntimeUnitCard({
  unit,
  onStart,
  onStop,
  busy,
}: {
  unit: RuntimeUnitState;
  onStart: (id: RuntimeUnitId) => Promise<void>;
  onStop: (id: RuntimeUnitId) => Promise<void>;
  busy: boolean;
}) {
  const isManaged = unit.launchStrategy === "managed";
  const canStart =
    isManaged &&
    (unit.phase === "idle" ||
      unit.phase === "stopped" ||
      unit.phase === "failed");
  const canStop =
    isManaged && (unit.phase === "running" || unit.phase === "starting");

  return (
    <article className="runtime-card">
      <div className="runtime-card-head">
        <div>
          <div className="runtime-label-row">
            <strong>{unit.label}</strong>
            <span className={`runtime-badge ${phaseTone(unit.phase)}`}>
              {unit.phase}
            </span>
          </div>
          <p className="runtime-kind">{kindLabel(unit)}</p>
          <p className="runtime-command">
            {unit.commandSummary ?? "embedded runtime unit"}
          </p>
        </div>
        <div className="runtime-actions">
          <button
            disabled={!canStart || busy}
            onClick={() => void onStart(unit.id)}
            type="button"
          >
            Start
          </button>
          <button
            disabled={!canStop || busy}
            onClick={() => void onStop(unit.id)}
            type="button"
          >
            Stop
          </button>
        </div>
      </div>

      <dl className="runtime-grid">
        <div>
          <dt>PID</dt>
          <dd>{unit.pid ?? "-"}</dd>
        </div>
        <div>
          <dt>Port</dt>
          <dd>{unit.port ?? "-"}</dd>
        </div>
        <div>
          <dt>Auto start</dt>
          <dd>{unit.autoStart ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt>Exit code</dt>
          <dd>{unit.exitCode ?? "-"}</dd>
        </div>
      </dl>

      {unit.lastError ? (
        <p className="runtime-error">{unit.lastError}</p>
      ) : null}

      <div className="runtime-logs">
        <div className="runtime-logs-head">
          <strong>Tail 200 logs</strong>
          <span>{unit.logTail.length} lines</span>
        </div>
        <pre className="runtime-log-tail">
          {unit.logTail.length > 0 ? unit.logTail.join("\n") : "No logs yet."}
        </pre>
      </div>
    </article>
  );
}

function RuntimePage() {
  const [runtimeState, setRuntimeState] = useState<RuntimeState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeUnitId, setActiveUnitId] = useState<RuntimeUnitId | null>(null);

  const loadState = useCallback(async () => {
    try {
      const nextState = await getRuntimeState();
      setRuntimeState(nextState);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Failed to load runtime state.",
      );
    }
  }, []);

  useEffect(() => {
    void loadState();
    const timer = window.setInterval(() => {
      void loadState();
    }, 2000);

    return () => {
      window.clearInterval(timer);
    };
  }, [loadState]);

  const summary = useMemo(() => {
    const units = runtimeState?.units ?? [];
    return {
      running: units.filter((unit) => unit.phase === "running").length,
      failed: units.filter((unit) => unit.phase === "failed").length,
      managed: units.filter((unit) => unit.launchStrategy === "managed").length,
    };
  }, [runtimeState]);

  const units = runtimeState?.units ?? [];

  useEffect(() => {
    if (units.length === 0) {
      setActiveUnitId(null);
      return;
    }

    if (!activeUnitId || !units.some((unit) => unit.id === activeUnitId)) {
      setActiveUnitId(units[0]?.id ?? null);
    }
  }, [activeUnitId, units]);

  const activeUnit =
    units.find((unit) => unit.id === activeUnitId) ?? units[0] ?? null;

  async function runAction(id: string, action: () => Promise<RuntimeState>) {
    setBusyId(id);
    try {
      const nextState = await action();
      setRuntimeState(nextState);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Runtime action failed.",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="runtime-page">
      <header className="runtime-header">
        <div>
          <span className="runtime-eyebrow">Desktop Runtime</span>
          <h1>Nexu local cold-start control room</h1>
          <p>
            Renderer keeps the browser mental model. Electron main orchestrates
            local runtime units.
          </p>
        </div>
        <div className="runtime-header-actions">
          <button
            disabled={busyId !== null}
            onClick={() => void runAction("all:start", startAllUnits)}
            type="button"
          >
            Start all
          </button>
          <button
            disabled={busyId !== null}
            onClick={() => void runAction("all:stop", stopAllUnits)}
            type="button"
          >
            Stop all
          </button>
        </div>
      </header>

      <section className="runtime-summary">
        <div>
          <dt>Started at</dt>
          <dd>{runtimeState?.startedAt ?? "-"}</dd>
        </div>
        <div>
          <dt>Running</dt>
          <dd>{summary.running}</dd>
        </div>
        <div>
          <dt>Managed</dt>
          <dd>{summary.managed}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{summary.failed}</dd>
        </div>
      </section>

      <p className="runtime-note">
        Control plane currently renders unit metadata plus in-memory tail 200
        logs from the local orchestrator.
      </p>

      <ModelProviderPanel />

      {errorMessage ? (
        <p className="runtime-error-banner">{errorMessage}</p>
      ) : null}

      <section className="runtime-pane-layout">
        <aside className="runtime-sidebar" aria-label="Runtime units">
          {units.map((unit) => (
            <button
              aria-selected={activeUnit?.id === unit.id}
              className={
                activeUnit?.id === unit.id
                  ? "runtime-side-tab is-active"
                  : "runtime-side-tab"
              }
              key={unit.id}
              onClick={() => setActiveUnitId(unit.id)}
              role="tab"
              type="button"
            >
              <span className="runtime-side-tab-label">{unit.label}</span>
              <span className={`runtime-badge ${phaseTone(unit.phase)}`}>
                {unit.phase}
              </span>
            </button>
          ))}
        </aside>

        <div className="runtime-detail-pane">
          {activeUnit ? (
            <RuntimeUnitCard
              busy={busyId !== null}
              onStart={(id) => runAction(`start:${id}`, () => startUnit(id))}
              onStop={(id) => runAction(`stop:${id}`, () => stopUnit(id))}
              unit={activeUnit}
            />
          ) : (
            <section className="runtime-empty-state">
              No runtime units available.
            </section>
          )}
        </div>
      </section>
    </div>
  );
}

function ModelProviderPanel() {
  const [poolId, setPoolId] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiType, setApiType] = useState("openai-completions");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState(
    JSON.stringify(
      [
        {
          id: "anthropic/claude-sonnet-4",
          name: "Claude Sonnet 4",
          input: ["text", "image"],
          contextWindow: 200000,
          maxTokens: 8192,
        },
      ],
      null,
      2,
    ),
  );
  const [status, setStatus] = useState<"active" | "disabled">("active");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const loadProvider = useCallback(async () => {
    setLoading(true);
    try {
      const identifiers = await getRuntimeIdentifiers();
      setPoolId(identifiers.gatewayPoolId);

      const response = await apiFetch(
        `/api/v1/pools/${identifiers.gatewayPoolId}/model-providers`,
      );

      if (!response.ok) {
        throw new Error(`Failed to load model providers: ${response.status}`);
      }

      const payload = (await response.json()) as {
        providers: ModelProviderConfig[];
      };
      const provider = payload.providers.find(
        (entry) => entry.providerKey === "litellm",
      );

      if (provider) {
        setBaseUrl(provider.baseUrl);
        setApiType(provider.apiType);
        setStatus(provider.status);
        setModelsText(JSON.stringify(provider.models, null, 2));
        setMessage(
          provider.hasApiKey
            ? "Stored API key detected."
            : "No API key stored yet.",
        );
      } else {
        setMessage("No runtime model provider configured yet.");
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to load model provider.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProvider();
  }, [loadProvider]);

  async function handleSave() {
    if (!poolId) {
      toast.error("Runtime pool id is unavailable.");
      return;
    }

    let parsedModels: unknown;
    try {
      parsedModels = JSON.parse(modelsText);
    } catch {
      toast.error("Models must be valid JSON.");
      return;
    }

    if (!Array.isArray(parsedModels)) {
      toast.error("Models JSON must be an array.");
      return;
    }

    setSaving(true);
    try {
      const response = await apiFetch(
        `/api/v1/pools/${poolId}/model-providers/litellm`,
        {
          method: "PUT",
          body: JSON.stringify({
            baseUrl,
            apiType,
            apiKey: apiKey.trim().length > 0 ? apiKey : undefined,
            models: parsedModels,
            status,
          }),
        },
      );

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(payload?.message ?? `Save failed: ${response.status}`);
      }

      setApiKey("");
      setMessage("Model provider saved and runtime config republished.");
      toast.success("Model provider updated.");
      await loadProvider();
    } catch (error) {
      const text =
        error instanceof Error
          ? error.message
          : "Failed to save model provider.";
      setMessage(text);
      toast.error(text);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="runtime-provider-panel">
      <div className="runtime-provider-head">
        <div>
          <span className="runtime-eyebrow">Model Config</span>
          <h2>OpenClaw provider settings</h2>
          <p>
            Updates publish a fresh pool config snapshot. API and gateway
            restart are not required.
          </p>
        </div>
        <button
          disabled={loading || saving}
          onClick={() => void loadProvider()}
          type="button"
        >
          Refresh
        </button>
      </div>

      <div className="runtime-provider-grid">
        <label>
          <span>Pool</span>
          <input disabled value={poolId ?? "loading"} />
        </label>
        <label>
          <span>Provider</span>
          <input disabled value="litellm" />
        </label>
        <label>
          <span>Base URL</span>
          <input
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://litellm.example.com/v1"
            value={baseUrl}
          />
        </label>
        <label>
          <span>API Type</span>
          <input
            onChange={(event) => setApiType(event.target.value)}
            value={apiType}
          />
        </label>
        <label>
          <span>Status</span>
          <select
            onChange={(event) =>
              setStatus(event.target.value as "active" | "disabled")
            }
            value={status}
          >
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
        <label>
          <span>API Key</span>
          <input
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Leave blank to keep current key"
            type="password"
            value={apiKey}
          />
        </label>
      </div>

      <label className="runtime-provider-models">
        <span>Models JSON</span>
        <textarea
          onChange={(event) => setModelsText(event.target.value)}
          spellCheck={false}
          value={modelsText}
        />
      </label>

      {message ? <p className="runtime-note">{message}</p> : null}

      <div className="runtime-provider-actions">
        <button
          disabled={loading || saving || baseUrl.trim().length === 0}
          onClick={() => void handleSave()}
          type="button"
        >
          {saving ? "Saving..." : "Publish model config"}
        </button>
      </div>
    </section>
  );
}

function EmbeddedControlPlane() {
  return (
    <>
      <RuntimePage />
      <Toaster position="top-right" />
    </>
  );
}

function DesktopShell() {
  const [activeSurface, setActiveSurface] = useState<
    "web" | "openclaw" | "control"
  >("control");
  const [runtimeConfig, setRuntimeConfig] =
    useState<DesktopRuntimeConfig | null>(null);

  useEffect(() => {
    void getRuntimeConfig()
      .then(setRuntimeConfig)
      .catch(() => null);
  }, []);

  const desktopWebUrl = runtimeConfig
    ? new URL("/workspace", runtimeConfig.webUrl).toString()
    : null;
  const desktopOpenClawUrl = new URL(
    "/#token=gw-secret-token",
    "http://127.0.0.1:18789",
  ).toString();
  return (
    <div className="desktop-shell">
      <aside className="desktop-sidebar">
        <div className="desktop-sidebar-brand">
          <span className="desktop-shell-eyebrow">nexu desktop</span>
          <h1>Runtime Console</h1>
        </div>

        <nav className="desktop-nav" aria-label="Desktop surfaces">
          <button
            className={
              activeSurface === "web"
                ? "desktop-nav-item is-active"
                : "desktop-nav-item"
            }
            onClick={() => setActiveSurface("web")}
            type="button"
          >
            <span>Web</span>
            <small>HTTP sidecar</small>
          </button>
          <button
            className={
              activeSurface === "openclaw"
                ? "desktop-nav-item is-active"
                : "desktop-nav-item"
            }
            onClick={() => setActiveSurface("openclaw")}
            type="button"
          >
            <span>OpenClaw</span>
            <small>Gateway Control UI</small>
          </button>
          <button
            className={
              activeSurface === "control"
                ? "desktop-nav-item is-active"
                : "desktop-nav-item"
            }
            onClick={() => setActiveSurface("control")}
            type="button"
          >
            <span>Control Plane</span>
            <small>Local operator UI</small>
          </button>
        </nav>
      </aside>

      <main className="desktop-shell-stage">
        {activeSurface === "web" && desktopWebUrl ? (
          <webview className="desktop-web-frame" src={desktopWebUrl} />
        ) : activeSurface === "openclaw" && desktopOpenClawUrl ? (
          <webview className="desktop-web-frame" src={desktopOpenClawUrl} />
        ) : (
          <EmbeddedControlPlane />
        )}
      </main>
    </div>
  );
}

function RootApp() {
  return <DesktopShell />;
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RootApp />
    </QueryClientProvider>
  </React.StrictMode>,
);
