import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { ZrouteSettings } from "../settings.ts";
import { syncZrouteAgentDir } from "./catalog.ts";
import { ZrouteDriver } from "./driver.ts";

const API_KEY = "zr_live_super_secret";
const catalog = {
  models: [
    {
      id: "claude-sonnet-5-5",
      display_name: "Z Claude Sonnet 5.5",
      supports_reasoning: true,
      reasoning_efforts: ["low", "high"],
    },
    {
      id: "gemini-3.8-flash",
      display_name: "Z Gemini 3.8 Flash",
      cost: { input: 0.3, output: 2.5 },
    },
  ],
};

const layerTest = Layer.mergeAll(
  TestProviderHost.layer({
    cwd: "/machine",
    settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
    runBackgroundWork: false,
  }),
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encoder = new TextEncoder();

/** A fake `pi` that answers the version probe and RPC discovery from the on-disk models.json. */
const makePiSpawner = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const launches: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      launches.push(command);
      const version = command.args.includes("--version");
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const agentDir = command.options.env?.PI_CODING_AGENT_DIR;
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: version ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
        isRunning: Effect.succeed(!version),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          const request = decodeRequest(new TextDecoder().decode(chunk).trim());
          return Effect.gen(function* () {
            let models: Array<{ provider: string; id: string }> = [];
            if (request.type === "get_available_models" && agentDir !== undefined) {
              const text = yield* fileSystem
                .readFileString(`${agentDir}/models.json`)
                .pipe(Effect.orElseSucceed(() => undefined));
              if (text !== undefined) {
                const parsed = JSON.parse(text) as {
                  providers: { zroute: { models: Array<{ id: string }> } };
                };
                models = parsed.providers.zroute.models.map((m) => ({
                  provider: "zroute",
                  id: m.id,
                }));
              }
            }
            const data =
              request.type === "get_available_models"
                ? { models }
                : request.type === "get_commands"
                  ? { commands: [] }
                  : {};
            yield* Queue.offer(
              stdout,
              encoder.encode(
                `${JSON.stringify({ type: "response", id: request.id, success: true, data })}\n`,
              ),
            );
          });
        }),
        stdout: version ? Stream.succeed(encoder.encode("pi 1.0.2\n")) : Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, launches };
});

const fakeHttp = (
  respond: (request: { url: string; authorization: string | undefined }) => Response,
) =>
  HttpClient.make((request) =>
    Effect.sync(() =>
      HttpClientResponse.fromWeb(
        request,
        respond({ url: request.url, authorization: request.headers.authorization }),
      ),
    ),
  );

const failingHttp = HttpClient.make((request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request,
        cause: new Error(`connect ECONNREFUSED while sending ${API_KEY}`),
      }),
    }),
  ),
);

const create = (
  http: HttpClient.HttpClient,
  config: Partial<ZrouteSettings> = {},
  environment: ReadonlyArray<{ name: string; value: string; sensitive: boolean }> = [],
) =>
  Effect.gen(function* () {
    const { spawner, launches } = yield* makePiSpawner();
    const instance = yield* ZrouteDriver.create({
      instanceId: ProviderInstanceId.make("zroute-test"),
      displayName: undefined,
      environment,
      enabled: true,
      config: { ...ZrouteDriver.defaultConfig(), binaryPath: "pi", apiKey: API_KEY, ...config },
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HttpClient.HttpClient, http),
    );
    const snapshot = yield* instance.snapshot.refresh;
    return { instance, snapshot, launches };
  });

it.layer(layerTest)("ZrouteDriver", (it) => {
  it.effect("asks for an API key without calling zroute", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* create(
        fakeHttp(() => {
          throw new Error("must not be called");
        }),
        { apiKey: "" },
      );
      assert.equal(snapshot.driver, "zroute");
      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.equal(snapshot.message, "Add your zroute API key to list models.");
      assert.isTrue(snapshot.installed);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a rejected key without echoing it", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* create(
        fakeHttp(() => Response.json({ error: "invalid" }, { status: 401 })),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.equal(snapshot.message, "zroute rejected the API key (HTTP 401).");
      assert.notInclude(JSON.stringify(snapshot), API_KEY);
    }).pipe(Effect.scoped),
  );

  it.effect("reports an unreachable gateway without echoing the transport error", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* create(failingHttp);
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.message, "Could not reach zroute (network error).");
      assert.notInclude(JSON.stringify(snapshot), API_KEY);
    }).pipe(Effect.scoped),
  );

  it.effect("lists zroute models and runs Pi against an isolated agent directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const requests: Array<{ url: string; authorization: string | undefined }> = [];
      const { snapshot, launches } = yield* create(
        fakeHttp((request) => {
          requests.push(request);
          return Response.json(catalog);
        }),
        { apiBase: "https://gateway.test/" },
      );
      assert.isAbove(requests.length, 0);
      for (const request of requests) {
        assert.deepEqual(request, {
          url: "https://gateway.test/installer/models",
          authorization: `Bearer ${API_KEY}`,
        });
      }
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.displayName, "zroute");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default", "zroute/claude-sonnet-5-5", "zroute/gemini-3.8-flash"],
      );

      const agentDir = path.join(host.paths.baseDir, "providers", "zroute", "zroute-test", "agent");
      const modelsFile = path.join(agentDir, "models.json");
      const written = JSON.parse(yield* fileSystem.readFileString(modelsFile));
      assert.equal(written.providers.zroute.baseUrl, "https://gateway.test/openai");
      assert.equal(written.providers.zroute.apiKey, API_KEY);
      assert.equal(((yield* fileSystem.stat(modelsFile)).mode & 0o777).toString(8), "600");
      const settings = JSON.parse(
        yield* fileSystem.readFileString(path.join(agentDir, "settings.json")),
      );
      assert.deepEqual(settings, { defaultProvider: "zroute", defaultModel: "gemini-3.8-flash" });

      const piLaunch = launches.find((launch) => !launch.args.includes("--version"));
      assert.isDefined(piLaunch);
      assert.equal(piLaunch!.options.env?.PI_CODING_AGENT_DIR, agentDir);

      // Unchanged content is not rewritten.
      const models = JSON.parse(yield* fileSystem.readFileString(modelsFile)).providers.zroute
        .models;
      assert.isFalse(
        yield* syncZrouteAgentDir({
          agentDir,
          apiBase: "https://gateway.test/",
          apiKey: API_KEY,
          models,
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("lets an explicit instance environment variable override the generated directory", () =>
    Effect.gen(function* () {
      const { launches } = yield* create(
        fakeHttp(() => Response.json(catalog)),
        {},
        [{ name: "PI_CODING_AGENT_DIR", value: "/user-chosen", sensitive: false }],
      );
      const piLaunch = launches.find((launch) => !launch.args.includes("--version"));
      assert.equal(piLaunch?.options.env?.PI_CODING_AGENT_DIR, "/user-chosen");
    }).pipe(Effect.scoped),
  );
});
