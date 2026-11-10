"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";

import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/tooltip";
import type { SeascapeGrid } from "@/lib/seascape-grid";
import {
  buildSeascapeScene,
  DEEP_COLOR,
  LAND_COLOR,
  SHALLOW_COLOR,
  type Point3,
  type SceneBounds,
  type SceneLabel,
} from "@/lib/seascape-scene";
import { hasWebGL2 } from "@/lib/webgl";

// The opening view: from the south-south-east, 22° above the horizon.
const DEFAULT_YAW = (-32 * Math.PI) / 180;
const DEFAULT_PITCH = (22 * Math.PI) / 180;
const CAMERA_DISTANCE = 50;
// The scene fills this share of the canvas at zoom 1.
const FIT = 0.92;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.2;

const WATER_COLOR = "#3B82F6";
const PIN_COLOR = "#F43F5E";
const CONTOUR_COLOR = "#F8FAFC";
// Slate, legible on the card in either theme.
const AXIS_COLOR = "#94A3B8";

// Which label survives when two collide on screen: lower ranks are placed first.
const LABEL_RANK: Record<SceneLabel["kind"], number> = {
  title: 0,
  tick: 1,
  major: 2,
  minor: 3,
};
const LABEL_CLASS: Record<SceneLabel["kind"], string> = {
  title: "text-[11px] font-semibold text-foreground/75",
  tick: "text-[10px] text-foreground/75",
  major:
    "rounded bg-background/60 px-1 text-[10px] font-semibold text-foreground",
  minor: "rounded bg-background/60 px-1 text-[10px] text-foreground/85",
};
// Room kept clear around a label, in pixels.
const LABEL_GAP = 3;

// Flat, two-sided shading with the light fixed to the camera, so the relief reads the
// same from any side. The face normal comes from screen-space derivatives, which makes
// every triangle one flat tone; it is flipped to face the viewer, so the underside of
// the terrain, seen from below, is lit too. Colours are multiplied as they are, in sRGB.
const TERRAIN_VERTEX = /* glsl */ `
  varying vec3 vColor;
  varying vec3 vViewPosition;
  void main() {
    vColor = color;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = viewPosition.xyz;
    gl_Position = projectionMatrix * viewPosition;
  }
`;
const TERRAIN_FRAGMENT = /* glsl */ `
  uniform vec3 lightDirection;
  varying vec3 vColor;
  varying vec3 vViewPosition;
  void main() {
    vec3 normal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    if (normal.z < 0.0) normal = -normal;
    float shade = 0.45 + 0.55 * max(0.0, dot(normal, lightDirection));
    gl_FragColor = vec4(vColor * shade, 1.0);
  }
`;

export interface SeascapeViewProps {
  grid: SeascapeGrid;
  /** The data source's short name, for the chip over the view. */
  sourceLabel: string;
}

interface ViewHandle {
  zoomBy: (factor: number) => void;
  reset: () => void;
}

