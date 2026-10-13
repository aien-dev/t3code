import type { ComposerContextId, MessageReactionContextRecord } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const EXCERPT_MAX_CHARS = 200;

interface ReactableItem {
  readonly type: string;
  readonly id: string;
  readonly text?: string;
  readonly reaction?:
    | {
        readonly kind: "up" | "down";
        readonly note?: string | undefined;
        readonly reactedAt: DateTime.Utc;
      }
    | undefined;
}

interface ConversationMessageTime {
  readonly role: string;
  readonly createdAt: DateTime.Utc;
  readonly senderThreadId?: string | undefined;
}

/** First line-collapsed 200 characters of a reply, enough for the agent to tell which one was rated. */
function replyExcerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX_CHARS).trimEnd();
}

/** Context ids allow only `[a-z0-9_-]`, so fold any other character in the item id. */
function reactionContextId(itemId: string): ComposerContextId {
  return `reaction_${itemId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`.slice(
    0,
    128,
  ) as ComposerContextId;
}

/**
 * Thumbs the user has given since their last message. Those ride on the next message so the
 * agent learns from them; a reaction older than the last user message was already delivered.
 */
export function collectUnsentMessageReactions(input: {
  readonly messages: ReadonlyArray<ConversationMessageTime>;
  readonly turnItems: ReadonlyArray<ReactableItem>;
}): ReadonlyArray<MessageReactionContextRecord> {
  let lastUserMessageAt = Number.NEGATIVE_INFINITY;
  for (const message of input.messages) {
    if (message.role !== "user" || message.senderThreadId !== undefined) continue;
    lastUserMessageAt = Math.max(lastUserMessageAt, DateTime.toEpochMillis(message.createdAt));
  }
  return input.turnItems.flatMap((item): MessageReactionContextRecord[] => {
    const reaction = item.reaction;
    if (item.type !== "assistant_message" || reaction === undefined) return [];
    if (DateTime.toEpochMillis(reaction.reactedAt) <= lastUserMessageAt) return [];
    const excerpt = replyExcerpt(item.text ?? "");
    return [
      {
        version: 1,
        kind: "message-reaction",
        contextId: reactionContextId(item.id),
        label: reaction.kind === "up" ? "Thumbs up" : "Thumbs down",
        itemId: item.id as MessageReactionContextRecord["itemId"],
        reaction: reaction.kind,
        ...(reaction.note !== undefined ? { note: reaction.note } : {}),
        excerpt,
      },
    ];
  });
}
