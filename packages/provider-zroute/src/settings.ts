// Shared with the client settings form; keep schema code browser-safe.
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  secretSetting,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const ZROUTE_DEFAULT_API_BASE = "https://api-dev.zroute.ai";

export const ZrouteSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    apiKey: TrimmedString.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API key",
        description: "Your zroute API key (zr_live_…). Stored on this server only.",
        providerSettingsForm: {
          control: "password",
          placeholder: "zr_live_…",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    apiBase: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed(ZROUTE_DEFAULT_API_BASE)),
      Schema.annotateKey({
        title: "API base URL",
        description: "zroute gateway the models are listed from and threads are routed through.",
        providerSettingsForm: { placeholder: ZROUTE_DEFAULT_API_BASE },
      }),
    ),
    binaryPath: makeBinaryPathSetting("pi").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Pi coding agent binary that runs zroute threads.",
        providerSettingsForm: { placeholder: "pi", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["apiKey", "apiBase", "binaryPath"],
  },
);
export type ZrouteSettings = typeof ZrouteSettings.Type;
