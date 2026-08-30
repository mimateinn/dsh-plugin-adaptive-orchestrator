/**
 * Adaptive Orchestrator settings page: the global toggle and the sensitive
 * allowlist, bound to the host 'adaptive-orchestrator' settings namespace.
 */
import { useCallback, useSyncExternalStore } from "react";

/** Client settings scope mirror of the host namespace (see dsh-client-ui-settings). */
export interface AdaptiveSettingsScope {
  getSnapshot(): { value?: unknown; status: string };
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<void>;
}

export interface AdaptiveSettingsSectionProps {
  /** Close the settings panel (shell-owned). */
  close: () => void;
  /** Bound settings scope injected by the registration. */
  scope: AdaptiveSettingsScope;
}

interface AdaptiveSettingsValue {
  enabled?: boolean;
  sensitive?: { enabled?: boolean; modelAllowlist?: string[] };
}

/** Normalize the wire section to the page's shape. */
function normalize(value: unknown): AdaptiveSettingsValue {
  if (value === null || typeof value !== "object") return {};
  const section = value as Record<string, unknown>;
  const sensitive =
    section.sensitive !== null && typeof section.sensitive === "object"
      ? (section.sensitive as Record<string, unknown>)
      : {};
  return {
    enabled: section.enabled === true,
    sensitive: {
      enabled: sensitive.enabled === true,
      modelAllowlist: Array.isArray(sensitive.modelAllowlist)
        ? (sensitive.modelAllowlist as string[])
        : [],
    },
  };
}

/** One labelled toggle row. */
function Toggle(props: {
  checked: boolean;
  label: string;
  hint: string;
  disabled?: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <label style={{ display: "block", margin: "12px 0" }}>
      <span style={{ fontWeight: 600 }}>{props.label}</span>
      <br />
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span style={{ marginLeft: 8 }}>{props.hint}</span>
    </label>
  );
}

/** The Adaptive Orchestrator settings page. */
export function AdaptiveOrchestratorSection(
  props: AdaptiveSettingsSectionProps,
) {
  const snapshot = useSyncExternalStore(
    props.scope.subscribe,
    props.scope.getSnapshot,
  );
  const value = normalize(snapshot.value);
  const updateEnabled = useCallback(
    (next: boolean) => {
      void props.scope.set("enabled", next);
    },
    [props.scope],
  );
  const updateSensitive = useCallback(
    (next: boolean) => {
      void props.scope.set("sensitive", { ...value.sensitive, enabled: next });
    },
    [props.scope, value.sensitive],
  );
  const updateAllowlist = useCallback(
    (text: string) => {
      const modelAllowlist = text
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      void props.scope.set("sensitive", { ...value.sensitive, modelAllowlist });
    },
    [props.scope, value.sensitive],
  );
  const unavailable = snapshot.status === "unavailable";

  return (
    <section>
      <h3>Adaptive Orchestration</h3>
      <p>
        Route execution work to subscription-backed workers and scale subagent
        concurrency near quota resets. The captain model is never changed
        automatically.
      </p>
      <Toggle
        checked={value.enabled === true}
        disabled={unavailable}
        label="Adaptive orchestration"
        hint={
          unavailable
            ? "Unavailable on this host."
            : "Applies to newly created top-level work."
        }
        onChange={updateEnabled}
      />
      <fieldset
        disabled={value.enabled !== true}
        style={{ border: "1px solid #888", margin: "12px 0", padding: 12 }}
      >
        <legend>Sensitive mode</legend>
        <Toggle
          checked={value.sensitive?.enabled === true}
          disabled={unavailable || value.enabled !== true}
          label="Restrict workers to an allowlist"
          hint="When empty or unavailable, routing fails closed."
          onChange={updateSensitive}
        />
        <label style={{ display: "block" }}>
          Allowed model IDs (comma separated)
          <br />
          <textarea
            rows={4}
            style={{ width: "100%", marginTop: 6 }}
            value={(value.sensitive?.modelAllowlist ?? []).join(", ")}
            disabled={unavailable || value.sensitive?.enabled !== true}
            onChange={(event) => updateAllowlist(event.currentTarget.value)}
          />
        </label>
      </fieldset>
    </section>
  );
}
