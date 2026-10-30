import { describe, expect, it } from "vitest";
import { encodingArgs, planStream, type Probe } from "./planner.js";
const probe: Probe = {
  format: { format_name: "mov,mp4", duration: "60" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", height: 720 },
    { index: 1, codec_type: "audio", codec_name: "aac" },
    { index: 2, codec_type: "subtitle", codec_name: "subrip" },
  ],
};
describe("browser stream planning", () => {
  it("encodes unsupported H264 pixel formats and permits silent compatible video", () => {
    expect(
      planStream(
        {
          ...probe,
          streams: [
            {
              index: 0,
              codec_type: "video",
              codec_name: "h264",
              pix_fmt: "yuv420p10le",
            },
          ],
        },
        {},
      ).mode,
    ).toBe("transcode");
    expect(
      planStream(
        {
          ...probe,
          streams: [
            {
              index: 0,
              codec_type: "video",
              codec_name: "h264",
              pix_fmt: "yuv420p",
            },
          ],
        },
        {},
      ).audio,
    ).toBeNull();
  });
  it("directs compatible files and remuxes incompatible containers without video encoding", () => {
    expect(planStream(probe, {}).mode).toBe("direct");
    expect(
      planStream({ ...probe, format: { format_name: "matroska" } }, {}).mode,
    ).toBe("remux");
    expect(
      encodingArgs(
        { ...probe, format: { format_name: "matroska" } },
        {},
        "/dev/fd/3",
        "/tmp/cache",
      ),
    ).toContain("copy");
  });
  it("transcodes selected subtitles and rejects missing tracks", () => {
    expect(planStream(probe, { subtitleTrack: 2 }).mode).toBe("transcode");
    expect(() => planStream(probe, { audioTrack: 99 })).toThrow("Audio track");
    const args = encodingArgs(
      probe,
      { subtitleTrack: 2, quality: "480" },
      "/dev/fd/3",
      "/tmp/cache",
    );
    expect(args.join(" ")).toContain("subtitles=filename=/dev/fd/3:si=0");
    expect(args).toContain("delete_segments+independent_segments+temp_file");
    expect(args.join(" ")).not.toMatch(/alsa|pulse|pipewire/);
  });
});
