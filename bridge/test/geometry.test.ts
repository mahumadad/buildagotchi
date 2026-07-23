import { describe, expect, it } from 'vitest';
import {
  STACKCHAN_FACE_MM,
  STACKCHAN_FOOT_MM,
  M5STACK_CORE_MM,
  STACKCHAN_SHELL_STL,
  SCREEN_CANVAS,
  computeGeometryTuning,
  createRoundedRectPath,
  computeFaceLayerDepths,
  computeScreenPlane,
  computeScreenFrame,
  computeFaceModulePlacement,
  computeShellScaleForM5Stack,
  computeShellPlacementFromBounds,
  screenPointFromUv,
  computeFootPlacements,
  nextLookAroundPose,
  nextSpeechScale,
  stepRotationToward,
  computeStackchanKinematics,
} from '../src/server/public/geometry.mjs';

describe('computeGeometryTuning', () => {
  it('applies defaults when called with no arguments', () => {
    const tuning = computeGeometryTuning();
    expect(tuning).toEqual({
      shellOffset: { x: 0, y: 0, z: -10 },
      feetOffset: { x: 0, y: -4, z: 0 },
    });
  });

  it('clamps shellGap to [0, 12]', () => {
    expect(computeGeometryTuning({ shellGap: 100 }).shellOffset.z).toBe(-12);
    expect(computeGeometryTuning({ shellGap: -100 }).shellOffset.z).toBeCloseTo(0);
  });

  it('clamps footHeight to [-4, 4]', () => {
    expect(computeGeometryTuning({ footHeight: 100 }).feetOffset.y).toBe(4);
    expect(computeGeometryTuning({ footHeight: -100 }).feetOffset.y).toBe(-4);
  });

  it('clamps footForward to [-8, 8]', () => {
    expect(computeGeometryTuning({ footForward: 100 }).feetOffset.z).toBe(8);
    expect(computeGeometryTuning({ footForward: -100 }).feetOffset.z).toBe(-8);
  });

  it('falls back to defaults for non-finite inputs', () => {
    const tuning = computeGeometryTuning({ shellGap: 'nope', footHeight: NaN, footForward: undefined } as any);
    expect(tuning.shellOffset.z).toBe(-10);
    expect(tuning.feetOffset.y).toBe(-4);
    expect(tuning.feetOffset.z).toBe(0);
  });

  it('parses numeric strings', () => {
    const tuning = computeGeometryTuning({ shellGap: '5', footHeight: '2', footForward: '3' } as any);
    expect(tuning.shellOffset.z).toBe(-5);
    expect(tuning.feetOffset.y).toBe(2);
    expect(tuning.feetOffset.z).toBe(3);
  });
});

describe('createRoundedRectPath', () => {
  it('generates a closed-ish path with (segments + 1) points per corner', () => {
    const path = createRoundedRectPath({ width: 10, height: 10, radius: 2, segments: 4 } as any);
    expect(path).toHaveLength(4 * (4 + 1));
  });

  it('uses default STACKCHAN_FACE_MM when called with no arguments', () => {
    const path = createRoundedRectPath();
    expect(path.length).toBeGreaterThan(0);
    const hw = STACKCHAN_FACE_MM.width / 2;
    for (const point of path) {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(hw + 1e-9);
    }
  });

  it('clamps radius to half of the smaller dimension', () => {
    const unclamped = createRoundedRectPath({ width: 10, height: 4, radius: 100, segments: 4 } as any);
    const clamped = createRoundedRectPath({ width: 10, height: 4, radius: 2, segments: 4 } as any);
    expect(unclamped).toEqual(clamped);
  });

  it('produces a rectangle with sharp corners when radius is 0', () => {
    const path = createRoundedRectPath({ width: 10, height: 6, radius: 0, segments: 1 } as any);
    // Every point at radius 0 collapses onto the corner itself.
    const xs = path.map((p) => p.x);
    const ys = path.map((p) => p.y);
    expect(Math.max(...xs)).toBeCloseTo(5);
    expect(Math.max(...ys)).toBeCloseTo(3);
  });

  it('throws for non-positive width or height', () => {
    expect(() => createRoundedRectPath({ width: 0, height: 10, radius: 1 } as any)).toThrow(RangeError);
    expect(() => createRoundedRectPath({ width: 10, height: -1, radius: 1 } as any)).toThrow(RangeError);
  });

  it('throws for negative radius', () => {
    expect(() => createRoundedRectPath({ width: 10, height: 10, radius: -1 } as any)).toThrow(RangeError);
  });
});

