import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { collectUnsentMessageReactions } from "./messageReactions.logic";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function reply(
  id: string,
  text: string,
  reaction?: { kind: "up" | "down"; note?: string; reactedAt: string },
) {
  return {
    type: "assistant_message" as const,
    id,
    text,
    reaction: reaction && { ...reaction, reactedAt: at(reaction.reactedAt) },
  };
}

const userMessage = (createdAt: string) => ({ role: "user" as const, createdAt: at(createdAt) });

describe("collectUnsentMessageReactions", () => {
  it("includes a reaction made after the last user message", () => {
    const records = collectUnsentMessageReactions({
      messages: [userMessage("2026-01-01T00:00:00Z")],
      turnItems: [reply("item-1", "Done.", { kind: "up", reactedAt: "2026-01-01T00:05:00Z" })],
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      version: 1,
      kind: "message-reaction",
      itemId: "item-1",
      reaction: "up",
      excerpt: "Done.",
    });
  });

  it("excludes a reaction made before the last user message", () => {
    const records = collectUnsentMessageReactions({
      messages: [userMessage("2026-01-01T00:00:00Z"), userMessage("2026-01-01T00:10:00Z")],
      turnItems: [reply("item-1", "Done.", { kind: "up", reactedAt: "2026-01-01T00:05:00Z" })],
    });
    expect(records).toEqual([]);
  });

  it("includes every reaction when there is no user message yet", () => {
    const records = collectUnsentMessageReactions({
      messages: [],
      turnItems: [
        reply("item-1", "One", { kind: "up", reactedAt: "2026-01-01T00:05:00Z" }),
        reply("item-2", "Two", {
          kind: "down",
          note: "too long",
          reactedAt: "2026-01-01T00:06:00Z",
        }),
      ],
    });
    expect(records.map((record) => [record.itemId, record.reaction, record.note])).toEqual([
      ["item-1", "up", undefined],
      ["item-2", "down", "too long"],
    ]);
  });

  it("skips replies whose reaction was cleared", () => {
    const records = collectUnsentMessageReactions({
      messages: [],
      turnItems: [reply("item-1", "Done.")],
    });
    expect(records).toEqual([]);
  });

  it("ignores messages that are not the user's own", () => {
    const records = collectUnsentMessageReactions({
      messages: [
        userMessage("2026-01-01T00:00:00Z"),
        { role: "assistant", createdAt: at("2026-01-01T00:20:00Z") },
        { role: "user", createdAt: at("2026-01-01T00:30:00Z"), senderThreadId: "other" },
      ],
      turnItems: [reply("item-1", "Done.", { kind: "up", reactedAt: "2026-01-01T00:05:00Z" })],
    });
    expect(records).toHaveLength(1);
  });

  it("builds a single-line excerpt of at most 200 characters with a valid context id", () => {
    const [record] = collectUnsentMessageReactions({
      messages: [],
      turnItems: [
        reply("Item/ABC 1", `  first line\n\nsecond   line ${"x".repeat(400)}`, {
          kind: "up",
          reactedAt: "2026-01-01T00:05:00Z",
        }),
      ],
    });
    expect(record?.excerpt.startsWith("first line second line")).toBe(true);
    expect(record?.excerpt.length).toBeLessThanOrEqual(200);
    expect(record?.excerpt).not.toMatch(/\s{2}|\n/);
    expect(record?.contextId).toMatch(/^[a-z0-9_-]+$/i);
  });
});
