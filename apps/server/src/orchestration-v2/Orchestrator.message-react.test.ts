import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for reactions"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "message-react" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const seedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-react"),
      threadId,
      projectId: ProjectId.make("project:react"),
      title: "Reactions",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const seedAssistantMessage = (input: { id: string; ordinal: number; streaming: boolean }) =>
      projections.apply({
        id: EventId.make(`seed:${input.id}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(input.id),
          threadId,
          runId: null,
          nodeId: NodeId.make(`node:${input.id}`),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: input.ordinal,
          status: input.streaming ? "running" : "completed",
          title: null,
          startedAt: now,
          completedAt: input.streaming ? null : now,
          updatedAt: now,
          type: "assistant_message",
          messageId: MessageId.make(`message:${input.id}`),
          text: "Here is a very long answer.",
          streaming: input.streaming,
        },
      });
    yield* seedAssistantMessage({ id: "reply", ordinal: 1, streaming: false });
    yield* seedAssistantMessage({ id: "draft", ordinal: 2, streaming: true });
    return { orchestrator, projections };
  });

it.effect("records a reaction on a finished reply and clears it again", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:react-set");
    const { orchestrator, projections } = yield* seedThread(threadId);
    const itemId = TurnItemId.make("reply");

    yield* orchestrator.dispatch({
      type: "message.react",
      commandId: CommandId.make("react-down"),
      threadId,
      itemId,
      reaction: { kind: "down", note: "Too long." },
    });
    const reacted = yield* projections.getTurnItem({ threadId, itemId });
    assert.equal(reacted?.type, "assistant_message");
    assert.ok(reacted?.type === "assistant_message" && reacted.reaction);
    assert.equal(reacted.reaction.kind, "down");
    assert.equal(reacted.reaction.note, "Too long.");
    assert.equal(reacted.text, "Here is a very long answer.");

    yield* orchestrator.dispatch({
      type: "message.react",
      commandId: CommandId.make("react-clear"),
      threadId,
      itemId,
      reaction: null,
    });
    const cleared = yield* projections.getTurnItem({ threadId, itemId });
    assert.ok(cleared?.type === "assistant_message");
    assert.equal(cleared.reaction, undefined);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a reply that does not exist or is still being written", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:react-refuse");
    const { orchestrator } = yield* seedThread(threadId);
    for (const itemId of ["missing", "draft"]) {
      const exit = yield* Effect.exit(
        orchestrator.dispatch({
          type: "message.react",
          commandId: CommandId.make(`react-${itemId}`),
          threadId,
          itemId: TurnItemId.make(itemId),
          reaction: { kind: "up" },
        }),
      );
      assert.equal(exit._tag, "Failure", itemId);
    }
  }).pipe(Effect.provide(layerTest)),
);
