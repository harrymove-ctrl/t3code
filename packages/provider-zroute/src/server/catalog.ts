// Pure catalog mapping plus the isolated Pi agent directory writer. No secrets are ever logged.
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

export const ZROUTE_PI_PROVIDER_ID = "zroute";
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const CATALOG_TIMEOUT = Duration.seconds(15);
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export interface PiModelEntry {
  readonly id: string;
  readonly name: string;
  readonly input: ReadonlyArray<"text" | "image">;
  readonly reasoning?: true;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
}

class ZrouteCatalogError extends Data.TaggedError("ZrouteCatalogError")<{
  readonly kind: "unauthorized" | "unreachable";
  /** Safe to show to the user; never contains the API key. */
  readonly message: string;
}> {}

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(UnknownFromJsonString);
const decodeJson = Schema.decodeUnknownOption(UnknownFromJsonString);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && Math.trunc(value) > 0
    ? Math.trunc(value)
    : undefined;

const nonNegative = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

function thinkingLevelMap(
  efforts: ReadonlyArray<string>,
): Record<string, string | null> | undefined {
  const supported = new Set<string>();
  for (const effort of efforts) {
    if (effort === "none") supported.add("off");
    else if ((PI_LEVELS as ReadonlyArray<string>).includes(effort)) supported.add(effort);
  }
  if (supported.size === 0) return undefined;
  return Object.fromEntries(
    PI_LEVELS.map((level) => [
      level,
      supported.has(level) ? (level === "off" ? "none" : level) : null,
    ]),
  );
}

/** Maps the `/installer/models` payload to Pi model entries, mirroring zroute's own installer. */
export function mapCatalogToPiModels(payload: unknown): ReadonlyArray<PiModelEntry> {
  const entries = Array.isArray(payload) ? payload : asRecord(payload)?.models;
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const models: Array<PiModelEntry> = [];
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (!entry) continue;
    let id = [entry.id, entry.slug, entry.model].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (id === undefined) continue;
    if (id.startsWith(`${ZROUTE_PI_PROVIDER_ID}/`)) id = id.slice(ZROUTE_PI_PROVIDER_ID.length + 1);
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);

    const efforts = [
      ...(Array.isArray(entry.reasoning_efforts) ? entry.reasoning_efforts : []),
      entry.default_reasoning_effort,
    ]
      .filter((effort): effort is string => typeof effort === "string" && effort.length > 0)
      .map((effort) => effort.toLowerCase());
    const orderedEfforts = [...new Set(efforts)];
    const reasoning =
      entry.supports_reasoning === true || orderedEfforts.some((e) => REASONING_EFFORTS.has(e));

    const modalities = Array.isArray(entry.input_modalities)
      ? entry.input_modalities
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.toLowerCase())
      : [];
    const input: Array<"text" | "image"> = ["text"];
    if (modalities.includes("image")) input.push("image");

    const name =
      typeof entry.display_name === "string" && entry.display_name.trim() !== ""
        ? entry.display_name.trim()
        : id;
    const levelMap = reasoning ? thinkingLevelMap(orderedEfforts) : undefined;
    const contextWindow = positiveInt(entry.context_window);
    const maxTokens = positiveInt(entry.max_completion_tokens);
    const cost = asRecord(entry.cost);
    models.push({
      id,
      name,
      input,
      ...(reasoning ? { reasoning: true as const } : {}),
      ...(levelMap ? { thinkingLevelMap: levelMap } : {}),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(cost
        ? {
            cost: {
              input: nonNegative(cost.input),
              output: nonNegative(cost.output),
              cacheRead: nonNegative(cost.cache_read),
              cacheWrite: nonNegative(cost.cache_write),
            },
          }
        : {}),
    });
  }
  return models;
}

function normalizeApiBase(apiBase: string): string {
  return apiBase.trim().replace(/\/+$/, "");
}

/**
 * Pi only puts images into tool results when the model accepts image input. zroute currently
 * tokenizes such images as base64 text (about 170k tokens each), so the placeholder mode
 * advertises text-only input and Pi sends "(see attached image)" instead.
 */
export function applyToolImageMode(
  models: ReadonlyArray<PiModelEntry>,
  mode: "placeholder" | "send",
): ReadonlyArray<PiModelEntry> {
  if (mode === "send") return models;
  return models.map((model) => ({ ...model, input: ["text"] as const }));
}

/** Default model: the first gemini-* in the catalog, else the first model. */
export function preferredModelId(models: ReadonlyArray<PiModelEntry>): string | undefined {
  return (models.find((model) => model.id.startsWith("gemini-")) ?? models[0])?.id;
}

