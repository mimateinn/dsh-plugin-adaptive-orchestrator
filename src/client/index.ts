/**
 * Adaptive orchestrator client: registers the settings page in the original
 * DSH Settings shell.
 */
import type { Context } from "@deepseek-ai/cordis";
// Type-only: pulls the 'settings.section' SlotMap entry and the
// ctx.settingsScope merge into this program.
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { AdaptiveOrchestratorSection } from "./AdaptiveOrchestratorSection.js";
import type { AdaptiveSettingsScope } from "./AdaptiveOrchestratorSection.js";

export { AdaptiveOrchestratorSection } from "./AdaptiveOrchestratorSection.js";
export type { AdaptiveSettingsScope } from "./AdaptiveOrchestratorSection.js";

export const name = "adaptive-orchestrator-client";

/** Required client services: the slot registry and the settings scope binder. */
export const inject = ["slots", "settingsScope"];

/** Settings namespace owned by the host plugin. */
const SETTINGS_NAMESPACE = "adaptive-orchestrator";

/** Section options understood by the settings shell (id/order/label). */
interface SectionOptions {
  name: string;
  id: string;
  order: number;
  label: () => string;
  inject: () => { scope: AdaptiveSettingsScope };
  component: unknown;
}

/** Slots service face used by the client (structural). */
interface SlotsServiceLike {
  inject(slot: string, register: () => unknown): void;
  register(options: SectionOptions): unknown;
}

/** Settings scope binder face (dsh-client-ui-settings client). */
interface SettingsScopeBinderLike {
  bind(spec: { namespace: string }): AdaptiveSettingsScope;
}

export function apply(ctx: Context): void {
  const slots = ctx.get("slots") as SlotsServiceLike | undefined;
  const scopeBinder = ctx.get("settingsScope") as
    SettingsScopeBinderLike | undefined;
  if (slots === undefined || scopeBinder === undefined) return;

  const scope = scopeBinder.bind({ namespace: SETTINGS_NAMESPACE });
  slots.inject("settings.section", () =>
    slots.register({
      name: "settings.section",
      id: "adaptive-orchestrator",
      order: 50,
      label: () => "Adaptive Orchestrator",
      inject: () => ({ scope }),
      component: AdaptiveOrchestratorSection,
    }),
  );
}
