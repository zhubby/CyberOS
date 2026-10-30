import type { StreamOptions, StreamTrack } from "@cyberos/shared";

export interface Probe {
  format?: { duration?: string; format_name?: string };
  streams?: Array<{
    index: number;
    codec_type: string;
    codec_name?: string;
    width?: number;
    height?: number;
    color_transfer?: string;
    pix_fmt?: string;
    profile?: string;
    tags?: { language?: string; title?: string };
  }>;
}
export function tracksFromProbe(probe: Probe): StreamTrack[] {
  return (probe.streams ?? [])
    .filter((s) => ["video", "audio", "subtitle"].includes(s.codec_type))
    .map((s) => ({
      index: s.index,
      type: s.codec_type as StreamTrack["type"],
      codec: s.codec_name ?? "unknown",
      language: s.tags?.language ?? null,
      title: s.tags?.title ?? null,
      width: s.width ?? null,
      height: s.height ?? null,
      hdr: ["smpte2084", "arib-std-b67"].includes(s.color_transfer ?? ""),
    }));
}
export function planStream(probe: Probe, options: StreamOptions) {
  const tracks = tracksFromProbe(probe);
  const video = tracks.find((t) => t.type === "video");
  if (!video) throw new Error("No video track");
  const audio =
    options.audioTrack === undefined
      ? tracks.find((t) => t.type === "audio")
      : tracks.find(
          (t) => t.type === "audio" && t.index === options.audioTrack,
        );
  const subtitle =
    options.subtitleTrack == null
      ? null
      : tracks.find(
          (t) => t.type === "subtitle" && t.index === options.subtitleTrack,
        );
  if (options.audioTrack !== undefined && !audio)
    throw new Error("Audio track unavailable");
  if (options.subtitleTrack != null && !subtitle)
    throw new Error("Subtitle track unavailable");
  const rawVideo = probe.streams?.find(
    (stream) => stream.index === video.index,
  );
  const incompatibleH264 =
    video.codec === "h264" &&
    (video.hdr ||
      (rawVideo?.pix_fmt !== undefined &&
        !["yuv420p", "yuvj420p"].includes(rawVideo.pix_fmt)) ||
      /10|4:2:2|4:4:4/.test(rawVideo?.profile ?? ""));
  const transcode =
    incompatibleH264 ||
    !["h264", ...(options.codecs ?? []).filter((c) => c === "hevc")].includes(
      video.codec,
    ) ||
    (options.quality ?? "original") !== "original" ||
    subtitle !== null;
  // Direct delivery is deliberately conservative: MP4/H.264/AAC without track remapping.
  const direct =
    !transcode &&
    video.codec === "h264" &&
    (probe.format?.format_name ?? "").split(",").includes("mp4") &&
    (!audio || audio.codec === "aac") &&
    options.audioTrack === undefined;
  return {
    tracks,
    video,
    audio: audio ?? null,
    subtitle,
    mode: direct
      ? ("direct" as const)
      : transcode
        ? ("transcode" as const)
        : ("remux" as const),
  };
}

export function encodingArgs(
  probe: Probe,
  options: StreamOptions,
  input: string,
  directory: string,
): string[] {
  const plan = planStream(probe, options);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-threads",
    "2",
    "-filter_complex_threads",
    "1",
    "-protocol_whitelist",
    "file,pipe,crypto,data",
    "-re",
    "-ss",
    String(options.startPositionSeconds ?? 0),
    "-i",
    input,
  ];
  const height =
    options.quality === "original" || !options.quality
      ? Math.min(plan.video.height ?? 1080, 1080)
      : Number(options.quality);
  const filters: string[] = [];
  if (plan.mode === "transcode") {
    if (plan.video.hdr)
      filters.push(
        "zscale=t=linear:npl=100",
        "format=gbrpf32le",
        "zscale=p=bt709",
        "tonemap=tonemap=hable:desat=0",
        "zscale=t=bt709:m=bt709:r=tv",
        "format=yuv420p",
      );
    filters.push(`scale=-2:min(${height}\\,ih)`);
  }
  if (plan.subtitle) {
    // FFmpeg reads the inherited descriptor, never an interpolated filesystem path.
    const ordinal = plan.tracks
      .filter((t) => t.type === "subtitle")
      .findIndex((t) => t.index === plan.subtitle?.index);
    if (
      ["subrip", "ass", "ssa", "webvtt", "mov_text"].includes(
        plan.subtitle.codec,
      )
    )
      filters.push(
        `setpts=PTS+${options.startPositionSeconds ?? 0}/TB`,
        `subtitles=filename=${input.replaceAll(":", "\\:")}:si=${ordinal}`,
        `setpts=PTS-${options.startPositionSeconds ?? 0}/TB`,
      );
    else {
      args.push(
        "-filter_complex",
        `[0:${plan.video.index}][0:${plan.subtitle.index}]overlay,${filters.join(",")}[v]`,
        "-map",
        "[v]",
      );
    }
  }
  if (
    !plan.subtitle ||
    ["subrip", "ass", "ssa", "webvtt", "mov_text"].includes(plan.subtitle.codec)
  ) {
    args.push("-map", `0:${plan.video.index}`);
    if (filters.length) args.push("-vf", filters.join(","));
  }
  if (plan.audio) args.push("-map", `0:${plan.audio.index}`);
  args.push("-sn", "-c:v", plan.mode === "remux" ? "copy" : "libx264");
  if (plan.mode === "transcode")
    args.push(
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "2",
      "-force_key_frames",
      "expr:gte(t,n_forced*4)",
    );
  args.push(
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-b:a",
    "192k",
    "-f",
    "hls",
    "-hls_time",
    "4",
    "-hls_list_size",
    "12",
    "-hls_flags",
    "delete_segments+independent_segments+temp_file",
    "-hls_segment_filename",
    `${directory}/segment-%06d.ts`,
    `${directory}/index.m3u8`,
  );
  return args;
}