export function renderModelsJson(input: {
  readonly apiBase: string;
  readonly apiKey: string;
  readonly models: ReadonlyArray<PiModelEntry>;
}): string {
  return `${encodeJson({
    providers: {
      [ZROUTE_PI_PROVIDER_ID]: {
        baseUrl: `${normalizeApiBase(input.apiBase)}/openai`,
        api: "openai-responses",
        apiKey: input.apiKey,
        authHeader: true,
        models: input.models,
      },
    },
  })}\n`;
}

export const fetchZrouteCatalog = Effect.fn("zroute.fetchCatalog")(function* (
  apiBase: string,
  apiKey: string,
) {
  const client = yield* HttpClient.HttpClient;
  const base = normalizeApiBase(apiBase);
  if (!/^https?:\/\/[^\s/]+/i.test(base)) {
    return yield* new ZrouteCatalogError({
      kind: "unreachable",
      message: "Could not reach zroute (the API base URL is not a valid http(s) URL).",
    });
  }
  const request = HttpClientRequest.get(`${base}/installer/models`).pipe(
    HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey}`),
    HttpClientRequest.setHeader("Accept", "application/json"),
  );
  const response = yield* client.execute(request).pipe(
    Effect.timeout(CATALOG_TIMEOUT),
    Effect.mapError(
      (error) =>
        new ZrouteCatalogError({
          kind: "unreachable",
          // Only the error class is reported; transport messages can echo request details.
          message: `Could not reach zroute (${error._tag === "TimeoutError" ? "timed out" : "network error"}).`,
        }),
    ),
  );
  if (response.status === 401 || response.status === 403) {
    return yield* new ZrouteCatalogError({
      kind: "unauthorized",
      message: `zroute rejected the API key (HTTP ${response.status}).`,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* new ZrouteCatalogError({
      kind: "unreachable",
      message: `Could not reach zroute (HTTP ${response.status}).`,
    });
  }
  const payload = yield* response.json.pipe(
    Effect.mapError(
      () =>
        new ZrouteCatalogError({
          kind: "unreachable",
          message: "Could not reach zroute (unexpected response).",
        }),
    ),
  );
  return mapCatalogToPiModels(payload);
});

/** The isolated Pi agent directory for one zroute instance, under the T3 home. */
export const zrouteAgentDir = (path: Path.Path, baseDir: string, instanceId: string) =>
  path.join(baseDir, "providers", "zroute", instanceId, "agent");

const readTextIfExists = (fileSystem: FileSystem.FileSystem, file: string) =>
  fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));

/** Writes atomically with owner-only permissions, and only when the content changed. */
const writePrivateFile = Effect.fn("zroute.writePrivateFile")(function* (
  fileSystem: FileSystem.FileSystem,
  file: string,
  content: string,
) {
  if ((yield* readTextIfExists(fileSystem, file)) === content) return false;
  const temporary = `${file}.${process.pid}.tmp`;
  yield* fileSystem.writeFileString(temporary, content, { mode: 0o600 });
  yield* fileSystem.chmod(temporary, 0o600);
  yield* fileSystem.rename(temporary, file);
  return true;
}, Effect.orDie);

/**
 * Regenerates models.json (and Pi's default model) from the catalog. Returns whether anything changed.
 */
export const syncZrouteAgentDir = Effect.fn("zroute.syncAgentDir")(function* (input: {
  readonly agentDir: string;
  readonly apiBase: string;
  readonly apiKey: string;
  readonly models: ReadonlyArray<PiModelEntry>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem
    .makeDirectory(input.agentDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.orDie);
  const modelsChanged = yield* writePrivateFile(
    fileSystem,
    path.join(input.agentDir, "models.json"),
    renderModelsJson(input),
  );

  // Pi owns settings.json afterwards; only fill in the default when it is missing or stale.
  const settingsFile = path.join(input.agentDir, "settings.json");
  const preferred = preferredModelId(input.models);
  let settingsChanged = false;
  if (preferred !== undefined) {
    const existingText = yield* readTextIfExists(fileSystem, settingsFile);
    const existing =
      existingText === undefined
        ? {}
        : (asRecord(Option.getOrUndefined(decodeJson(existingText))) ?? {});
    const currentOk =
      existing.defaultProvider === ZROUTE_PI_PROVIDER_ID &&
      typeof existing.defaultModel === "string" &&
      input.models.some((model) => model.id === existing.defaultModel);
    if (!currentOk) {
      settingsChanged = yield* writePrivateFile(
        fileSystem,
        settingsFile,
        `${encodeJson({
          ...existing,
          defaultProvider: ZROUTE_PI_PROVIDER_ID,
          defaultModel: preferred,
        })}\n`,
      );
    }
  }
  return modelsChanged || settingsChanged;
});
