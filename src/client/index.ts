/** Browser half of the private Antigravity bootstrap capability bundle. */

import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { AntigravityAuthSettings } from "./AntigravityAuthSettings.js";
import { en, zh, type AntigravityAuthKey } from "./locales.js";
import type { AntigravityAuthSettingsProps } from "./AntigravityAuthSettings.js";
import type { AntigravityAuthRpcClient } from "./types.js";
import type { AntigravityImageSettings } from "../image-tool.js";

const NS = "settings.antigravityAuth";

export { AntigravityAuthSettings } from "./AntigravityAuthSettings.js";
export type { AntigravityAuthSettingsProps } from "./AntigravityAuthSettings.js";
export { en, zh } from "./locales.js";
export type { AntigravityAuthKey } from "./locales.js";

/** Client services required by the settings section and its loopback RPC. */
export const inject = ["slots", "locale", "connection", "settingsScope"];

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** Copy for the Antigravity bootstrap settings section. */
    "settings.antigravityAuth": AntigravityAuthKey;
  }
}

/** Register one disposable settings section and no capability controls. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "antigravity-auth: copy dictionaries");

  const connection = ctx.get("connection") as unknown as ConnectionHandle;
  if (!connection.isLoopback) return;
  const rpc = connection.rpc as unknown as AntigravityAuthRpcClient;
  const t = ctx.locale.bind(NS) as AntigravityAuthSettingsProps["t"];
  const settingsScope = (
    ctx as ClientContext & {
      settingsScope?: {
        bind<T>(spec: { namespace: string; decode?: (value: unknown) => T | undefined }): SettingsScope<T>;
      };
    }
  ).settingsScope;

  const imageScope = settingsScope?.bind<AntigravityImageSettings>({
    namespace: "antigravity-image",
    decode: decodeImageSettings
  });

  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const reset = (): void => {
    for (const listener of listeners) listener();
  };
  ctx.effect(() => ctx.on("connection/reset", reset), "antigravity-auth: connection invalidation");

  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "antigravity-auth",
        order: 20,
        label: () => t("nav"),
        inject: (): AntigravityAuthSettingsProps => ({ rpc, t, subscribe, imageScope })
      },
      AntigravityAuthSettings
    )
  );
}

function decodeImageSettings(value: unknown): AntigravityImageSettings | undefined {
  if (
    !isRecord(value) ||
    typeof value.enabled !== "boolean" ||
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    !positiveInteger(value.n) ||
    value.n > 4
  ) {
    return undefined;
  }
  return { enabled: value.enabled, model: value.model, n: value.n };
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