export default function SeascapeView({ grid, sourceLabel }: SeascapeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const needleRef = useRef<SVGGElement>(null);
  const northLabelRef = useRef<SVGTextElement>(null);
  const handleRef = useRef<ViewHandle | null>(null);
  const labelRefs = useRef<(HTMLSpanElement | null)[]>([]);
  // Asked once, while rendering: this module only ever loads in the browser, through
  // the `ssr: false` import in `seascape-sample.tsx`.
  const [webgl] = useState(hasWebGL2);
  const scene = useMemo(() => buildSeascapeScene(grid), [grid]);

  useEffect(() => {
    const container = containerRef.current;
    if (!webgl || !container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.className = "absolute inset-0 h-full w-full touch-none";
    container.prepend(renderer.domElement);

    const world = new THREE.Scene();
    const disposables: { dispose: () => void }[] = [];

    // Terrain.
    const terrainGeometry = new THREE.BufferGeometry();
    terrainGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(scene.positions, 3),
    );
    terrainGeometry.setAttribute(
      "color",
      new THREE.BufferAttribute(scene.colors, 3),
    );
    terrainGeometry.setIndex(new THREE.BufferAttribute(scene.indices, 1));
    const terrainMaterial = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VERTEX,
      fragmentShader: TERRAIN_FRAGMENT,
      vertexColors: true,
      side: THREE.DoubleSide,
      uniforms: {
        lightDirection: {
          value: new THREE.Vector3(-0.35, 0.78, 0.52).normalize(),
        },
      },
      // Pushed back a little so the contours floating just above it are not swallowed.
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });
    world.add(new THREE.Mesh(terrainGeometry, terrainMaterial));
    disposables.push(terrainGeometry, terrainMaterial);

    // Lines a fixed number of pixels wide. Chrome is drawn over the terrain rather
    // than hidden behind it.
    const lineMaterials: LineMaterial[] = [];
    const addLines = (
      segments: Float32Array,
      color: string,
      width: number,
      opacity: number,
      chrome = false,
    ) => {
      if (segments.length === 0) return;
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(segments);
      const material = new LineMaterial({
        color,
        linewidth: width,
        transparent: true,
        opacity,
        depthTest: !chrome,
      });
      const lines = new LineSegments2(geometry, material);
      if (chrome) lines.renderOrder = 4;
      world.add(lines);
      lineMaterials.push(material);
      disposables.push(geometry, material);
    };
    // Contours: minor every step, major every fifth.
    addLines(scene.minorContours, CONTOUR_COLOR, 1.2, 0.5);
    addLines(scene.majorContours, CONTOUR_COLOR, 2, 0.85);
    addLines(scene.axisLines, AXIS_COLOR, 2, 0.9, true);
    addLines(scene.axisTicks, AXIS_COLOR, 1.5, 0.9, true);

    // The water surface, a faint tint over everything below the waterline.
    const { bounds } = scene;
    const waterGeometry = new THREE.PlaneGeometry(
      bounds.maxX - bounds.minX,
      bounds.maxZ - bounds.minZ,
    );
    waterGeometry.rotateX(-Math.PI / 2);
    waterGeometry.translate(
      (bounds.minX + bounds.maxX) / 2,
      0,
      (bounds.minZ + bounds.maxZ) / 2,
    );
    const waterMaterial = new THREE.MeshBasicMaterial({
      color: WATER_COLOR,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const water = new THREE.Mesh(waterGeometry, waterMaterial);
    water.renderOrder = 1;
    world.add(water);
    disposables.push(waterGeometry, waterMaterial);

    // The site: a marker just above the surface, always drawn on top, and a stake
    // down to the seabed when there is water under it.
    const pinMaterial = new THREE.MeshBasicMaterial({
      color: PIN_COLOR,
      depthTest: false,
    });
    const markerGeometry = new THREE.SphereGeometry(0.09, 16, 12);
    const marker = new THREE.Mesh(markerGeometry, pinMaterial);
    marker.position.set(scene.pin.x, 0.15, scene.pin.z);
    marker.renderOrder = 3;
    world.add(marker);
    disposables.push(pinMaterial, markerGeometry);
    if (scene.pin.seabedY !== null) {
      const stakeGeometry = new THREE.CylinderGeometry(
        0.02,
        0.02,
        -scene.pin.seabedY,
        8,
      );
      const stakeMaterial = new THREE.MeshBasicMaterial({
        color: PIN_COLOR,
        transparent: true,
        opacity: 0.85,
      });
      const stake = new THREE.Mesh(stakeGeometry, stakeMaterial);
      stake.position.set(scene.pin.x, scene.pin.seabedY / 2, scene.pin.z);
      stake.renderOrder = 2;
      world.add(stake);
      disposables.push(stakeGeometry, stakeMaterial);
    }

    // Camera, orbiting the middle of the scene.
    const target = new THREE.Vector3(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + Math.max(bounds.maxY, 0.6)) / 2,
      (bounds.minZ + bounds.maxZ) / 2,
    );
    const camera = new THREE.OrthographicCamera(
      -1,
      1,
      1,
      -1,
      0.1,
      CAMERA_DISTANCE * 4,
    );
    camera.position
      .set(
        -Math.cos(DEFAULT_PITCH) * Math.sin(DEFAULT_YAW),
        Math.sin(DEFAULT_PITCH),
        Math.cos(DEFAULT_PITCH) * Math.cos(DEFAULT_YAW),
      )
      .multiplyScalar(CAMERA_DISTANCE)
      .add(target);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    // The axis labels hang outside the tile, so the fit makes room for them too.
    const extent = viewExtent(
      bounds,
      scene.labels
        .filter((label) => label.kind === "title" || label.kind === "tick")
        .flatMap((label) => label.anchors),
      camera,
    );

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.minZoom = MIN_ZOOM;
    controls.maxZoom = MAX_ZOOM;
    // Up to 80° above or below the horizon.
    controls.minPolarAngle = (10 * Math.PI) / 180;
    controls.maxPolarAngle = (170 * Math.PI) / 180;
    controls.update();
    controls.saveState();

    // Labels are HTML laid over the canvas: each frame every label goes to its anchor
    // nearest the camera, in rank order, and one that would overlap a label already
    // placed, or falls off the canvas, is hidden for that frame.
    const labelOrder = scene.labels
      .map((label, i) => ({ rank: LABEL_RANK[label.kind], i }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ i }) => i);
    const labelSizes: { width: number; height: number }[] = [];
    const projected = new THREE.Vector3();
    const inView = new THREE.Vector3();
    const placeLabels = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      const placed: {
        left: number;
        right: number;
        top: number;
        bottom: number;
      }[] = [];
      for (const i of labelOrder) {
        const element = labelRefs.current[i];
        if (!element) continue;
        // Measured once: the text never changes.
        labelSizes[i] ??= {
          width: element.offsetWidth,
          height: element.offsetHeight,
        };
        const size = labelSizes[i];

        let best: { x: number; y: number } | null = null;
        let nearest = -Infinity;
        for (const anchor of scene.labels[i].anchors) {
          inView.set(...anchor).applyMatrix4(camera.matrixWorldInverse);
          projected.set(...anchor).project(camera);
          if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) continue;
          if (inView.z > nearest) {
            nearest = inView.z;
            best = {
              x: ((projected.x + 1) / 2) * width,
              y: ((1 - projected.y) / 2) * height,
            };
          }
        }

        const box = best && {
          left: best.x - size.width / 2 - LABEL_GAP,
          right: best.x + size.width / 2 + LABEL_GAP,
          top: best.y - size.height / 2 - LABEL_GAP,
          bottom: best.y + size.height / 2 + LABEL_GAP,
        };
        if (
          !box ||
          placed.some(
            (other) =>
              box.left < other.right &&
              box.right > other.left &&
              box.top < other.bottom &&
              box.bottom > other.top,
          )
        ) {
          element.style.visibility = "hidden";
          continue;
        }
        placed.push(box);
        element.style.transform = `translate(${box.left + LABEL_GAP}px, ${box.top + LABEL_GAP}px)`;
        element.style.visibility = "visible";
      }
    };

    let frame = 0;
    const north = new THREE.Vector3();
    const render = () => {
      frame = 0;
      controls.update();
      renderer.render(world, camera);
      placeLabels();
      // The compass needle follows where north (-z) lands on screen, and the N rides
      // just past its tip, kept upright.
      north.set(0, 0, -1).transformDirection(camera.matrixWorldInverse);
      const angle = Math.atan2(north.x, north.y);
      needleRef.current?.setAttribute(
        "transform",
        `rotate(${(angle * 180) / Math.PI})`,
      );
      northLabelRef.current?.setAttribute("x", String(25 * Math.sin(angle)));
      northLabelRef.current?.setAttribute("y", String(-25 * Math.cos(angle)));
    };
    const requestRender = () => {
      if (frame === 0) frame = requestAnimationFrame(render);
    };
    controls.addEventListener("change", requestRender);

    // Fit the scene, as the opening view sees it, into the canvas at zoom 1.
    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      const aspect = width / height;
      const halfHeight = Math.max(extent.y, extent.x / aspect) / FIT;
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.updateProjectionMatrix();
      for (const material of lineMaterials)
        material.resolution.set(width, height);
      requestRender();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    handleRef.current = {
      zoomBy: (factor) => {
        camera.zoom = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, camera.zoom * factor),
        );
        camera.updateProjectionMatrix();
        requestRender();
      },
      reset: () => {
        controls.reset();
        requestRender();
      },
    };

    return () => {
      handleRef.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      for (const item of disposables) item.dispose();
      renderer.dispose();
      // Given back now rather than when collected: a page opening one view after
      // another would otherwise run into the browser's limit on live contexts.
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [scene, webgl]);

  if (webgl === false) {
    return (
      <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
        This view needs WebGL 2, which this browser doesn&apos;t offer.
      </div>
    );
  }

  const legendGradient = `linear-gradient(to bottom, ${SHALLOW_COLOR}, ${DEEP_COLOR})`;
  return (
    <div ref={containerRef} className="absolute inset-0">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {scene.labels.map((label, i) => (
          <span
            key={i}
            ref={(element) => {
              labelRefs.current[i] = element;
            }}
            className={`invisible absolute left-0 top-0 whitespace-nowrap leading-4 ${LABEL_CLASS[label.kind]}`}
          >
            {label.text}
          </span>
        ))}
      </div>
      <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-2 text-xs">
        <span className="w-fit rounded-md bg-background/80 px-2 py-1 font-medium shadow-sm">
          Seafloor: {sourceLabel} (~{Math.round(grid.resolutionMeters)} m)
        </span>
        <div className="flex w-fit gap-2 rounded-md bg-background/80 p-2 shadow-sm">
          <span
            className="h-24 w-3 rounded-sm"
            style={{ background: legendGradient }}
          />
          <div className="flex flex-col justify-between">
            <span>0 m</span>
            <span>{Math.round(scene.maxDepth)} m</span>
          </div>
        </div>
        {scene.hasLand && (
          <div className="flex w-fit items-center gap-2 rounded-md bg-background/80 px-2 py-1 shadow-sm">
            <span
              className="h-3 w-3 rounded-sm"
              style={{ background: LAND_COLOR }}
            />
            Land
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 flex items-end gap-3 text-xs">
        <svg
          viewBox="-30 -30 60 60"
          className="h-14 w-14 text-foreground"
          aria-label="Compass"
        >
          <circle
            r="18"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="1.2"
          />
          <g ref={needleRef}>
            <line
              y2="-14"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <line
              y2="10"
              stroke="currentColor"
              strokeOpacity="0.35"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </g>
          <text
            ref={northLabelRef}
            y="-25"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="9"
            fontWeight="700"
            fill="currentColor"
          >
            N
          </text>
        </svg>
        <span className="rounded-md bg-background/80 px-2 py-1 font-medium shadow-sm">
          Depth {scene.exaggeration.toFixed(1)}×
        </span>
      </div>

      <div className="absolute right-3 top-3 flex flex-col gap-2">
        <IconTooltip label="Zoom in" side="left">
          <Button
            variant="outline"
            size="icon"
            onClick={() => handleRef.current?.zoomBy(ZOOM_STEP)}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </Button>
        </IconTooltip>
        <IconTooltip label="Zoom out" side="left">
          <Button
            variant="outline"
            size="icon"
            onClick={() => handleRef.current?.zoomBy(1 / ZOOM_STEP)}
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </Button>
        </IconTooltip>
        <IconTooltip label="Reset view" side="left">
          <Button
            variant="outline"
            size="icon"
            onClick={() => handleRef.current?.reset()}
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
          </Button>
        </IconTooltip>
      </div>

      <p className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground shadow-sm">
        Drag to rotate · scroll to zoom · right-drag to pan
      </p>
    </div>
  );
}

/**
 * How far the scene's corners, and any extra points, reach from the middle of the
 * screen, sideways and up.
 */
function viewExtent(
  bounds: SceneBounds,
  extra: Point3[],
  camera: THREE.Camera,
): { x: number; y: number } {
  const top = Math.max(bounds.maxY, 0.6);
  const centre = new THREE.Vector3(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + top) / 2,
    (bounds.minZ + bounds.maxZ) / 2,
  ).applyMatrix4(camera.matrixWorldInverse);
  const points: Point3[] = [...extra];
  for (const x of [bounds.minX, bounds.maxX]) {
    for (const y of [bounds.minY, top]) {
      for (const z of [bounds.minZ, bounds.maxZ]) points.push([x, y, z]);
    }
  }
  const corner = new THREE.Vector3();
  let x = 0;
  let y = 0;
  for (const point of points) {
    corner.set(...point).applyMatrix4(camera.matrixWorldInverse);
    x = Math.max(x, Math.abs(corner.x - centre.x));
    y = Math.max(y, Math.abs(corner.y - centre.y));
  }
  return { x, y };
}
