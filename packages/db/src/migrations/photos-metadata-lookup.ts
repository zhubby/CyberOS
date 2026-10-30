import type { Migration } from "./types.js";

export const photosMetadataLookupMigrations: Migration[] = [{
  id: "007_photos_metadata_lookup",
  sql: `
CREATE INDEX idx_photos_metadata_values_asset_sensitive
  ON photos_metadata_values(asset_id, sensitive, key, value_type);
`
}];