describe('computeFaceLayerDepths', () => {
  it('stacks layers strictly forward of the face in order', () => {
    const depths = computeFaceLayerDepths();
    expect(depths.beveledFaceFrontZ).toBeLessThan(depths.frontPanelZ);
    expect(depths.frontPanelZ).toBeLessThan(depths.screenFrameZ);
    expect(depths.screenFrameZ).toBeLessThan(depths.screenZ);
  });

  it('adds bevelThickness on top of facePlacement.frontZ', () => {
    const depths = computeFaceLayerDepths({ facePlacement: { frontZ: 0 } as any, frontPanelClearance: 0, screenFrameClearance: 0, screenClearance: 0 });
    expect(depths.beveledFaceFrontZ).toBeCloseTo(STACKCHAN_FACE_MM.bevelThickness);
    expect(depths.frontPanelZ).toBeCloseTo(STACKCHAN_FACE_MM.bevelThickness);
    expect(depths.screenFrameZ).toBeCloseTo(STACKCHAN_FACE_MM.bevelThickness);
    expect(depths.screenZ).toBeCloseTo(STACKCHAN_FACE_MM.bevelThickness);
  });

  it('respects zero clearances (identity offsets)', () => {
    const depths = computeFaceLayerDepths({ facePlacement: { frontZ: 5 } as any, frontPanelClearance: 0, screenFrameClearance: 0, screenClearance: 0 });
    expect(depths.frontPanelZ).toBe(depths.beveledFaceFrontZ);
    expect(depths.screenFrameZ).toBe(depths.frontPanelZ);
    expect(depths.screenZ).toBe(depths.screenFrameZ);
  });
});

describe('computeScreenPlane', () => {
  it('fits the screen aspect ratio within the available face area', () => {
    const plane = computeScreenPlane();
    expect(plane.width / plane.height).toBeCloseTo(SCREEN_CANVAS.aspectRatio);
  });

  it('is centered at x=0, y=0', () => {
    const plane = computeScreenPlane();
    expect(plane.x).toBe(0);
    expect(plane.y).toBe(0);
  });

  it('shrinks to fit when the face is much taller than wide (constrained by width)', () => {
    const plane = computeScreenPlane({ faceWidth: 40, faceHeight: 200, margin: 5 } as any);
    const availableWidth = 40 - 10;
    expect(plane.width).toBeCloseTo(availableWidth);
    expect(plane.height).toBeLessThanOrEqual(200 - 10);
  });

  it('shrinks to fit when the face is much wider than tall (constrained by height)', () => {
    const plane = computeScreenPlane({ faceWidth: 200, faceHeight: 40, margin: 5 } as any);
    const availableHeight = 40 - 10;
    expect(plane.height).toBeCloseTo(availableHeight);
    expect(plane.width).toBeLessThanOrEqual(200 - 10);
  });

  it('never exceeds the available face area in either dimension', () => {
    const plane = computeScreenPlane({ faceWidth: 54, faceHeight: 54, margin: 5 });
    expect(plane.width).toBeLessThanOrEqual(44 + 1e-9);
    expect(plane.height).toBeLessThanOrEqual(44 + 1e-9);
  });
});

