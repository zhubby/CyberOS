import { Crosshair, Download, LoaderCircle, Map as MapIcon, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  downloadPhotostaffMap,
  getPhotostaffMapSettings,
  queryPhotostaffMap,
  type PhotostaffMapQueryResult,
  type PhotostaffMapSettingsResponse,
  type PhotostaffQueryRequest
} from "../../api.js";
import type { PhotostaffLocationBounds } from "@sigmaos/shared";
import "maplibre-gl/dist/maplibre-gl.css";

const WORLD_BOUNDS: PhotostaffLocationBounds = { kind: "bounds", west: -180, south: -85, east: 180, north: 85 };

export function PhotostaffMapView({
  filters,
  onOpenAsset,
  onSearchBounds,
  onError
}: {
  filters: PhotostaffQueryRequest["filters"];
  onOpenAsset: (assetId: string) => void | Promise<void>;
  onSearchBounds: (bounds: PhotostaffLocationBounds) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import("maplibre-gl").Map | null>(null);
  const openAssetRef = useRef(onOpenAsset);
  const errorRef = useRef(onError);
  const filtersRef = useRef(filters);
  const searchBoundsRef = useRef(onSearchBounds);
  const clustersRef = useRef<PhotostaffMapQueryResult["clusters"]>([]);
  const loadRequestRef = useRef(0);
  const boundsRef = useRef<PhotostaffLocationBounds>(WORLD_BOUNDS);
  const [mapStatus, setMapStatus] = useState<PhotostaffMapSettingsResponse | null>(null);
  const [mapRequestError, setMapRequestError] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [result, setResult] = useState<PhotostaffMapQueryResult | null>(null);
  const [bounds, setBounds] = useState<PhotostaffLocationBounds>(WORLD_BOUNDS);
  const [pendingBounds, setPendingBounds] = useState<PhotostaffLocationBounds | null>(null);
  const [loading, setLoading] = useState(true);

  filtersRef.current = filters;
  searchBoundsRef.current = onSearchBounds;

  const loadPoints = useCallback(async (nextBounds: PhotostaffLocationBounds, commitBounds = false) => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    try {
      const next = await queryPhotostaffMap({
        ...(filtersRef.current ? { filters: filtersRef.current } : {}),
        bounds: nextBounds,
        columns: 64,
        rows: 64
      });
      if (requestId !== loadRequestRef.current) return;
      setResult(next);
      setBounds(nextBounds);
      boundsRef.current = nextBounds;
      setPendingBounds(null);
      if (commitBounds) searchBoundsRef.current(nextBounds);
    } catch (error) {
      if (requestId === loadRequestRef.current) {
        errorRef.current(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    openAssetRef.current = onOpenAsset;
    errorRef.current = onError;
  }, [onError, onOpenAsset]);

  useEffect(() => {
    let active = true;
    void getPhotostaffMapSettings().then((response) => {
      if (!active) return;
      setMapStatus(response);
      setMapRequestError(null);
      const initial = response.settings?.bounds
        ? tupleToBounds(response.settings.bounds)
        : WORLD_BOUNDS;
      void loadPoints(initial);
    }).catch((error) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : String(error);
      setMapRequestError(message);
      errorRef.current(message);
    });
    return () => {
      active = false;
      loadRequestRef.current += 1;
    };
  }, [loadPoints]);

  useEffect(() => {
    if (mapStatus?.download.state !== "downloading") return undefined;
    let active = true;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const next = await getPhotostaffMapSettings();
        if (!active) return;
        setMapStatus(next);
        setMapRequestError(null);
        if (next.download.state === "downloading") timer = window.setTimeout(() => void poll(), 1_000);
      } catch (error) {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setMapRequestError(message);
        timer = window.setTimeout(() => void poll(), 1_000);
      }
    };
    timer = window.setTimeout(() => void poll(), 1_000);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [mapStatus?.download.state]);

  useEffect(() => {
    if (result) void loadPoints(boundsRef.current);
  }, [filters, loadPoints]);

  useEffect(() => {
    const settings = mapStatus?.settings;
    if (!settings || mapStatus.download.state !== "ready" || !hostRef.current) return undefined;
    let disposed = false;
    let removeProtocol: (() => void) | null = null;
    void Promise.all([import("maplibre-gl"), import("pmtiles")]).then(([mapModule, pmtilesModule]) => {
      if (disposed || !hostRef.current) return;
      const maplibre = mapModule;
      const protocol = new pmtilesModule.Protocol();
      maplibre.addProtocol("pmtiles", protocol.tile);
      removeProtocol = () => maplibre.removeProtocol("pmtiles");
      const archiveUrl = `${window.location.origin}/api/photostaff/map/archive`;
      const initialBounds = settings.bounds ?? [-180, -85, 180, 85];
      const map = new maplibre.Map({
        container: hostRef.current,
        attributionControl: false,
        center: midpoint(initialBounds),
        zoom: Math.max(settings.minZoom, 1),
        minZoom: settings.minZoom,
        maxZoom: settings.maxZoom,
        style: {
          version: 8,
          sources: {
            offline: {
              type: "raster",
              url: `pmtiles://${archiveUrl}`,
              tileSize: 256,
              attribution: settings.attribution ?? ""
            },
            photostaff: { type: "geojson", data: emptyFeatureCollection() }
          },
          layers: [
            { id: "offline", type: "raster", source: "offline" },
            {
              id: "photostaff-points",
              type: "circle",
              source: "photostaff",
              paint: {
                "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 7, 100, 18],
                "circle-color": "#f4c95d",
                "circle-stroke-color": "#16191f",
                "circle-stroke-width": 2
              }
            },
            {
              id: "photostaff-counts",
              type: "symbol",
              source: "photostaff",
              filter: [">", ["get", "count"], 1],
              layout: { "text-field": ["to-string", ["get", "count"]], "text-size": 11 },
              paint: { "text-color": "#16191f" }
            }
          ]
        }
      });
      mapRef.current = map;
      map.on("load", () => {
        const source = map.getSource("photostaff") as import("maplibre-gl").GeoJSONSource | undefined;
        source?.setData(pointsToGeoJson(clustersRef.current));
      });
      map.on("moveend", () => {
        const viewport = map.getBounds();
        setPendingBounds(photostaffViewportBounds(
          viewport.getWest(), viewport.getSouth(), viewport.getEast(), viewport.getNorth()
        ));
      });
      map.on("click", "photostaff-points", (event: import("maplibre-gl").MapLayerMouseEvent) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== "Point") return;
        const count = Number(feature.properties?.count ?? 0);
        const assetId = String(feature.properties?.assetId ?? "");
        const coordinates = feature.geometry.coordinates as [number, number];
        if (count === 1 && assetId) void openAssetRef.current(assetId);
        else map.easeTo({ center: coordinates, zoom: Math.min(map.getZoom() + 2, settings.maxZoom) });
      });
    }).catch((error) => errorRef.current(error instanceof Error ? error.message : String(error)));
    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
      removeProtocol?.();
    };
  }, [mapStatus?.download.state, mapStatus?.settings]);

  useEffect(() => {
    clustersRef.current = result?.clusters ?? [];
    const source = mapRef.current?.getSource("photostaff") as import("maplibre-gl").GeoJSONSource | undefined;
    source?.setData(pointsToGeoJson(clustersRef.current));
  }, [result]);

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      onError(t("workspace.photostaff.locationUnavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition((position) => {
      const center: [number, number] = [position.coords.longitude, position.coords.latitude];
      mapRef.current?.easeTo({ center, zoom: Math.max(mapRef.current.getZoom(), 6) });
    }, (error) => onError(error.message));
  }

  async function startDownload() {
    if (downloadBusy || mapStatus?.download.state === "downloading") return;
    setDownloadBusy(true);
    setMapRequestError(null);
    try {
      setMapStatus(await downloadPhotostaffMap());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMapRequestError(message);
      errorRef.current(message);
    } finally {
      setDownloadBusy(false);
    }
  }

  const mapReady = mapArchiveReady(mapStatus);
  const mapLabel = mapStatus
    ? `${mapStatus.map.name} ${mapStatus.map.version}`
    : t("workspace.photostaff.offlineMap");
  return (
    <section className="photostaff-map-view" aria-label={t("workspace.photostaff.mapView")}>
      <div className="photostaff-map-toolbar">
        <span>{mapLabel}</span>
        <div>
          <button type="button" onClick={useCurrentLocation} disabled={!mapReady} title={t("workspace.photostaff.myLocation")} aria-label={t("workspace.photostaff.myLocation")}>
            <Crosshair aria-hidden="true" size={15} />
          </button>
          <button type="button" onClick={() => void loadPoints(pendingBounds ?? bounds, true)} disabled={!mapReady || !pendingBounds || loading}>
            <Search aria-hidden="true" size={14} />{t("workspace.photostaff.searchArea")}
          </button>
        </div>
      </div>
      <div className="photostaff-map-canvas">
        {!mapReady ? (
          <div className="photostaff-coordinate-canvas">
            <div className="photostaff-coordinate-grid" aria-hidden="true" />
            <PhotostaffMapDownloadPanel
              status={mapStatus}
              requestError={mapRequestError}
              busy={downloadBusy}
              onDownload={() => void startDownload()}
            />
          </div>
        ) : <div ref={hostRef} className="photostaff-maplibre" />}
        {loading && mapReady ? <div className="photostaff-map-loading"><LoaderCircle className="is-spinning" aria-hidden="true" size={20} /></div> : null}
      </div>
      {result?.metadataIndex.pending ? (
        <p className="photostaff-index-progress">{t("workspace.photostaff.metadataProgress", {
          indexed: result.metadataIndex.indexed,
          total: result.metadataIndex.total
        })}</p>
      ) : null}
    </section>
  );
}

