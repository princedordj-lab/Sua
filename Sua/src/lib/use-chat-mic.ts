import { useCallback, useRef, useState } from "react";
import {
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import type { RecordingOptions } from "expo-audio";
import { chatApi } from "./chat";
import { ensureMicPermission, promptForSettings } from "./permissions";
import * as FileSystem from "expo-file-system";

/**
 * HIGH_QUALITY is the important part: LOW_QUALITY records 3GP/AMR on Android,
 * which Gemini rejects even though it is uploaded as audio/mp4. This preset is
 * m4a/AAC on both platforms. 96 kbps mono at 22.05 kHz keeps a 30-second
 * question near 350 KB, well under the chat/speech 8 MB body limit.
 */
const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  directory: "cache",
  bitRate: 96_000,
  numberOfChannels: 1,
  sampleRate: 22_050,
};

const MAX_CLIP_MS = 30_000;

const MIC_DENIED_MESSAGE =
  "Microphone access is off. Enable it in Settings to ask by voice.";

const MIME_BY_EXTENSION: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  "3gp": "audio/3gpp",
  amr: "audio/amr",
};

/** Older queued clips may still be 3GP/AMR; label the bytes we actually have. */
function mimeForUri(uri: string): string {
  const extension = uri.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "audio/mp4";
}

export type MicState = "idle" | "recording" | "transcribing" | "error";

export function useChatMic(options: {
  getToken: () => Promise<string | null>;
  onTranscribed: (text: string) => void;
}) {
  const { getToken, onTranscribed } = options;
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const [micState, setMicState] = useState<MicState>("idle");
  const [micError, setMicError] = useState<string | null>(null);
  const stateRef = useRef<MicState>("idle");
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyState = useCallback((next: MicState) => {
    stateRef.current = next;
    setMicState(next);
  }, []);

  const fail = useCallback(
    (message: string) => {
      setMicError(message);
      applyState("error");
    },
    [applyState],
  );

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
      const mimeType = mimeForUri(uri);
      const response = await fetch(uri);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0) throw new Error("Recording is empty");
      const audio = new Blob([bytes], { type: mimeType });
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      const result = await chatApi.speech(token, audio, mimeType);
      const text = result.text.trim();
      if (!text) throw new Error("Nothing was heard. Try again.");
      applyState("idle");
      onTranscribed(text);
    } catch (error) {
      console.warn("voice question failed:", error instanceof Error ? error.message : error);
      fail(
        error instanceof Error && error.message === "Nothing was heard. Try again."
          ? error.message
          : "Couldn’t transcribe that — try again.",
      );
    } finally {
      // Leave the session in playback mode; otherwise answers play through the
      // earpiece on iOS.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(
        () => {},
      );
      if (uri) {
        FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
    }
  }, [applyState, fail, onTranscribed, recorder, getToken]);

  const start = useCallback(async () => {
    if (stateRef.current !== "idle" && stateRef.current !== "error") return;
    setMicError(null);
    try {
      const permission = await ensureMicPermission();
      if (!permission.granted) {
        promptForSettings(
          "Microphone access needed",
          permission.canAskAgain
            ? "Allow the microphone to record a question for Sua."
            : MIC_DENIED_MESSAGE,
          permission.canAskAgain,
        );
        fail(MIC_DENIED_MESSAGE);
        return;
      }
      applyState("recording");
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      // The native recorder is null until it is prepared — calling record()
      // without this silently records nothing.
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedAtRef.current = Date.now();
      // Auto-stop well before the server's 6 MB ceiling.
      timerRef.current = setTimeout(() => {
        void stop();
      }, MAX_CLIP_MS);
    } catch (error) {
      console.warn("voice record failed:", error instanceof Error ? error.message : error);
      fail("Couldn’t start recording — try again.");
    }
  }, [applyState, fail, recorder, stop]);

  const reset = useCallback(() => {
    setMicError(null);
    applyState("idle");
  }, [applyState]);

  return { micState, micError, start, stop, reset };
}
