// Leaflet maps: the public launch map, the admin location picker, and the base
// layers under each launch page's sunlight map.

import L from "leaflet";
import "leaflet/dist/leaflet.css";

export interface Marker {
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
}

export function baseMap(element: HTMLElement, options: L.MapOptions = {}) {
  const map = L.map(element, { scrollWheelZoom: false, ...options });
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const topo = L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 16,
    attribution: 'Topo: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>',
  });
  osm.addTo(map);
  L.control.layers({ Map: osm, "Topo (US)": topo }, undefined, { position: "topright" }).addTo(map);
  element.addEventListener("focus", () => map.scrollWheelZoom.enable());
  element.addEventListener("blur", () => map.scrollWheelZoom.disable());
  return map;
}

export const markerStyle = { radius: 8, color: "#ffffff", weight: 2, fillColor: "#1c5cab", fillOpacity: 1 };

export function mountLaunchMap(element: HTMLElement, markers: Marker[]) {
  const map = baseMap(element);
  const bounds = L.latLngBounds([]);
  for (const m of markers) {
    const point = L.latLng(m.latitude, m.longitude);
    bounds.extend(point);
    const link = document.createElement("a");
    link.href = `/launches/${m.slug}`;
    link.textContent = m.name;
    L.circleMarker(point, markerStyle).bindPopup(link).addTo(map);
  }
  if (markers.length === 0) map.setView([43.6, -116.2], 8);
  else if (markers.length === 1) map.setView(bounds.getCenter(), 10);
  else map.fitBounds(bounds.pad(0.3));
  return map;
}

/** Click or drag to place a point; returns a setter for typed coordinates. */
export function mountPicker(element: HTMLElement, onPick: (lat: number, lon: number) => void, others: Marker[]) {
  const map = baseMap(element);
  map.scrollWheelZoom.enable();
  for (const m of others) {
    L.circleMarker([m.latitude, m.longitude], { ...markerStyle, fillColor: "#898781", radius: 6 })
      .bindTooltip(m.name)
      .addTo(map);
  }
  let marker: L.CircleMarker | null = null;
  const place = (lat: number, lon: number, pan: boolean) => {
    if (!marker) marker = L.circleMarker([lat, lon], { ...markerStyle, fillColor: "#eb6834", radius: 9 }).addTo(map);
    else marker.setLatLng([lat, lon]);
    if (pan) map.setView([lat, lon], Math.max(map.getZoom(), 13));
  };
  map.on("click", (event: L.LeafletMouseEvent) => {
    place(event.latlng.lat, event.latlng.lng, false);
    onPick(event.latlng.lat, event.latlng.lng);
  });
  map.setView([43.62, -116.1], 9);
  return {
    set(lat: number, lon: number) {
      if (Number.isFinite(lat) && Number.isFinite(lon)) place(lat, lon, true);
    },
    clear() {
      marker?.remove();
      marker = null;
    },
    invalidate() {
      map.invalidateSize();
    },
  };
}
