import { createMusicPlayerRuntime, type CyberOsRuntime, type MusicPlayerRuntime } from "@cyberos/shared";

export function resolveMusicPlayerRuntime(input: {
  config: CyberOsRuntime;
  musicPlayer?: MusicPlayerRuntime;
}): MusicPlayerRuntime {
  return input.musicPlayer ?? createMusicPlayerRuntime({ ...input.config.vodPlayer, enabled: true });
}
