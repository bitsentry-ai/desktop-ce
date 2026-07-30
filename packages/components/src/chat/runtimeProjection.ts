import type {
  AgentIteration,
  AgentErrorCode,
  AgentSessionState,
  AgentThreadSnapshot,
  AgentThreadTokenUsage,
  ChatMessage,
  ComposerImageAttachment,
} from "./types";

export type RuntimeProjectionEvent =
  | {
      type: "assistant_delta";
      timestamp: string;
      delta: string;
      kind?: "text" | "command_output";
    }
  | {
      type: "token_usage";
      timestamp: string;
      tokenUsage: AgentThreadTokenUsage;
    }
  | { type: "thinking_start"; timestamp: string }
  | { type: "thinking_delta"; timestamp: string; delta: string }
  | { type: "thinking_end"; timestamp: string }
  | {
      type: "tool_start";
      timestamp: string;
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_update";
      timestamp: string;
      toolCallId: string;
      chunk: string;
      truncationWarning?: boolean;
    }
  | {
      type: "tool_end";
      timestamp: string;
      toolCallId: string;
      state: string;
      output?: string;
      modelContext?: string;
      artifactId?: string;
      error?: string;
    }
  | {
      type: "final";
      timestamp: string;
      response: string;
      tokenUsage?: AgentThreadTokenUsage;
    }
  | { type: "cancelled"; timestamp: string; message: string }
  | {
      type: "error";
      timestamp: string;
      message: string;
      code?: AgentErrorCode;
      level?: "error" | "warning";
    };

function createAgentMessage(): Extract<ChatMessage, { kind: "agent" }> {
  return {
    kind: "agent",
    iterations: [],
    activeIterationId: null,
    toolCalls: [],
    finalText: null,
    status: "thinking",
  };
}

function createIteration(timestamp: string): AgentIteration {
  return {
    id: crypto.randomUUID(),
    startedAt: timestamp,
    text: "",
    streamDeltas: [],
    toolCallIds: [],
    status: "thinking",
  };
}

function appendAgentMessage(
  messages: ChatMessage[],
): Array<ChatMessage> {
  return [...messages, createAgentMessage()];
}

function mapLastAgentMessage(
  messages: ChatMessage[],
  updater: (message: Extract<ChatMessage, { kind: "agent" }>) => ChatMessage,
): Array<ChatMessage> {
  const idx = [...messages].reverse().findIndex((message) => message.kind === "agent");
  if (idx === -1) {
    const seeded = appendAgentMessage(messages);
    return mapLastAgentMessage(seeded, updater);
  }

  const realIdx = messages.length - 1 - idx;
  const next = [...messages];
  next[realIdx] = updater(next[realIdx] as Extract<ChatMessage, { kind: "agent" }>);
  return next;
}

function ensureActiveIteration(
  message: Extract<ChatMessage, { kind: "agent" }>,
  timestamp: string,
): Extract<ChatMessage, { kind: "agent" }> {
  if (message.activeIterationId !== null && message.activeIterationId.length > 0) {
    return message;
  }

  const iteration = createIteration(timestamp);
  return {
    ...message,
    activeIterationId: iteration.id,
    iterations: [...message.iterations, iteration],
  };
}

function pushUniqueToolCallId(
  toolCallIds: string[],
  toolCallId: string,
): string[] {
  if (toolCallIds.includes(toolCallId)) {
    return toolCallIds;
  }

  return [...toolCallIds, toolCallId];
}

function markThreadState(
  snapshot: AgentThreadSnapshot,
  threadState: AgentSessionState,
): AgentThreadSnapshot {
  return {
    ...snapshot,
    threadState,
  };
}

export function createAgentThreadSnapshot(input: {
  sessionId: string;
  startedAt: string;
  runtimeState: AgentSessionState;
  threadState?: AgentSessionState;
  prompt: string;
  attachments?: ComposerImageAttachment[];
}): AgentThreadSnapshot {
  return {
    sessionId: input.sessionId,
    startedAt: input.startedAt,
    runtimeState: input.runtimeState,
    threadState: input.threadState ?? "RUNNING",
    currentToolCallId: null,
    messages: [
      {
        kind: "user",
        text: input.prompt,
        attachments: input.attachments,
      },
      createAgentMessage(),
    ],
  };
}

