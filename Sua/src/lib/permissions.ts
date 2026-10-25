import { Alert, Linking } from "react-native";
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from "expo-audio";
import {
  getCameraPermissionsAsync,
  requestCameraPermissionsAsync,
} from "expo-image-picker";

/**
 * One place for the OS permission prompts the capture flow needs.
 *
 * Document picking (SAF on Android, UIDocumentPicker on iOS) and the modern
 * photo picker need no permission at all, so there is intentionally no
 * helper for files — asking for storage access there would be a scary prompt
 * with no benefit.
 */

export type PermissionAsk = {
  granted: boolean;
  canAskAgain: boolean;
};

async function ask(
  get: () => Promise<{ granted: boolean; canAskAgain: boolean }>,
  request: () => Promise<{ granted: boolean; canAskAgain: boolean }>,
): Promise<PermissionAsk> {
  const current = await get().catch(() => null);
  if (current?.granted) return { granted: true, canAskAgain: true };
  // Only prompt when the OS still allows it; otherwise the request resolves
  // instantly as denied and the user sees nothing happen.
  if (current && !current.canAskAgain) {
    return { granted: false, canAskAgain: false };
  }
  const result = await request().catch(() => null);
  return {
    granted: Boolean(result?.granted),
    canAskAgain: result?.canAskAgain ?? false,
  };
}

/** Microphone, for both the lecture recorder and the Ask Sua voice question. */
export function ensureMicPermission() {
  return ask(getRecordingPermissionsAsync, requestRecordingPermissionsAsync);
}

/** Camera only — the photo library picker does not need a prompt. */
export function ensureCameraPermission() {
  return ask(getCameraPermissionsAsync, requestCameraPermissionsAsync);
}

export function openAppSettings() {
  void Linking.openSettings().catch(() => {});
}

/**
 * A denial the OS will never re-prompt is a dead end without Settings. While
 * the OS can still prompt (canAskAgain), a plain alert is enough — the student
 * just saw the system dialog.
 */
export function promptForSettings(
  title: string,
  message: string,
  canAskAgain = false,
) {
  if (canAskAgain) {
    Alert.alert(title, message);
    return;
  }
  Alert.alert(title, message, [
    { text: "Not now", style: "cancel" },
    { text: "Open settings", onPress: openAppSettings },
  ]);
}
