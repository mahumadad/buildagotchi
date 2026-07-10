import * as THREE from 'three';
import { OrbitControls } from 'https://unpkg.com/three@0.164.1/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'https://unpkg.com/three@0.164.1/examples/jsm/geometries/RoundedBoxGeometry.js';
import { STLLoader } from 'https://unpkg.com/three@0.164.1/examples/jsm/loaders/STLLoader.js';

import {
  STACKCHAN_FACE_MM,
  STACKCHAN_FOOT_MM,
  STACKCHAN_SIMULATOR_COLORS,
  STACKCHAN_SHELL_STL,
  computeFaceLayerDepths,
  computeFaceModulePlacement,
  computeFootPlacements,
  computeGeometryTuning,
  computeScreenFrame,
  computeScreenPlane,
  computeShellPlacementFromBounds,
  computeStackchanKinematics,
  createRoundedRectPath,
  stepRotationToward,
} from './geometry.mjs';

const DRIVER_MAX_ANGULAR_SPEED = 2.4;

const LED_COLORS_HEX = {
  amber: 0xf59e0b,
  red: 0xef4444,
  green: 0x22c55e,
  blue: 0x3b82f6,
  white: 0xe5e5e5,
  yellow: 0xeab308,
};

const LED_RADIUS = 1.8;
const LED_HOLE_STL_Y = [15.5, 25.5, 35.5];
const LED_HOLE_STL_Z = 15.25;
const LED_HOLE_STL_X = 27;

export class StackchanScene {
  constructor({ viewport, screen }) {
    this.viewport = viewport;
    this.screen = screen;
    this.driverRotation = { y: 0, p: 0, r: 0 };
    this.targetDriverRotation = { y: 0, p: 0, r: 0 };
    this.lastDriverUpdateMs = undefined;
    this.geometryTuning = computeGeometryTuning();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10141c);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
    this.camera.position.set(42, 28, 155);

