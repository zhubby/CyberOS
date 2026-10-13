#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ASSET_DIR="$ROOT_DIR/.sigmaos/map-assets"
SOURCE_URL="https://naciscdn.org/naturalearth/10m/raster/NE2_LR_LC_SR_W_DR.zip"
SOURCE_SHA256="73eb7a00b182c702e69892332cbd380edc7aa00ccaf68ae0111deefb87303a0e"
SOURCE_ARCHIVE="$ASSET_DIR/NE2_LR_LC_SR_W_DR.zip"
SOURCE_DIRECTORY="$ASSET_DIR/natural-earth-source"
SOURCE_RASTER="$SOURCE_DIRECTORY/NE2_LR_LC_SR_W_DR.tif"
OUTPUT="$ASSET_DIR/natural-earth-ii-3.2.0-raster.pmtiles"
VENV="$ASSET_DIR/venv"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

for command_name in curl node python3 unzip; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  fi
done

mkdir -p "$ASSET_DIR" "$SOURCE_DIRECTORY"
if [ ! -f "$SOURCE_ARCHIVE" ]; then
  curl --fail --location --retry 3 --output "$SOURCE_ARCHIVE.part" "$SOURCE_URL"
  mv "$SOURCE_ARCHIVE.part" "$SOURCE_ARCHIVE"
fi

actual_source_sha256=$(sha256_file "$SOURCE_ARCHIVE")
if [ "$actual_source_sha256" != "$SOURCE_SHA256" ]; then
  printf 'Natural Earth source checksum mismatch: expected %s, got %s\n' \
    "$SOURCE_SHA256" "$actual_source_sha256" >&2
  exit 1
fi

python3 -m venv --clear "$VENV"
"$VENV/bin/python" -m pip install --disable-pip-version-check "rio-pmtiles==1.2.2"
unzip -oq "$SOURCE_ARCHIVE" "NE2_LR_LC_SR_W_DR.tif" -d "$SOURCE_DIRECTORY"
rm -f "$OUTPUT"

"$VENV/bin/rio" pmtiles \
  "$SOURCE_RASTER" \
  "$OUTPUT" \
  --format JPEG \
  --tile-size 256 \
  --resampling bilinear \
  --baselayer \
  --name "Natural Earth II" \
  --description "Natural Earth II 3.2.0 global overview for SigmaOS" \
  --attribution "Made with Natural Earth" \
  -j 4

node "$ROOT_DIR/scripts/validate-photostaff-basemap.mjs" "$OUTPUT"