export function mapArchiveReady(status: PhotostaffMapSettingsResponse | null): boolean {
  return status?.download.state === "ready" && status.settings !== null;
}

export function PhotostaffMapDownloadPanel({
  status,
  requestError,
  busy,
  onDownload
}: {
  status: PhotostaffMapSettingsResponse | null;
  requestError: string | null;
  busy: boolean;
  onDownload: () => void;
}) {
  const { t } = useTranslation();
  if (mapArchiveReady(status)) return null;
  const state = status?.download.state;
  const received = status?.download.receivedBytes ?? 0;
  const total = status?.download.totalBytes ?? status?.map.sizeBytes ?? 0;
  const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
  const error = requestError ?? status?.download.error;

  if (!status && !error) {
    return (
      <div className="photostaff-map-download-state" role="status" aria-live="polite">
        <LoaderCircle className="is-spinning" aria-hidden="true" size={22} />
        <strong>{t("workspace.photostaff.mapChecking")}</strong>
      </div>
    );
  }
  if (state === "downloading") {
    return (
      <div className="photostaff-map-download-state" role="status" aria-live="polite">
        <LoaderCircle className="is-spinning" aria-hidden="true" size={22} />
        <strong>{t("workspace.photostaff.mapDownloading")}</strong>
        <div className="photostaff-map-progress" role="progressbar" aria-label={t("workspace.photostaff.mapDownloading")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <span style={{ width: `${percent}%` }} />
        </div>
        <small>{t("workspace.photostaff.mapDownloadProgress", {
          percent,
          received: formatMapBytes(received),
          total: formatMapBytes(total)
        })}</small>
      </div>
    );
  }
  if (state === "failed" || error) {
    return (
      <div className="photostaff-map-download-state is-error" role="alert">
        <MapIcon aria-hidden="true" size={22} />
        <strong>{t("workspace.photostaff.mapDownloadFailed")}</strong>
        <p>{error}</p>
        <button className="primary-button" type="button" onClick={onDownload} disabled={busy} aria-busy={busy || undefined}>
          {busy ? <LoaderCircle className="is-spinning" aria-hidden="true" size={16} /> : <RefreshCw aria-hidden="true" size={16} />}
          {t("workspace.photostaff.mapRetry")}
        </button>
      </div>
    );
  }
  return (
    <div className="photostaff-map-download-state" role="status">
      <MapIcon aria-hidden="true" size={22} />
      <strong>{t("workspace.photostaff.noBaseMap")}</strong>
      <button className="primary-button" type="button" onClick={onDownload} disabled={busy} aria-busy={busy || undefined}>
        {busy ? <LoaderCircle className="is-spinning" aria-hidden="true" size={16} /> : <Download aria-hidden="true" size={16} />}
        {t("workspace.photostaff.downloadOfflineMap")}
      </button>
    </div>
  );
}

function formatMapBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function tupleToBounds(bounds: [number, number, number, number]): PhotostaffLocationBounds {
  return { kind: "bounds", west: bounds[0], south: bounds[1], east: bounds[2], north: bounds[3] };
}

function midpoint(bounds: [number, number, number, number]): [number, number] {
  const longitude = bounds[0] <= bounds[2]
    ? (bounds[0] + bounds[2]) / 2
    : normalizeLongitude((bounds[0] + bounds[2] + 360) / 2);
  return [longitude, (bounds[1] + bounds[3]) / 2];
}

function pointsToGeoJson(clusters: PhotostaffMapQueryResult["clusters"]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: clusters.map((cluster) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [cluster.longitude, cluster.latitude] },
      properties: { count: cluster.count, assetId: cluster.assetId ?? "" }
    }))
  };
}

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export function photostaffViewportBounds(
  west: number,
  south: number,
  east: number,
  north: number
): PhotostaffLocationBounds {
  if (east - west >= 360) {
    return { kind: "bounds", west: -180, south: Math.max(-90, south), east: 180, north: Math.min(90, north) };
  }
  const normalizedEast = normalizeLongitude(east);
  return {
    kind: "bounds",
    west: normalizeLongitude(west),
    south: Math.max(-90, south),
    east: normalizedEast === -180 && east > 0 ? 180 : normalizedEast,
    north: Math.min(90, north)
  };
}

function normalizeLongitude(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}
