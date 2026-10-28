import { describe, expect, it } from "vitest";
import {
  PHOTOS_IMAGE_EXTENSIONS,
  PHOTOS_RAW_EXTENSIONS,
  PHOTOS_SUPPORTED_EXTENSIONS,
  PHOTOS_VIDEO_EXTENSIONS,
  photosExtension,
  photosMediaKind,
  photosMimeType
} from "./photos-config.js";

describe("photos media configuration", () => {
  it("recognizes image, video, and RAW extensions case-insensitively", () => {
    for (const extension of PHOTOS_IMAGE_EXTENSIONS) {
      const fileName = `image${extension.toUpperCase()}`;
      expect(photosMediaKind(fileName)).toBe("image");
      expect(photosMimeType(fileName)).not.toBeNull();
    }
    for (const extension of PHOTOS_VIDEO_EXTENSIONS) {
      const fileName = `video${extension.toUpperCase()}`;
      expect(photosMediaKind(fileName)).toBe("video");
      expect(photosMimeType(fileName)).not.toBeNull();
    }
    for (const extension of PHOTOS_RAW_EXTENSIONS) {
      const fileName = `raw${extension.toUpperCase()}`;
      expect(photosMediaKind(fileName)).toBe("raw");
      expect(photosMimeType(fileName)).not.toBeNull();
    }
    expect(photosMimeType("clip.MKV")).toBe("video/x-matroska");
    expect(photosMimeType("camera.CR3")).toBe("image/x-canon-cr3");
  });

  it("normalizes extensions without treating a missing extension as media", () => {
    expect(photosExtension("folder/photos.JPG")).toBe(".jpg");
    expect(photosExtension("README")).toBe("");
    expect(photosMediaKind("README")).toBeNull();
    expect(photosMimeType("README")).toBeNull();
  });

  it("exposes one supported extension list for API and UI consumers", () => {
    expect(PHOTOS_SUPPORTED_EXTENSIONS).toContain(".mp4");
    expect(PHOTOS_SUPPORTED_EXTENSIONS).toContain(".dng");
    expect(PHOTOS_SUPPORTED_EXTENSIONS).toContain(".heif");
  });
});
