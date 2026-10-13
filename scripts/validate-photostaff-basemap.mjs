import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PMTiles, TileType } from "pmtiles";

const expected = {
  asset: "natural-earth-ii-3.2.0-raster.pmtiles",
  sizeBytes: 23_141_432,
  sha256: "a9b54608526b54ef348862b15c43d0e79a9b491ad573ccbc121202d2f196f1ba",
  source: {
    name: "Natural Earth II 3.2.0, medium raster",
    url: "https://naciscdn.org/naturalearth/10m/raster/NE2_LR_LC_SR_W_DR.zip",
    file: "NE2_LR_LC_SR_W_DR.tif",
    sizeBytes: 194_338_220,
    sha256: "73eb7a00b182c702e69892332cbd380edc7aa00ccaf68ae0111deefb87303a0e"
  }
};

class NodeFileRangeSource {
  constructor(filePath) {
    this.filePath = filePath;
  }

  getKey() {
    return this.filePath;
  }

  async getBytes(offset, length) {
    const handle = await open(this.filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return {
        data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead)
      };
    } finally {
      await handle.close();
    }
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = path.resolve(process.argv[2] ?? path.join(repoRoot, ".sigmaos/map-assets", expected.asset));
const archiveStat = await stat(archivePath);
assert(archiveStat.isFile(), "Map archive is not a regular file");
assert(archiveStat.size === expected.sizeBytes, `Expected ${expected.sizeBytes} bytes, got ${archiveStat.size}`);

const actualSha256 = await sha256File(archivePath);
assert(actualSha256 === expected.sha256, `Expected SHA-256 ${expected.sha256}, got ${actualSha256}`);

const archive = new PMTiles(new NodeFileRangeSource(archivePath));
const header = await archive.getHeader();
const metadata = await archive.getMetadata();
assert(header.specVersion === 3, `Expected PMTiles v3, got v${header.specVersion}`);
assert(header.tileType === TileType.Jpeg, `Expected JPEG tiles, got tile type ${header.tileType}`);
assert(header.tileCompression === 1, "JPEG tile payloads must not use additional compression");
assert(header.minZoom === 0 && header.maxZoom === 6, `Expected zoom range 0-6, got ${header.minZoom}-${header.maxZoom}`);
assert(closeTo(header.minLon, -180) && closeTo(header.maxLon, 180), "Longitude bounds are not global");
assert(closeTo(header.minLat, -85.051129) && closeTo(header.maxLat, 85.051129), "Latitude bounds are not Web Mercator world bounds");
assert(metadata.name === "Natural Earth II", "Unexpected map name");
assert(metadata.type === "baselayer", "Archive is not marked as a base layer");
assert(metadata.writer === "rio-pmtiles 1.2.2", "Unexpected PMTiles writer version");
assert(metadata.tileSize === 256, "Expected 256px tiles");

const worldTile = await archive.getZxy(0, 0, 0);
assert(worldTile, "Archive does not contain the z0/0/0 world tile");
const tileBytes = new Uint8Array(worldTile.data);
assert(tileBytes[0] === 0xff && tileBytes[1] === 0xd8 && tileBytes[2] === 0xff, "World tile is not JPEG data");

const checksumPath = `${archivePath}.sha256`;
const buildInfoPath = `${archivePath}.build-info.json`;
await writeFile(checksumPath, `${actualSha256}  ${path.basename(archivePath)}\n`);
await writeFile(buildInfoPath, `${JSON.stringify({
  asset: expected.asset,
  version: "3.2.0",
  source: expected.source,
  tool: { name: "rio-pmtiles", version: "1.2.2" },
  options: {
    format: "JPEG",
    tileSize: 256,
    resampling: "bilinear",
    jobs: 4
  },
  output: {
    sizeBytes: archiveStat.size,
    sha256: actualSha256,
    pmtilesVersion: header.specVersion,
    tileType: "jpeg",
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    tileCount: header.numAddressedTiles
  }
}, null, 2)}\n`);

console.log(`Validated ${archivePath}`);
console.log(`SHA-256 ${actualSha256}`);

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function closeTo(actual, expectedValue) {
  return Math.abs(actual - expectedValue) < 0.000001;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
