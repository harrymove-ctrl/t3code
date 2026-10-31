import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { EMPTY_THREAD_HISTORY_META, type ThreadHistoryMeta } from "./threadHistoryMerge.ts";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationV2ThreadProjection>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  /**
   * Errors here are thread/history-local and must not be promoted into the environment
   * disconnect path.
   */
  readonly history: ThreadHistoryMeta;
  /** The last server sequence `data` reflects, so readers can tell a write has landed without searching paged-out history. */
  readonly sequence: number;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  history: EMPTY_THREAD_HISTORY_META,
  sequence: 0,
};

/**
 * A thread holds a write once it has applied the write's commit sequence. A bounded
 * projection can page the message out later, so finding it is only a fallback for
 * servers that do not report the sequence.
 */
export function threadHasCaughtUpTo(
  write: { readonly messageId: string; readonly sequence?: number | undefined },
  thread: {
    readonly sequence: number;
    readonly messages: ReadonlyArray<{ readonly id: string }> | undefined;
  },
): boolean {
  if (write.sequence !== undefined && thread.sequence >= write.sequence) return true;
  return thread.messages?.some((entry) => entry.id === write.messageId) ?? false;
}

/**
 * Backoff between bounded snapshot fetches while a thread that was just launched locally is
 * still missing on the server. The first fetch is immediate, so this is at most 5 tries.
 */
export const MISSING_THREAD_RETRY_DELAYS_MILLIS: ReadonlyArray<number> = [250, 500, 1_000, 2_000];

/**
 * What a 404 from the bounded snapshot fetch means. It only proves the thread was deleted when
 * this client has already seen it exist. Otherwise the launch command may still be in flight,
 * so retry with backoff, then fall back to the socket instead of caching a false deletion.
 */
export function resolveMissingThreadSnapshot(input: {
  readonly everLoaded: boolean;
  readonly attempt: number;
}): "deleted" | "retry" | "socket" {
  if (input.everLoaded) return "deleted";
  return input.attempt <= MISSING_THREAD_RETRY_DELAYS_MILLIS.length ? "retry" : "socket";
}
