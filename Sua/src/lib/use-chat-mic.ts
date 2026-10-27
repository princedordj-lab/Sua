import { useCallback, useEffect, useRef, useState } from "react";
import {
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import type { RecordingOptions } from "expo-audio";
import { File } from "expo-file-system";
import { chatApi } from "./chat";
import { ensureMicPermission, promptForSettings } from "./permissions";

/**
 * HIGH_QUALITY is the important part: LOW_QUALITY records 3GP/AMR on Android,
 * which Gemini rejects even though it is uploaded as audio/mp4. This preset is
 * m4a/AAC on both platforms. 96 kbps mono at 22.05 kHz keeps a 30-second
 * question near 350 KB.
 */
const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  directory: "cache",
  bitRate: 96_000,
  numberOfChannels: 1,
  sampleRate: 22_050,
};

const MAX_CLIP_MS = 30_000;

/** Mirrors the server ceiling for /chat/speech so an over-long clip fails here. */
const MAX_CLIP_BYTES = 6 * 1024 * 1024;

const MIC_DENIED_MESSAGE =
  "Microphone access is off. Enable it in Settings to ask by voice.";

const MIC_EMPTY_MESSAGE = "Nothing was heard. Try again.";

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

/**
 * Only our own wording reaches the screen. Server and network failures keep
 * their raw text in the console (never the clip or the token).
 */
function friendlyMicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === MIC_EMPTY_MESSAGE) return MIC_EMPTY_MESSAGE;
  if (/too long|too large|over the .*limit|exceeded/i.test(message)) {
    return "That recording is too long. Try a shorter question.";
  }
  if (/not configured|not available|not supported/i.test(message)) {
    return "Voice questions aren’t available right now. Type your question instead.";
  }
  if (/connect|internet|network|offline/i.test(message)) {
    return "You’re offline — voice questions need a connection.";
  }
  if (/sign in/i.test(message)) {
    return "Please sign in again to ask by voice.";
  }
  return "Couldn’t transcribe that — try again.";
}

/** Temp clip cleanup; the file is disposable whether or not it still exists. */
function discardFile(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The cache directory is reclaimed by the OS; nothing user-visible depends
    // on this succeeding.
  }
}

/**
 * Leave the session in playback mode; otherwise answers play through the
 * earpiece on iOS.
 */
async function restorePlaybackMode() {
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
  }).catch(() => {});
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
  // Mirrors the native recorder so unmount cleanup never has to guess.
  const recordingRef = useRef(false);
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

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stop = useCallback(async () => {
    if (stateRef.current !== "recording") return;
    clearTimer();
    // m4a writes its moov atom on stop, so always settle the recorder before
    // reading the file back. A failed stop must not pin the UI in "recording".
    await recorder.stop().catch(() => {});
    recordingRef.current = false;
    applyState("transcribing");
    const uri = recorder.uri;
    try {
      if (!uri) throw new Error("Recording URI is missing");
      const file = new File(uri);
      if (!file.exists || file.size === 0) throw new Error("Recording is empty");
      if (file.size > MAX_CLIP_BYTES) throw new Error("Recording too large");
      // React Native cannot build a Blob from raw bytes ("Creating blobs from
      // 'ArrayBuffer' and 'ArrayBufferView' are not supported"), so the clip
      // travels as base64 inside the JSON body. Reading the file directly also
      // streams no bytes through a Response object.
      const audio = await file.base64();
      if (!audio) throw new Error("Recording is empty");
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      const result = await chatApi.speech(token, {
        audio,
        mimeType: mimeForUri(uri),
      });
      const text = result.text.trim();
      if (!text) throw new Error(MIC_EMPTY_MESSAGE);
      applyState("idle");
      onTranscribed(text);
    } catch (error) {
      // Message only: never log the clip, its bytes, or the bearer token.
      console.warn(
        "voice question failed:",
        error instanceof Error ? error.message : "unknown",
      );
      fail(friendlyMicError(error));
    } finally {
      await restorePlaybackMode();
      if (uri) discardFile(uri);
    }
  }, [applyState, clearTimer, fail, getToken, onTranscribed, recorder]);

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
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      // The native recorder is null until it is prepared — calling record()
      // without this silently records nothing.
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingRef.current = true;
      applyState("recording");
      // Auto-stop well before the server's 6 MB ceiling.
      timerRef.current = setTimeout(() => {
        void stop();
      }, MAX_CLIP_MS);
    } catch (error) {
      // Never leave the mic open: a half-prepared recorder still holds the
      // session, and the UI must not stay stuck in "recording".
      recordingRef.current = false;
      await recorder.stop().catch(() => {});
      await restorePlaybackMode();
      console.warn(
        "voice record failed:",
        error instanceof Error ? error.message : "unknown",
      );
      fail("Couldn’t start recording — try again.");
    }
  }, [applyState, fail, recorder, stop]);

  // Leaving the screen mid-recording would otherwise keep the microphone (and
  // Android's recording session) alive with no UI to stop it.
  useEffect(() => {
    return () => {
      clearTimer();
      if (!recordingRef.current) return;
      recordingRef.current = false;
      recorder.stop().catch(() => {});
      void restorePlaybackMode();
    };
  }, [clearTimer, recorder]);

  const reset = useCallback(() => {
    setMicError(null);
    applyState("idle");
  }, [applyState]);

  return { micState, micError, start, stop, reset };
}