describe('computeScreenFrame', () => {
  it('outer bounds equal inner bounds plus 2x border', () => {
    const frame = computeScreenFrame({ border: 1.2 });
    expect(frame.outer.width).toBeCloseTo(frame.inner.width + 2.4);
    expect(frame.outer.height).toBeCloseTo(frame.inner.height + 2.4);
  });

  it('collapses to the inner size when border is 0', () => {
    const frame = computeScreenFrame({ border: 0 });
    expect(frame.outer.width).toBeCloseTo(frame.inner.width);
    expect(frame.outer.height).toBeCloseTo(frame.inner.height);
  });

  it('sits one layer in front of the screen plane', () => {
    const frame = computeScreenFrame();
    const plane = computeScreenPlane();
    expect(frame.z).toBeLessThan(plane.z);
  });
});

describe('computeFaceModulePlacement', () => {
  it('uses defaults to produce a placement forward of the shell face', () => {
    const placement = computeFaceModulePlacement();
    expect(placement.frontZ).toBeGreaterThan(placement.shellFrontZ);
    expect(placement.frontZ - placement.shellFrontZ).toBeCloseTo(M5STACK_CORE_MM.shellSeamOverlap);
  });

  it('centers z at frontZ - depth / 2', () => {
    const placement = computeFaceModulePlacement({
      depth: 16,
      shellSeamOverlap: 0,
      shellBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 10, z: 0 } },
      shellScale: 1,
    } as any);
    expect(placement.shellFrontZ).toBeCloseTo(5);
    expect(placement.frontZ).toBeCloseTo(5);
    expect(placement.z).toBeCloseTo(5 - 8);
  });

  it('scales shellFrontZ with shellScale', () => {
    const bounds = { min: { x: 0, y: -10, z: 0 }, max: { x: 0, y: 10, z: 0 } };
    const p1 = computeFaceModulePlacement({ shellBounds: bounds, shellScale: 1, shellSeamOverlap: 0, depth: 0 } as any);
    const p2 = computeFaceModulePlacement({ shellBounds: bounds, shellScale: 2, shellSeamOverlap: 0, depth: 0 } as any);
    expect(p2.shellFrontZ).toBeCloseTo(p1.shellFrontZ * 2);
  });
});

describe('computeShellScaleForM5Stack', () => {
  it('uses defaults matching M5Stack width / shell opening width', () => {
    expect(computeShellScaleForM5Stack()).toBeCloseTo(M5STACK_CORE_MM.width / STACKCHAN_SHELL_STL.frontOpeningWidthMm);
  });

  it('returns 1 when opening width equals m5stack width', () => {
    expect(computeShellScaleForM5Stack({ openingWidth: 30, m5stackWidth: 30 } as any)).toBe(1);
  });

  it('scales inversely with opening width', () => {
    expect(computeShellScaleForM5Stack({ openingWidth: 10, m5stackWidth: 20 } as any)).toBe(2);
    expect(computeShellScaleForM5Stack({ openingWidth: 20, m5stackWidth: 10 } as any)).toBe(0.5);
  });
});

