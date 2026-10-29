import { defaultTvSettings, getTvSettings } from "@cyberos/db";
import {
  createVodPlayerRuntime,
  VodPlayerRuntimeError,
  type CyberOsRuntime,
  type VodPlayerRuntime
} from "@cyberos/shared";
import type { CyberOsDatabase } from "@cyberos/db";

export { createVodPlayerRuntime, VodPlayerRuntimeError, type VodPlayerRuntime };

export function resolveVodPlayerRuntime(input: {
  config: CyberOsRuntime;
  db: CyberOsDatabase;
  vodPlayer?: VodPlayerRuntime;
}, options: { transitionEnabled?: boolean } = {}): VodPlayerRuntime {
  if (input.vodPlayer) return input.vodPlayer;
  const settings = getTvSettings(input.db) ?? defaultTvSettings();
  const transitionEnabled = options.transitionEnabled === true;
  return createVodPlayerRuntime({
    ...input.config.vodPlayer,
    enabled: settings.enabled || transitionEnabled,
    videoOutput: transitionEnabled && !settings.enabled ? "wayland" : settings.videoOutput,
    drmConnector: settings.drmConnector,
    audioDevice: settings.audioDevice,
    hwdec: settings.hardwareDecoding
  });
}
