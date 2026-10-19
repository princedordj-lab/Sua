import { useCallback, useRef, useState } from "react";
import {
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import type { RecordingOptions } from "expo-audio";
import { chatApi } from "./chat";
import * as FileSystem from "expo-file-system";

// ~30 KB/s so a quick 30-second question lands well under the 6 MB cap.
const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.LOW_QUALITY,
  directory: "cache",
  bitRate: 96_000,
  numberOfChannels: 1,
  sampleRate: 22_050,
};

const MAX_CLIP_MS = 30_000;

export type MicState = "idle" | "recording" | "transcribing" | "error";

export function useChatMic(options: {
  getToken: () => Promise<string | null>;
  onTranscribed: (text: string) => void;
}) {
  const { getToken, onTranscribed } = options;
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const [micState, setMicState] = useState<MicState>("idle");
  const stateRef = useRef<MicState>("idle");
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyState = useCallback((next: MicState) => {
    stateRef.current = next;
    setMicState(next);
  }, []);

  const stop = useCallback(async () => {
    if (stateRef.current !== "recording") return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // m4a writes its moov atom on stop, so always settle the recorder before
    // reading the file back.
    await recorder.stop();
    applyState("transcribing");
    const uri = recorder.uri;
    try {
      if (!uri) throw new Error("Recording URI is missing");
      const response = await fetch(uri);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0) throw new Error("Recording is empty");
      const audio = new Blob([bytes], { type: "audio/mp4" });
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      const result = await chatApi.speech(token, audio, "audio/mp4");
      const text = result.text.trim();
      if (!text) throw new Error("Nothing was heard. Try again.");
      applyState("idle");
      onTranscribed(text);
    } catch (error) {
      console.warn("voice question failed:", error instanceof Error ? error.message : error);
      applyState("error");
    } finally {
      if (uri) {
        FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
    }
  }, [applyState, onTranscribed, recorder, getToken]);

  const start = useCallback(async () => {
    if (stateRef.current !== "idle" && stateRef.current !== "error") return;
    try {
      applyState("recording");
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      await recorder.record();
      startedAtRef.current = Date.now();
      // Auto-stop well before the server's 6 MB ceiling.
      timerRef.current = setTimeout(() => {
        void stop();
      }, MAX_CLIP_MS);
    } catch (error) {
      console.warn("voice record failed:", error instanceof Error ? error.message : error);
      applyState("error");
    }
  }, [applyState, recorder, stop]);

  const reset = useCallback(() => applyState("idle"), [applyState]);

  return { micState, start, stop, reset };
}