describe('computeShellPlacementFromBounds', () => {
  const symmetricBounds = { min: { x: -10, y: -10, z: -10 }, max: { x: 10, y: 10, z: 10 } };

  it('centers a symmetric bounding box at the origin with identity rotation and scale 1', () => {
    const placement = computeShellPlacementFromBounds(symmetricBounds, {
      scale: 1,
      rotationOffset: { x: 0, y: 0, z: 0 },
      tuning: { shellOffset: { x: 0, y: 0, z: 0 }, feetOffset: { x: 0, y: 0, z: 0 } },
    });
    expect(placement.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(placement.rotation).toEqual({ x: 0, y: 0, z: 0 });
    expect(placement.frontZ).toBeCloseTo(10);
  });

  it('offsets position for an off-center bounding box', () => {
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
    const placement = computeShellPlacementFromBounds(bounds, {
      scale: 1,
      rotationOffset: { x: 0, y: 0, z: 0 },
      tuning: { shellOffset: { x: 0, y: 0, z: 0 }, feetOffset: { x: 0, y: 0, z: 0 } },
    });
    // Center is (5,5,5); position should negate it so the shell centers at origin.
    expect(placement.position).toEqual({ x: -5, y: -5, z: -5 });
  });

  it('applies tuning shellOffset on top of the centering offset', () => {
    const placement = computeShellPlacementFromBounds(symmetricBounds, {
      scale: 1,
      rotationOffset: { x: 0, y: 0, z: 0 },
      tuning: { shellOffset: { x: 1, y: 2, z: 3 }, feetOffset: { x: 0, y: 0, z: 0 } },
    });
    expect(placement.position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('applies a 90-degree rotation around x to swap y/z of the center', () => {
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 20 } };
    const placement = computeShellPlacementFromBounds(bounds, {
      scale: 1,
      rotationOffset: { x: -Math.PI / 2, y: 0, z: 0 },
      tuning: { shellOffset: { x: 0, y: 0, z: 0 }, feetOffset: { x: 0, y: 0, z: 0 } },
    });
    // Center (0,0,10) rotated -90deg about x: y' = y*cos-z*sin, z' = y*sin+z*cos
    // cos(-90)=0, sin(-90)=-1 -> y' = 0*0 - 10*(-1) = 10, z' = 0*(-1)+10*0 = 0
    expect(placement.position.x).toBeCloseTo(0);
    expect(placement.position.y).toBeCloseTo(-10);
    expect(placement.position.z).toBeCloseTo(0);
  });

  it('scales the depth-derived frontZ with the scale factor', () => {
    const bounds = { min: { x: 0, y: -5, z: 0 }, max: { x: 0, y: 5, z: 0 } };
    const placement = computeShellPlacementFromBounds(bounds, {
      scale: 3,
      rotationOffset: { x: 0, y: 0, z: 0 },
      tuning: { shellOffset: { x: 0, y: 0, z: 0 }, feetOffset: { x: 0, y: 0, z: 0 } },
    });
    expect(placement.frontZ).toBeCloseTo((10 * 3) / 2);
  });

  it('normalizes negative zero to positive zero in position and frontZ', () => {
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    const placement = computeShellPlacementFromBounds(bounds, {
      scale: 1,
      rotationOffset: { x: 0, y: 0, z: 0 },
      tuning: { shellOffset: { x: 0, y: 0, z: 0 }, feetOffset: { x: 0, y: 0, z: 0 } },
    });
    expect(Object.is(placement.position.x, -0)).toBe(false);
    expect(Object.is(placement.position.y, -0)).toBe(false);
    expect(Object.is(placement.position.z, -0)).toBe(false);
    expect(Object.is(placement.frontZ, -0)).toBe(false);
  });

  it('always marks keepGeneratedFace as true', () => {
    const placement = computeShellPlacementFromBounds(symmetricBounds);
    expect(placement.keepGeneratedFace).toBe(true);
  });
});

describe('screenPointFromUv', () => {
  it('returns undefined for a nullish uv', () => {
    expect(screenPointFromUv(undefined)).toBeUndefined();
    expect(screenPointFromUv(null)).toBeUndefined();
  });

  it('maps uv (0,0) to top-left (0, height)', () => {
    expect(screenPointFromUv({ x: 0, y: 0 })).toEqual({ x: 0, y: SCREEN_CANVAS.height });
  });

  it('maps uv (1,1) to bottom-right (width, 0)', () => {
    expect(screenPointFromUv({ x: 1, y: 1 })).toEqual({ x: SCREEN_CANVAS.width, y: 0 });
  });

  it('maps uv (0.5, 0.5) to the center, flipping the y axis', () => {
    const point = screenPointFromUv({ x: 0.5, y: 0.5 });
    expect(point).toEqual({ x: SCREEN_CANVAS.width / 2, y: SCREEN_CANVAS.height / 2 });
  });

  it('respects a custom canvas size', () => {
    expect(screenPointFromUv({ x: 1, y: 0 }, { width: 100, height: 50 } as any)).toEqual({ x: 100, y: 50 });
  });
});

describe('computeFootPlacements', () => {
  it('returns exactly two feet, symmetric around x=0', () => {
    const feet = computeFootPlacements({ tuning: { shellOffset: { x: 0, y: 0, z: 0 }, feetOffset: { x: 0, y: 0, z: 0 } } });
    expect(feet).toHaveLength(2);
    expect(feet[0]!.x).toBeCloseTo(-feet[1]!.x);
  });

  it('spaces feet by width + gap', () => {
    const feet = computeFootPlacements({
      foot: { ...STACKCHAN_FOOT_MM, width: 24 },
      gap: 2,
      tuning: { shellOffset: { x: 0, y: 0, z: 0 }, feetOffset: { x: 0, y: 0, z: 0 } },
    });
    expect(feet[1]!.x - feet[0]!.x).toBeCloseTo(24 + 2);
  });

  it('applies feetOffset.x/y/z on top of computed placement', () => {
    const base = computeFootPlacements({ tuning: { shellOffset: { x: 0, y: 0, z: 0 }, feetOffset: { x: 0, y: 0, z: 0 } } });
    const offset = computeFootPlacements({ tuning: { shellOffset: { x: 0, y: 0, z: 0 }, feetOffset: { x: 5, y: 1, z: 2 } } });
    expect(offset[0]!.x).toBeCloseTo(base[0]!.x + 5);
    expect(offset[0]!.y).toBeCloseTo(base[0]!.y + 1);
    expect(offset[0]!.z).toBeCloseTo(base[0]!.z + 2);
  });
});

describe('nextLookAroundPose', () => {
  it('returns a neutral pose when disabled', () => {
    expect(nextLookAroundPose(12345, { enabled: false })).toEqual({ yaw: 0, pitch: 0, roll: 0 });
  });

  it('returns a neutral pose at time 0 when enabled (all sin terms are 0)', () => {
    const pose = nextLookAroundPose(0, { enabled: true });
    expect(pose.yaw).toBeCloseTo(0);
    expect(pose.pitch).toBeCloseTo(Math.sin(1.4) * 0.08);
    expect(pose.roll).toBeCloseTo(Math.sin(0.7) * 0.025);
  });

  it('produces bounded yaw/pitch/roll values', () => {
    for (let t = 0; t < 20000; t += 137) {
      const pose = nextLookAroundPose(t, { enabled: true });
      expect(Math.abs(pose.yaw)).toBeLessThanOrEqual(0.18 + 0.08 + 1e-9);
      expect(Math.abs(pose.pitch)).toBeLessThanOrEqual(0.08 + 1e-9);
      expect(Math.abs(pose.roll)).toBeLessThanOrEqual(0.025 + 1e-9);
    }
  });
});

describe('nextSpeechScale', () => {
  it('returns exactly 1 when not speaking', () => {
    expect(nextSpeechScale(999, { speaking: false })).toBe(1);
    expect(nextSpeechScale(0)).toBe(1);
  });

  it('returns 1 at time 0 while speaking (sin(0) = 0)', () => {
    expect(nextSpeechScale(0, { speaking: true })).toBe(1);
  });

  it('stays within [1, 1.045] while speaking', () => {
    for (let t = 0; t < 2000; t += 13) {
      const scale = nextSpeechScale(t, { speaking: true });
      expect(scale).toBeGreaterThanOrEqual(1);
      expect(scale).toBeLessThanOrEqual(1.045 + 1e-9);
    }
  });
});

describe('stepRotationToward', () => {
  it('snaps directly to target when within maxStep', () => {
    const result = stepRotationToward({ y: 0, p: 0, r: 0 }, { y: 0.01, p: -0.01, r: 0 }, 1, 1);
    expect(result).toEqual({ y: 0.01, p: -0.01, r: 0 });
  });

  it('clamps movement to maxAngularSpeed * deltaSeconds when target is far away', () => {
    const result = stepRotationToward({ y: 0, p: 0, r: 0 }, { y: 10, p: -10, r: 0 }, 1, 2);
    expect(result).toEqual({ y: 2, p: -2, r: 0 });
  });

  it('does not move past target even with a huge deltaSeconds', () => {
    const result = stepRotationToward({ y: 0, p: 0, r: 0 }, { y: 1, p: 1, r: 1 }, 1000, 1000);
    expect(result).toEqual({ y: 1, p: 1, r: 1 });
  });

  it('treats missing target axes as "hold current value"', () => {
    const result = stepRotationToward({ y: 1, p: 2, r: 3 }, {}, 1, 10);
    expect(result).toEqual({ y: 1, p: 2, r: 3 });
  });

  it('treats missing current axes as 0', () => {
    const result = stepRotationToward({}, { y: 5, p: 5, r: 5 }, 1, 1);
    expect(result).toEqual({ y: 1, p: 1, r: 1 });
  });

  it('produces zero movement when deltaSeconds is 0', () => {
    const result = stepRotationToward({ y: 0, p: 0, r: 0 }, { y: 1, p: 1, r: 1 }, 0, 100);
    expect(result).toEqual({ y: 0, p: 0, r: 0 });
  });

  it('clamps a negative deltaSeconds to a maxStep of 0 (no backward motion)', () => {
    const result = stepRotationToward({ y: 0, p: 0, r: 0 }, { y: 1, p: 1, r: 1 }, -5, 100);
    expect(result).toEqual({ y: 0, p: 0, r: 0 });
  });
});

describe('computeStackchanKinematics', () => {
  it('returns a fully static pose at time 0 with all features disabled', () => {
    const kinematics = computeStackchanKinematics(0, { lookAround: false, speaking: false, motionUntil: 0 });
    expect(kinematics.pan.rotation).toEqual({ x: 0, y: 0, z: 0 });
    expect(kinematics.tilt.rotation).toEqual({ x: 0, y: 0, z: 0 });
    expect(kinematics.head.scale).toEqual({ x: 1, y: 1, z: 1 });
    expect(kinematics.feet.rotation).toEqual({ x: 0, y: 0, z: 0 });
    expect(kinematics.feet.scale).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('folds driverRotation directly into pan/tilt/head rotations', () => {
    const kinematics = computeStackchanKinematics(0, {
      driverRotation: { y: 0.5, p: 0.3, r: 0.2 },
    });
    expect(kinematics.pan.rotation.y).toBeCloseTo(0.5);
    expect(kinematics.tilt.rotation.x).toBeCloseTo(0.3);
    expect(kinematics.head.rotation.z).toBeCloseTo(0.2);
  });

  it('applies servo yaw only while inServoMotion (timeMs < motionUntil)', () => {
    const during = computeStackchanKinematics(100, { motionUntil: 5000 });
    const after = computeStackchanKinematics(5000, { motionUntil: 5000 });
    // At servoT close to 1 (near start of the window), servoYaw need not be 0.
    expect(during.pan.rotation.y).not.toBe(0);
    expect(after.pan.rotation.y).toBe(0);
  });

  it('scales the head with speaking-derived speechScale', () => {
    const kinematics = computeStackchanKinematics(50, { speaking: true });
    expect(kinematics.head.scale.y).toBeGreaterThanOrEqual(1);
    expect(kinematics.head.scale.y).toBeLessThanOrEqual(1.045 + 1e-9);
  });

  it('keeps feet fixed regardless of pose/motion inputs', () => {
    const kinematics = computeStackchanKinematics(1234, { lookAround: true, speaking: true, motionUntil: 5000 });
    expect(kinematics.feet.rotation).toEqual({ x: 0, y: 0, z: 0 });
  });
});
