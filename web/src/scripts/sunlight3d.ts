// The sunlight map's 3D view: the launch's square of terrain as a relief
// model, coloured with the same W/m² as the 2D map for the chosen time, with
// the sun in the sky, the launch marked and north labelled. Loaded only when
// the 3D view is first opened (it pulls in three.js).
//
// Coordinates: x east, y up, z south, in metres from the square's centre;
// heights above the square's lowest point, times the relief exaggeration.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { heightAt, latLonToPixel, metresPerPixel, pixelToLatLon, type ReliefMeta } from "../lib/relief.ts";

export interface Sunlight3DOptions {
  container: HTMLElement;
  meta: ReliefMeta;
  heights: Float32Array;
  /** The sunlight picture draped on the ground; covers the relief's extent exactly. */
  picture: HTMLCanvasElement;
  launch: { latitude: number; longitude: number; name: string; facingDeg: number };
  onPick(lat: number, lon: number): void;
}

const SKIRT_M = 120;

/** True when this browser can draw WebGL. */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function cssColor(element: HTMLElement, name: string, fallback: string) {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value || fallback;
}

/** A text label that always faces the camera. */
function label(text: string, ink: string, halo: string, scale: number): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = "600 44px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + 24;
  canvas.height = 64;
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 10;
  ctx.strokeStyle = halo;
  ctx.lineJoin = "round";
  ctx.strokeText(text, canvas.width / 2, 34);
  ctx.fillStyle = ink;
  ctx.fillText(text, canvas.width / 2, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set((canvas.width / canvas.height) * scale, scale, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export class Sunlight3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly texture: THREE.CanvasTexture;
  private readonly geometry: THREE.BufferGeometry;
  private readonly ground: THREE.Mesh;
  private readonly skirt: THREE.Mesh;
  private readonly sun = new THREE.Group();
  private readonly launchPin = new THREE.Group();
  private readonly selected: THREE.Mesh;
  private readonly observer: ResizeObserver;
  private readonly mpp: number;
  private readonly cx: number;
  private readonly cy: number;
  private exaggeration = 1;
  private frame = 0;
  private sunDirection: THREE.Vector3 | null = null;
  private selectedAt: { lat: number; lon: number } | null = null;

  constructor(private readonly options: Sunlight3DOptions) {
    const { container, meta, picture, launch } = options;
    const ink = cssColor(container, "--ink", "#0b0b0b");
    const surface = cssColor(container, "--surface", "#fcfcfb");
    const side = cssColor(container, "--axis", "#c3c2b7");

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(new THREE.Color(surface));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    container.appendChild(this.renderer.domElement);

    const centreLat = pixelToLatLon(meta.x0 + (meta.width - 1) / 2, meta.y0 + (meta.height - 1) / 2, meta.zoom).lat;
    this.mpp = metresPerPixel(centreLat, meta.zoom);
    this.cx = meta.x0 + (meta.width - 1) / 2;
    this.cy = meta.y0 + (meta.height - 1) / 2;
    const extent = (meta.width - 1) * this.mpp;

    this.camera = new THREE.PerspectiveCamera(40, 1, 20, extent * 8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.maxPolarAngle = (84 * Math.PI) / 180;
    this.controls.minDistance = 600;
    this.controls.maxDistance = extent * 2.2;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener("change", () => this.requestRender());

    // Ground: one vertex per relief height, the sunlight picture draped over it.
    this.texture = new THREE.CanvasTexture(picture);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.geometry = this.buildGround();
    this.ground = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ map: this.texture }));
    this.scene.add(this.ground);
    this.skirt = new THREE.Mesh(this.buildSkirt(), new THREE.MeshBasicMaterial({ color: new THREE.Color(side), side: THREE.DoubleSide }));
    this.scene.add(this.skirt);

    // North, the launch, the selected spot and the sun.
    const north = label("N", ink, surface, extent / 22);
    north.position.set(0, extent / 40, -extent / 2 - extent / 30);
    this.scene.add(north);

    const pinHeight = extent / 28;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(extent / 900, extent / 900, pinHeight, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(ink) }));
    stem.position.y = pinHeight / 2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(extent / 160, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(ink) }));
    head.position.y = pinHeight;
    const name = label(`${launch.name} launch`, ink, surface, extent / 40);
    name.position.y = pinHeight + extent / 45;
    this.launchPin.add(stem, head, name);
    this.scene.add(this.launchPin);

    this.selected = new THREE.Mesh(new THREE.SphereGeometry(extent / 180, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(ink) }));
    const ring = new THREE.Mesh(new THREE.SphereGeometry(extent / 140, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(surface), side: THREE.BackSide }));
    this.selected.add(ring);
    this.selected.visible = false;
    this.scene.add(this.selected);

    const disc = new THREE.Mesh(new THREE.SphereGeometry(extent / 45, 24, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color("#f4b400") }));
    const sunLabel = label("Sun", ink, surface, extent / 36);
    sunLabel.position.y = extent / 22;
    this.sun.add(disc, sunLabel);
    this.scene.add(this.sun);

    this.placeMarkers();
    this.lookAtLaunch();

    // Tap or click (without dragging) picks a spot.
    let down: { x: number; y: number } | null = null;
    this.renderer.domElement.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    this.renderer.domElement.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) this.pick(e);
      down = null;
    });

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }

  // ── geometry ────────────────────────────────────────────────────────────

  private groundY(h: number) {
    const min = this.options.meta.minM ?? 0;
    return ((Number.isNaN(h) ? min : h) - min) * this.exaggeration;
  }

  private buildGround(): THREE.BufferGeometry {
    const { meta, heights } = this.options;
    const { width: W, height: H } = meta;
    const positions = new Float32Array(W * H * 3);
    const uvs = new Float32Array(W * H * 2);
    for (let j = 0; j < H; j += 1) {
      for (let i = 0; i < W; i += 1) {
        const k = j * W + i;
        positions[3 * k] = (meta.x0 + i - this.cx) * this.mpp;
        positions[3 * k + 1] = this.groundY(heights[k]);
        positions[3 * k + 2] = (meta.y0 + j - this.cy) * this.mpp;
        uvs[2 * k] = i / (W - 1);
        uvs[2 * k + 1] = 1 - j / (H - 1);
      }
    }
    const index = new Uint32Array((W - 1) * (H - 1) * 6);
    let o = 0;
    for (let j = 0; j < H - 1; j += 1) {
      for (let i = 0; i < W - 1; i += 1) {
        const a = j * W + i;
        index[o++] = a;
        index[o++] = a + W;
        index[o++] = a + 1;
        index[o++] = a + 1;
        index[o++] = a + W;
        index[o++] = a + W + 1;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.computeBoundingSphere();
    return geometry;
  }

  /** Side walls down from the edge, so the square reads as a block of ground. */
  private buildSkirt(): THREE.BufferGeometry {
    const { meta } = this.options;
    const { width: W, height: H } = meta;
    const edge: number[] = [];
    for (let i = 0; i < W; i += 1) edge.push(i);
    for (let j = 1; j < H; j += 1) edge.push(j * W + W - 1);
    for (let i = W - 2; i >= 0; i -= 1) edge.push((H - 1) * W + i);
    for (let j = H - 2; j >= 1; j -= 1) edge.push(j * W);
    edge.push(0);
    const positions: number[] = [];
    const ground = this.geometry.getAttribute("position");
    for (let n = 0; n < edge.length - 1; n += 1) {
      const a = edge[n];
      const b = edge[n + 1];
      const ax = ground.getX(a), ay = ground.getY(a), az = ground.getZ(a);
      const bx = ground.getX(b), by = ground.getY(b), bz = ground.getZ(b);
      positions.push(ax, ay, az, ax, -SKIRT_M, az, bx, by, bz, bx, by, bz, ax, -SKIRT_M, az, bx, -SKIRT_M, bz);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }

  /** Scene position of a latitude and longitude, on the ground. */
  private positionOf(lat: number, lon: number): THREE.Vector3 {
    const { meta, heights } = this.options;
    const p = latLonToPixel(lat, lon, meta.zoom);
    const h = heightAt(heights, meta, p.x - meta.x0, p.y - meta.y0);
    return new THREE.Vector3((p.x - this.cx) * this.mpp, this.groundY(h), (p.y - this.cy) * this.mpp);
  }

  private placeMarkers() {
    const { launch } = this.options;
    this.launchPin.position.copy(this.positionOf(launch.latitude, launch.longitude));
    if (this.selectedAt) this.selected.position.copy(this.positionOf(this.selectedAt.lat, this.selectedAt.lon));
    this.placeSun();
  }

  private placeSun() {
    const d = this.sunDirection;
    this.sun.visible = !!d;
    if (!d) return;
    const extent = (this.options.meta.width - 1) * this.mpp;
    this.sun.position.copy(d).multiplyScalar(extent * 0.7);
    this.sun.position.y += this.groundY(this.options.meta.maxM ?? 0) * 0.3;
  }

  /** Starts looking at the launch from the side it faces, from 30° up. */
  private lookAtLaunch() {
    const target = this.positionOf(this.options.launch.latitude, this.options.launch.longitude);
    const a = (this.options.launch.facingDeg * Math.PI) / 180;
    const extent = (this.options.meta.width - 1) * this.mpp;
    const distance = Math.min(extent * 0.55, 11_000);
    const el = (30 * Math.PI) / 180;
    this.camera.position.set(target.x + Math.sin(a) * Math.cos(el) * distance, target.y + Math.sin(el) * distance, target.z - Math.cos(a) * Math.cos(el) * distance);
    this.controls.target.copy(target);
    this.controls.update();
  }

  // ── updates from the page ───────────────────────────────────────────────

  /** The sunlight picture was redrawn. */
  pictureChanged() {
    this.texture.needsUpdate = true;
    this.requestRender();
  }

  /** The sun's azimuth (from north, clockwise) and elevation; below the horizon hides it. */
  setSun(azimuthDeg: number, elevationDeg: number) {
    if (elevationDeg <= 0) {
      this.sunDirection = null;
    } else {
      const az = (azimuthDeg * Math.PI) / 180;
      const el = (elevationDeg * Math.PI) / 180;
      this.sunDirection = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    }
    this.placeSun();
    this.requestRender();
  }

  setSelected(point: { lat: number; lon: number } | null) {
    this.selectedAt = point;
    this.selected.visible = !!point;
    if (point) this.selected.position.copy(this.positionOf(point.lat, point.lon));
    this.requestRender();
  }

  /** Vertical scale of the relief (1 = true scale). */
  setExaggeration(k: number) {
    if (k === this.exaggeration) return;
    const ratio = k / this.exaggeration;
    this.exaggeration = k;
    const { heights } = this.options;
    const positions = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let n = 0; n < heights.length; n += 1) positions.setY(n, this.groundY(heights[n]));
    positions.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.skirt.geometry.dispose();
    this.skirt.geometry = this.buildSkirt();
    this.placeMarkers();
    // Keep the view on the same spot of ground: it moved up or down with the scale.
    const shift = this.controls.target.y * (ratio - 1);
    this.controls.target.y += shift;
    this.camera.position.y += shift;
    this.controls.update();
    this.requestRender();
  }

  private pick(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const hit = raycaster.intersectObject(this.ground, false)[0];
    if (!hit?.uv) return;
    const { meta } = this.options;
    const { lat, lon } = pixelToLatLon(meta.x0 + hit.uv.x * (meta.width - 1), meta.y0 + (1 - hit.uv.y) * (meta.height - 1), meta.zoom);
    this.options.onPick(lat, lon);
  }

  // ── drawing ─────────────────────────────────────────────────────────────

  private resize() {
    const { container } = this.options;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.render(this.scene, this.camera);
    });
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