    this.renderer = new THREE.WebGLRenderer({ canvas: viewport, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, -6, 0);
    this.controls.minDistance = 80;
    this.controls.maxDistance = 260;
    this.controls.update();

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.panGroup = new THREE.Group();
    this.tiltGroup = new THREE.Group();
    this.headGroup = new THREE.Group();
    this.feetGroup = new THREE.Group();
    this.root.add(this.panGroup);
    this.panGroup.add(this.tiltGroup);
    this.tiltGroup.add(this.headGroup);
    this.root.add(this.feetGroup);

    this.#createLights();
    this.#createBody();
    this.#createFeet();
    this.#createScreen();
    this.#createLeds();
    this.#resize();

    window.addEventListener('resize', () => this.#resize());
  }

  #createLights() {
    this.scene.add(new THREE.HemisphereLight(0xffefe0, 0x223355, 2.6));
    const key = new THREE.DirectionalLight(0xffffff, 3);
    key.position.set(30, 40, 80);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x77bbff, 1.4);
    rim.position.set(-50, 20, -40);
    this.scene.add(rim);
  }

  #createBody() {
    this.shellMaterial = new THREE.MeshStandardMaterial({
      color: STACKCHAN_SIMULATOR_COLORS.shell,
      roughness: 0.54,
      metalness: 0.02,
    });
    this.m5stackSideMaterial = new THREE.MeshStandardMaterial({
      color: STACKCHAN_SIMULATOR_COLORS.m5stackSide,
      roughness: 0.58,
      metalness: 0.02,
    });
    this.m5stackFrontMaterial = new THREE.MeshStandardMaterial({
      color: STACKCHAN_SIMULATOR_COLORS.m5stackFront,
      roughness: 0.62,
      metalness: 0.02,
    });
    this.footMaterial = new THREE.MeshStandardMaterial({
      color: STACKCHAN_SIMULATOR_COLORS.feet,
      roughness: 0.6,
      metalness: 0.02,
    });
    this.#createShell();
    this.#createFaceModule();
  }

  #createShell() {
    const loader = new STLLoader();
    loader.load(
      STACKCHAN_SHELL_STL.url,
      (geometry) => {
        geometry.computeVertexNormals();
        const placement = computeShellPlacementFromBounds(STACKCHAN_SHELL_STL.sourceBoundsMm, {
          tuning: this.geometryTuning,
        });
        this.shell = new THREE.Mesh(geometry, this.shellMaterial);
        this.shell.position.set(placement.position.x, placement.position.y, placement.position.z);
        this.shell.rotation.set(placement.rotation.x, placement.rotation.y, placement.rotation.z);
        this.shell.scale.setScalar(placement.scale);
        this.headGroup.add(this.shell);

        const outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(geometry, 24),
          new THREE.LineBasicMaterial({ color: 0x3d3128, transparent: true, opacity: 0.1 }),
        );
        outline.position.copy(this.shell.position);
        outline.rotation.copy(this.shell.rotation);
        outline.scale.copy(this.shell.scale);
        this.headGroup.add(outline);
      },
      undefined,
      (error) => {
        console.warn('[stackchan-scene] shell STL not loaded, using generated face only', error);
      },
    );
  }

  #createFaceModule() {
    const facePlacement = computeFaceModulePlacement();
    const shape = new THREE.Shape();
    const points = createRoundedRectPath(STACKCHAN_FACE_MM);
    shape.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) shape.lineTo(point.x, point.y);
    shape.closePath();

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: facePlacement.depth,
      bevelEnabled: true,
      bevelSize: 1.4,
      bevelThickness: STACKCHAN_FACE_MM.bevelThickness,
      bevelSegments: 5,
    });
    geometry.center();
    geometry.translate(0, 0, facePlacement.z);

    this.faceModule = new THREE.Mesh(geometry, this.m5stackSideMaterial);
    this.headGroup.add(this.faceModule);

    const layers = computeFaceLayerDepths();
    const frontPanelGeometry = new THREE.ShapeGeometry(shape);
    frontPanelGeometry.translate(0, 0, layers.frontPanelZ);
    this.faceFrontPanel = new THREE.Mesh(frontPanelGeometry, this.m5stackFrontMaterial);
    this.headGroup.add(this.faceFrontPanel);

    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 24),
      new THREE.LineBasicMaterial({ color: 0x3d3128, transparent: true, opacity: 0.18 }),
    );
    this.headGroup.add(outline);
  }

  #createFeet() {
    const geometry = new RoundedBoxGeometry(
      STACKCHAN_FOOT_MM.width,
      STACKCHAN_FOOT_MM.height,
      STACKCHAN_FOOT_MM.depth,
      5,
      STACKCHAN_FOOT_MM.radius,
    );
    const outlineGeometry = new THREE.EdgesGeometry(geometry, 24);

    for (const placement of computeFootPlacements({ tuning: this.geometryTuning })) {
      const foot = new THREE.Mesh(geometry, this.footMaterial);
      foot.position.set(placement.x, placement.y, placement.z);
      this.feetGroup.add(foot);

      const outline = new THREE.LineSegments(
        outlineGeometry,
        new THREE.LineBasicMaterial({ color: 0x3d3128, transparent: true, opacity: 0.16 }),
      );
      outline.position.copy(foot.position);
      this.feetGroup.add(outline);
    }
  }

  #createScreen() {
    this.screenTexture = new THREE.CanvasTexture(this.screen);
    this.screenTexture.colorSpace = THREE.SRGBColorSpace;
    this.screenTexture.minFilter = THREE.LinearFilter;
    this.screenTexture.magFilter = THREE.NearestFilter;

    const plane = computeScreenPlane({ margin: 5 });
    const geometry = new THREE.PlaneGeometry(plane.width, plane.height);
    const material = new THREE.MeshBasicMaterial({ map: this.screenTexture, toneMapped: false });
    this.screenMesh = new THREE.Mesh(geometry, material);
    this.screenMesh.position.set(plane.x, plane.y, plane.z);
    this.headGroup.add(this.screenMesh);

    const framePlacement = computeScreenFrame({ margin: 5, border: 1.2 });
    const frameShape = new THREE.Shape();
    const outerHalfWidth = framePlacement.outer.width / 2;
    const outerHalfHeight = framePlacement.outer.height / 2;
    frameShape.moveTo(-outerHalfWidth, -outerHalfHeight);
    frameShape.lineTo(outerHalfWidth, -outerHalfHeight);
    frameShape.lineTo(outerHalfWidth, outerHalfHeight);
    frameShape.lineTo(-outerHalfWidth, outerHalfHeight);
    frameShape.closePath();

    const screenHole = new THREE.Path();
    const innerHalfWidth = framePlacement.inner.width / 2;
    const innerHalfHeight = framePlacement.inner.height / 2;
    screenHole.moveTo(-innerHalfWidth, -innerHalfHeight);
    screenHole.lineTo(-innerHalfWidth, innerHalfHeight);
    screenHole.lineTo(innerHalfWidth, innerHalfHeight);
    screenHole.lineTo(innerHalfWidth, -innerHalfHeight);
    screenHole.closePath();
    frameShape.holes.push(screenHole);

    const frame = new THREE.Mesh(
      new THREE.ShapeGeometry(frameShape),
      new THREE.MeshBasicMaterial({ color: 0x211a17 }),
    );
    frame.position.set(framePlacement.x, framePlacement.y, framePlacement.z);
    this.headGroup.add(frame);
    this.screenMesh.renderOrder = 1;
  }

  #createLeds() {
    const placement = computeShellPlacementFromBounds(STACKCHAN_SHELL_STL.sourceBoundsMm, {
      tuning: this.geometryTuning,
    });
    const s = placement.scale;
    const ledGeometry = new THREE.SphereGeometry(LED_RADIUS, 12, 8);

    this.leds = { left: [], right: [] };

    for (const [side, stlX] of [['left', -LED_HOLE_STL_X], ['right', LED_HOLE_STL_X]]) {
      for (const stlY of LED_HOLE_STL_Y) {
        const x = stlX * s + placement.position.x;
        const y = LED_HOLE_STL_Z * s + placement.position.y;
        const z = -stlY * s + placement.position.z;
        const material = new THREE.MeshStandardMaterial({
          color: 0x222222,
          emissive: 0x000000,
          emissiveIntensity: 1,
          roughness: 0.3,
          metalness: 0.1,
        });
        const mesh = new THREE.Mesh(ledGeometry, material);
        mesh.position.set(x, y, z);
        this.headGroup.add(mesh);

        const outward = Math.sign(stlX) * 2;
        const light = new THREE.PointLight(0x000000, 0, 20);
        light.position.set(x + outward, y, z);
        this.headGroup.add(light);

        this.leds[side].push({ mesh, light, material });
      }
    }
  }

  applyLeds(leds) {
    for (const side of ['left', 'right']) {
      for (const led of this.leds[side]) {
        led.material.color.setHex(0x222222);
        led.material.emissive.setHex(0x000000);
        led.light.intensity = 0;
      }
    }
    for (const cmd of leds ?? []) {
      const side = this.leds[cmd.row];
      if (!side) continue;
      const idx = typeof cmd.index === 'number' ? cmd.index : 0;
      const led = side[idx];
      if (!led) continue;
      const color = LED_COLORS_HEX[cmd.color] ?? 0xe5e5e5;
      led.material.color.setHex(color);
      led.material.emissive.setHex(color);
      led.light.color.setHex(color);
      led.light.intensity = 4;
    }
  }

  #resize() {
    const { width, height } = this.viewport.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  applyServo({ yaw, pitch }) {
    if (yaw != null) this.targetDriverRotation.y = (yaw * Math.PI) / 180;
    if (pitch != null) this.targetDriverRotation.p = (pitch * Math.PI) / 180;
  }

  render(timeMs) {
    if (this.lastDriverUpdateMs === undefined) {
      this.lastDriverUpdateMs = timeMs;
    }
    const deltaSeconds = Math.max(0, Math.min((timeMs - this.lastDriverUpdateMs) / 1000, 0.1));
    this.lastDriverUpdateMs = timeMs;
    this.driverRotation = stepRotationToward(
      this.driverRotation,
      this.targetDriverRotation,
      deltaSeconds,
      DRIVER_MAX_ANGULAR_SPEED,
    );

    const transforms = computeStackchanKinematics(timeMs, {
      driverRotation: this.driverRotation,
    });

    this.panGroup.position.set(transforms.pan.pivot.x, transforms.pan.pivot.y, transforms.pan.pivot.z);
    this.panGroup.rotation.set(transforms.pan.rotation.x, transforms.pan.rotation.y, transforms.pan.rotation.z);
    this.tiltGroup.position.set(transforms.tilt.pivot.x, transforms.tilt.pivot.y, transforms.tilt.pivot.z);
    this.tiltGroup.rotation.set(transforms.tilt.rotation.x, transforms.tilt.rotation.y, transforms.tilt.rotation.z);
    this.headGroup.rotation.set(transforms.head.rotation.x, transforms.head.rotation.y, transforms.head.rotation.z);
    this.headGroup.scale.set(transforms.head.scale.x, transforms.head.scale.y, transforms.head.scale.z);
    this.feetGroup.rotation.set(transforms.feet.rotation.x, transforms.feet.rotation.y, transforms.feet.rotation.z);
    this.feetGroup.scale.set(transforms.feet.scale.x, transforms.feet.scale.y, transforms.feet.scale.z);

    this.screenTexture.needsUpdate = true;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
