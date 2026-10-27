import {
  apiRequest,
} from "./api";
import type {
  ChatAskResponse,
  ChatMessageView,
  ChatMessagesResponse,
  ChatQuickAction,
  ChatTranscriptResponse,
} from "./types";

// Ask Sua is online-only by design; history stays readable from the local
// SQLite cache when the connection drops (see notes.ts).
export const chatApi = {
  ask: (
    token: string,
    input: { courseId: string; question: string; quickAction?: ChatQuickAction },
  ) =>
    apiRequest<ChatAskResponse>("/chat/ask", {
      method: "POST",
      token,
      body: JSON.stringify(input),
    }),
  messages: (token: string, courseId: string) =>
    apiRequest<ChatMessagesResponse>(`/chat/messages?courseId=${courseId}`, {
      token,
    }),
  speech: (token: string, input: { audio: string; mimeType: string }) =>
    apiRequest<ChatTranscriptResponse>("/chat/speech", {
      method: "POST",
      token,
      body: JSON.stringify(input),
      // Transcribing a 30-second clip can outrun the default 30s ceiling;
      // aborting early would otherwise read as "check your connection".
      timeoutMs: 60_000,
    }),
};

export type { ChatMessageView };