export function appendPromptToThreadSnapshot(
  snapshot: AgentThreadSnapshot,
  input: {
    prompt: string;
    attachments?: ComposerImageAttachment[];
    runtimeState?: AgentSessionState;
  },
): AgentThreadSnapshot {
  return {
    ...snapshot,
    runtimeState: input.runtimeState ?? snapshot.runtimeState,
    threadState: "RUNNING",
    currentToolCallId: null,
    messages: [
      ...snapshot.messages,
      {
        kind: "user",
        text: input.prompt,
        attachments: input.attachments,
      },
      createAgentMessage(),
    ],
  };
}

export function setAgentThreadRuntimeState(
  snapshot: AgentThreadSnapshot,
  runtimeState: AgentSessionState,
): AgentThreadSnapshot {
  return {
    ...snapshot,
    runtimeState,
  };
}

export function reduceAgentThreadSnapshot(
  snapshot: AgentThreadSnapshot,
  event: RuntimeProjectionEvent,
): AgentThreadSnapshot {
  switch (event.type) {
    case "assistant_delta":
      return {
        ...snapshot,
        threadState: "RUNNING",
        messages: mapLastAgentMessage(snapshot.messages, (message) => {
          const withIteration = ensureActiveIteration(message, event.timestamp);
          return {
            ...withIteration,
            status: "streaming",
            iterations: withIteration.iterations.map((iteration) => {
              if (iteration.id !== withIteration.activeIterationId) {
                return iteration;
              }

              return {
                ...iteration,
                text: iteration.text + event.delta,
                status: "streaming",
                streamDeltas: [
                  ...(iteration.streamDeltas ?? []),
                  {
                    timestamp: event.timestamp,
                    text: event.delta,
                    kind: event.kind ?? "text",
                  },
                ],
              };
            }),
          };
        }),
      };

    case "token_usage":
      return {
        ...snapshot,
        tokenUsage: event.tokenUsage,
      };

    case "thinking_start":
      return {
        ...snapshot,
        threadState: "RUNNING",
        messages: mapLastAgentMessage(snapshot.messages, (message) => {
          const iteration = createIteration(event.timestamp);
          return {
            ...message,
            status: "thinking",
            activeIterationId: iteration.id,
            iterations: [...message.iterations, iteration],
          };
        }),
      };

    case "thinking_delta":
      return snapshot;

    case "thinking_end":
      return {
        ...snapshot,
        messages: mapLastAgentMessage(snapshot.messages, (message) => ({
          ...message,
          status: "streaming",
          iterations: message.iterations.map((iteration) => {
            if (iteration.id !== message.activeIterationId) {
              return iteration;
            }

            return {
              ...iteration,
              status: "streaming",
              completedAt: iteration.completedAt ?? event.timestamp,
            };
          }),
        })),
      };

    case "tool_start":
      return {
        ...snapshot,
        currentToolCallId: event.toolCallId,
        messages: mapLastAgentMessage(snapshot.messages, (message) => {
          const withIteration = ensureActiveIteration(message, event.timestamp);
          const existingToolCall = withIteration.toolCalls.find(
            (toolCall) => toolCall.toolCallId === event.toolCallId,
          );
          let toolCalls = [
            ...withIteration.toolCalls,
            {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              state: "running" as const,
              input: event.input,
            },
          ];
          if (existingToolCall !== undefined) {
            toolCalls = withIteration.toolCalls.map((toolCall) => {
              if (toolCall.toolCallId !== event.toolCallId) {
                return toolCall;
              }

              return {
                ...toolCall,
                toolName: event.toolName,
                state: "running",
                input: event.input,
              };
            });
          }

          return {
            ...withIteration,
            toolCalls,
            iterations: withIteration.iterations.map((iteration) => {
              if (iteration.id !== withIteration.activeIterationId) {
                return iteration;
              }

              return {
                ...iteration,
                toolCallIds: pushUniqueToolCallId(
                  iteration.toolCallIds,
                  event.toolCallId,
                ),
              };
            }),
          };
        }),
      };

    case "tool_update":
      return snapshot;

    case "tool_end": {
      let currentToolCallId = snapshot.currentToolCallId;
      if (snapshot.currentToolCallId === event.toolCallId) {
        currentToolCallId = null;
      }

      return {
        ...snapshot,
        currentToolCallId,
        messages: mapLastAgentMessage(snapshot.messages, (message) => ({
          ...message,
          toolCalls: message.toolCalls.map((toolCall) => {
            if (toolCall.toolCallId !== event.toolCallId) {
              return toolCall;
            }

            let state: "done" | "failed" = "done";
            if (event.state === "FAILED") {
              state = "failed";
            }

            return {
              ...toolCall,
              state,
              output: event.output,
              modelContext: event.modelContext,
              error: event.error,
            };
          }),
        })),
      };
    }

    case "final":
      return {
        ...markThreadState(snapshot, "COMPLETED"),
        tokenUsage: event.tokenUsage ?? snapshot.tokenUsage,
        currentToolCallId: null,
        messages: mapLastAgentMessage(snapshot.messages, (message) => {
          const lastIteration = message.iterations[message.iterations.length - 1];
          const finalResponse = event.response.trim();
          let streamedResponse = "";
          if (lastIteration !== undefined) {
            streamedResponse = lastIteration.text.trim();
          }
          const streamDeltas = lastIteration?.streamDeltas ?? [];
          const shouldAppendFinalResponse =
            finalResponse.length > 0 &&
            streamDeltas.some(
              (delta) => delta.kind === "command_output",
            );
          const shouldPreserveStreamedResponse =
            streamedResponse.length > 0 &&
            !shouldAppendFinalResponse &&
            (finalResponse.length === 0 || finalResponse === streamedResponse);
          let visibleFinalText = finalResponse;
          if (shouldAppendFinalResponse && lastIteration !== undefined) {
            visibleFinalText = [lastIteration.text.trim(), finalResponse]
              .filter((value) => value.length > 0)
              .join("\n\n");
          }

          let finalIterationText: string | undefined;
          if (visibleFinalText.length > 0) {
            finalIterationText = visibleFinalText;
          }
          if (shouldPreserveStreamedResponse && lastIteration !== undefined) {
            finalIterationText = lastIteration.text;
          }

          let finalText = message.finalText;
          if (visibleFinalText.length > 0) {
            finalText = visibleFinalText;
          }

          return {
            ...message,
            finalText,
            status: "done",
            activeIterationId: null,
            iterations: message.iterations.map((iteration, index, all) => {
              if (index !== all.length - 1) {
                return iteration;
              }

              return {
                ...iteration,
                text: finalIterationText ?? iteration.text,
                status: "done",
                completedAt: iteration.completedAt ?? event.timestamp,
              };
            }),
          };
        }),
      };

    case "cancelled":
      return {
        ...markThreadState(snapshot, "CANCELLED"),
        currentToolCallId: null,
        messages: mapLastAgentMessage(snapshot.messages, (message) => ({
          ...message,
          status: "cancelled",
          activeIterationId: null,
          errorMsg: event.message,
          iterations: message.iterations.map((iteration) => {
            if (iteration.id !== message.activeIterationId) {
              return iteration;
            }

            return {
              ...iteration,
              status: "error",
              completedAt: iteration.completedAt ?? event.timestamp,
            };
          }),
          toolCalls: message.toolCalls.map((toolCall) => {
            if (toolCall.state !== "running") {
              return toolCall;
            }

            return { ...toolCall, state: "failed", error: toolCall.error ?? event.message };
          }),
        })),
      };

    case "error":
      return {
        ...markThreadState(snapshot, "FAILED"),
        currentToolCallId: null,
        messages: mapLastAgentMessage(snapshot.messages, (message) => ({
          ...message,
          status: "error",
          errorMsg: event.message,
          errorCode: event.code,
          activeIterationId: null,
          iterations: message.iterations.map((iteration) => {
            if (iteration.id !== message.activeIterationId) {
              return iteration;
            }

            return {
              ...iteration,
              status: "error",
              completedAt: iteration.completedAt ?? event.timestamp,
            };
          }),
          toolCalls: message.toolCalls.map((toolCall) => {
            if (toolCall.state !== "running") {
              return toolCall;
            }

            return { ...toolCall, state: "failed", error: toolCall.error ?? event.message };
          }),
        })),
      };
  }
}
