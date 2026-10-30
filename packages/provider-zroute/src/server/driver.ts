// zroute is the Pi driver run against an isolated, generated Pi agent directory.
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { makePiDriver, type PiDriverEnv, type PiDriverOptions } from "@t3tools/provider-pi/server";
import { PiSettings } from "@t3tools/provider-pi/settings";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import { ZrouteSettings } from "../settings.ts";
import {
  fetchZrouteCatalog,
  PI_AGENT_DIR_ENV,
  syncZrouteAgentDir,
  zrouteAgentDir,
} from "./catalog.ts";

const DRIVER_KIND = ProviderDriverKind.make("zroute");
const DISPLAY_NAME = "zroute";
const MISSING_KEY_MESSAGE = "Add your zroute API key to list models.";

const decodeZrouteSettings = Schema.decodeSync(ZrouteSettings);
const decodePiSettings = Schema.decodeSync(PiSettings);

export type ZrouteDriverEnv = PiDriverEnv;

const instanceDirName = (instanceId: ProviderInstanceId) =>
  instanceId.replace(/[^A-Za-z0-9._-]/g, "_");

/** Keep only entries the user added by hand; the catalog is unusable. */
const withoutDiscoveredModels = (draft: ServerProviderDraft): ServerProviderDraft["models"] =>
  draft.models.filter((model) => model.isCustom);

export const ZrouteDriver: ProviderDriver<ZrouteSettings, ZrouteDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: DISPLAY_NAME,
    supportsMultipleInstances: true,
  },
  configSchema: ZrouteSettings,
  defaultConfig: (): ZrouteSettings => decodeZrouteSettings({}),
  create: Effect.fn("ZrouteDriver.create")(function* (input) {
    const host = yield* ProviderHost.ProviderHost;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const { apiKey, apiBase } = input.config;
    const agentDir = zrouteAgentDir(path, host.paths.baseDir, instanceDirName(input.instanceId));

    const wrapCheck: NonNullable<PiDriverOptions["wrapCheck"]> = Effect.fn("zroute.wrapCheck")(
      function* (check) {
        if (!input.enabled) return yield* check;
        if (apiKey === "") {
          // A removed key must not linger on disk.
          yield* fileSystem
            .remove(path.join(agentDir, "models.json"), { force: true })
            .pipe(Effect.ignore);
          const draft = yield* check;
          if (!draft.installed) return draft;
          return {
            ...draft,
            status: "warning",
            auth: { status: "unauthenticated" },
            message: MISSING_KEY_MESSAGE,
            models: withoutDiscoveredModels(draft),
          } satisfies ServerProviderDraft;
        }

        const catalog = yield* fetchZrouteCatalog(apiBase, apiKey).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.result,
        );
        if (Result.isFailure(catalog)) {
          const draft = yield* check;
          if (!draft.installed) return draft;
          return {
            ...draft,
            status: "error",
            auth: {
              status: catalog.failure.kind === "unauthorized" ? "unauthenticated" : "unknown",
            },
            message: catalog.failure.message,
            models: withoutDiscoveredModels(draft),
          } satisfies ServerProviderDraft;
        }

        yield* syncZrouteAgentDir({ agentDir, apiBase, apiKey, models: catalog.success }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        const draft = yield* check;
        return {
          ...draft,
          models: draft.models.map((model) =>
            model.slug === "default" ? { ...model, name: "zroute default" } : model,
          ),
        } satisfies ServerProviderDraft;
      },
    );

    const pi = makePiDriver({ driverKind: DRIVER_KIND, displayName: DISPLAY_NAME, wrapCheck });
    return yield* pi.create({
      ...input,
      config: decodePiSettings({
        enabled: input.enabled,
        binaryPath: input.config.binaryPath,
        customModels: input.config.customModels,
      }),
      // Ahead of the user's own variables, so an explicit override still wins.
      environment: [
        { name: PI_AGENT_DIR_ENV, value: agentDir, sensitive: false },
        ...input.environment,
      ],
    });
  }),
};
