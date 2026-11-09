/**
 * The hex view's camera, as in a city-building game (Manor Lords and the like): it looks at a
 * point on the ground from a distance, turned and tilted.
 *
 *   right-drag (or left-drag) pans: the ground under the pointer stays under it
 *   middle-drag (or Ctrl/Alt + drag) turns round the point; up and down tilts
 *   wheel zooms toward the pointer, the view flattening toward the horizon as it comes in
 *   W A S D pans, Q E turns, R F zooms; touch: one finger pans; two fingers pinch to zoom
 *   (about the point between them) and drag the map along, turning only once clearly twisted;
 *   two fingers moving up or down together tilt
 *
 * Every input moves a target and the camera eases toward it at a rate that doesn't depend on the
 * frame rate, so motion stays smooth however the input arrives (a wheel's steps, a mouse at
 * 125 Hz). A drag let go carries on a little and slows. The point looked at stays on the hex,
 * zoom is limited both ways, and the camera never goes into the ground.
 *
 * It keeps OrbitControls' surface (target, update(), enabled) so hex.ts changed little: set
 * camera.position and target, then call snap() to jump there.
 */
import * as THREE from 'three';

export interface CameraFeel {
  /** How quickly the camera catches up with its target, per second (higher: tighter). */
  follow: number;
  /** How far a drag carries on once let go (0: stops dead, 1: a long glide). */
  glide: number;
  /** How much the view flattens toward the horizon as you zoom in (0: not at all). */
  flatten: number;
}
export const FEEL: Record<string, CameraFeel> = {
  silky: { follow: 9, glide: 0.5, flatten: 1 },
  snappy: { follow: 18, glide: 0.25, flatten: 1 },
  floaty: { follow: 5, glide: 0.85, flatten: 1 },
  flat: { follow: 9, glide: 0.5, flatten: 0 },
};

const TAU = Math.PI * 2;
/** Fraction of the way to the target this frame, for a rate k per second. */
const ease = (k: number, dt: number) => 1 - Math.exp(-k * dt);

export class HexCamera {
  /** The point looked at (as drawn: eased). Setting it, then snap(), jumps there. */
  readonly target = new THREE.Vector3();
  enabled = true;
  /** Right-drag turns (and tilts, up tilting toward the horizon) instead of panning: Primundi's
   * mouse (Bill, 2026-11-09), where left-drag pans and a left click walks. */
  rightTurns = false;
  feel: CameraFeel = FEEL.silky;
  /** Closest and farthest the camera may be from the point, metres. */
  minDistance = 6;
  maxDistance = 2000;
  /** How far from the centre the point looked at may go (the hex's half-width, roughly). */
  bound = 1000;
  /** Height of the ground at (x, z) in three's frame (z is south). */
  ground: (x: number, z: number) => number = () => 0;

  // What the inputs ask for; the camera eases toward these.
  private goal = new THREE.Vector3();
  private yawGoal = 0;
  private distGoal = 100;
  /** Tilt the user has added (radians, + toward the horizon) on top of the zoom's own tilt. */
  private tiltGoal = 0;
  // As drawn.
  private yaw = 0;
  private dist = 100;
  private tilt = 0;
  private groundY = 0;
  // Drag carry-on: target velocity (metres/s, rad/s) measured over the last moves.
  private vel = new THREE.Vector3();
  private yawVel = 0;
  private keys = new Set<string>();
  private drag: null | { mode: 'pan' | 'turn'; id: number; x: number; y: number; grab: THREE.Vector3 | null; t: number } = null;
  private touches = new Map<number, { x: number; y: number }>();
  /** Two fingers: where they started, and what they've been read as. A gesture is classified once
   * the fingers have moved a little: 'tilt' (both sliding up or down together) or 'pinch' (zoom
   * and pan, plus a twist once it passes a dead zone). */
  private pinch: null | { d: number; a: number; mx: number; my: number; mx0: number; my0: number; dist: number; yaw: number;
    mode: 'undecided' | 'pinch' | 'tilt'; twist: boolean; grab: THREE.Vector3 | null; ys: [number, number]; t: number } = null;
  private ray = new THREE.Raycaster();
  /** A camera at the goal pose, for working out what is under the pointer without lag. */
  private ghost = new THREE.PerspectiveCamera();

  private camera: THREE.PerspectiveCamera;
  private dom: HTMLElement;
  /** Set by snap(): a pose set from code (screenshots, the planet's matching view) stands as
   * given, outside the limits, until the user moves. */
  private free = false;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera; this.dom = dom;
    dom.addEventListener('pointerdown', this.down);
    addEventListener('pointermove', this.move);
    addEventListener('pointerup', this.up);
    addEventListener('pointercancel', this.up);
    dom.addEventListener('wheel', this.wheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.style.touchAction = 'none';
    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || e.ctrlKey || e.metaKey) return;
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  /** The tilt from straight down for a distance: steep far out, flatter close in (radians). */
  private baseTilt(dist: number) {
    const far = 0.6, near = 1.32;   // ~34° and ~76° from straight down
    const t = Math.log(dist / this.minDistance) / Math.log(this.maxDistance / this.minDistance);
    const k = Math.min(1, Math.max(0, t));
    const flat = far + (near - far) * (1 - k) ** 1.6;
    return far + (flat - far) * this.feel.flatten;
  }
  private polar(dist: number, tilt: number) {
    return Math.min(1.45, Math.max(0.05, this.baseTilt(dist) + tilt));
  }

  /** Jump to the camera's current position and target (set them, then call this). */
  snap() {
    const off = this.camera.position.clone().sub(this.target);
    const d = Math.max(1e-3, off.length());
    this.dist = this.distGoal = d;
    this.free = true;
    this.yaw = this.yawGoal = Math.atan2(off.x, off.z);
    const polar = Math.acos(THREE.MathUtils.clamp(off.y / d, -1, 1));
    this.tilt = this.tiltGoal = polar - this.baseTilt(this.dist);
    this.goal.copy(this.target);
    this.groundY = this.target.y;
    this.vel.set(0, 0, 0); this.yawVel = 0;
    this.place(this.camera, this.target, this.yaw, this.dist, this.tilt);
  }

  /** Put a camera at a pose: the point, turned yaw (0: looking north), dist away, tilt added. */
  private place(cam: THREE.PerspectiveCamera, at: THREE.Vector3, yaw: number, dist: number, tilt: number) {
    const p = this.polar(dist, tilt);
    cam.position.set(at.x + Math.sin(p) * Math.sin(yaw) * dist, at.y + Math.cos(p) * dist, at.z + Math.sin(p) * Math.cos(yaw) * dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(at);
  }

  /** The ground under a screen point (as seen from the goal pose): marches the ray over the
   * height field. Falls back to the plane at the point's height when it misses. */
  pick(cx: number, cy: number, fromGoal = true, onPlane?: number): THREE.Vector3 | null {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const cam = fromGoal ? this.ghostAt() : this.camera;
    this.ray.setFromCamera(ndc, cam);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    if (onPlane !== undefined) {
      if (Math.abs(d.y) < 1e-4) return null;
      const t = (onPlane - o.y) / d.y;
      return t > 0 ? o.clone().addScaledVector(d, t) : null;
    }
    // March: steps grow with distance; then halve back to the crossing.
    const far = this.maxDistance * 4;
    let t0 = 0, t = Math.max(0.5, this.dist * 0.01);
    const p = new THREE.Vector3();
    for (let i = 0; i < 400 && t < far; i++) {
      p.copy(o).addScaledVector(d, t);
      if (p.y < this.ground(p.x, p.z)) {
        let a = t0, b = t;
        for (let k = 0; k < 20; k++) {
          const m = (a + b) / 2;
          p.copy(o).addScaledVector(d, m);
          if (p.y < this.ground(p.x, p.z)) b = m; else a = m;
        }
        return p.copy(o).addScaledVector(d, (a + b) / 2).clone();
      }
      t0 = t; t += Math.max(0.5, t * 0.02);
    }
    return this.pick(cx, cy, fromGoal, this.groundY);
  }
  private ghostAt() {
    const g = this.ghost;
    g.fov = this.camera.fov; g.aspect = this.camera.aspect; g.near = this.camera.near; g.far = this.camera.far;
    g.updateProjectionMatrix();
    const at = this.goal.clone(); at.y = this.groundY;
    this.place(g, at, this.yawGoal, this.distGoal, this.tiltGoal);
    g.updateMatrixWorld();
    return g;
  }

  private clampGoal() {
    if (this.free) return;
    // The point may roam the hex up close; zooming out draws it back to the middle, so all the
    // way out the hex sits centred rather than off to one side.
    const out = THREE.MathUtils.smoothstep(this.distGoal, this.maxDistance * 0.35, this.maxDistance);
    const bound = this.bound * (1 - 0.9 * out);
    const r = Math.hypot(this.goal.x, this.goal.z);
    if (r > bound) { this.goal.x *= bound / r; this.goal.z *= bound / r; }
    this.distGoal = THREE.MathUtils.clamp(this.distGoal, this.minDistance, this.maxDistance);
    // Tilt: the total stays between near straight down and just above the horizon.
    const b = this.baseTilt(this.distGoal);
    this.tiltGoal = THREE.MathUtils.clamp(this.tiltGoal, 0.05 - b, 1.45 - b);
  }

  // --- Mouse and touch ---
  private down = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.touched = performance.now();
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dom.setPointerCapture(e.pointerId);
      this.free = false;
      this.startTouch();
      return;
    }
    const turn = e.button === 1 || (this.rightTurns && e.button === 2) || ((e.button === 0 || e.button === 2) && (e.ctrlKey || e.altKey));
    const pan = !turn && (e.button === 0 || e.button === 2);
    if (!turn && !pan) return;
    e.preventDefault();
    this.free = false;
    this.dom.setPointerCapture(e.pointerId);
    this.vel.set(0, 0, 0); this.yawVel = 0;
    this.drag = { mode: turn ? 'turn' : 'pan', id: e.pointerId, x: e.clientX, y: e.clientY, grab: pan ? this.pick(e.clientX, e.clientY) : null, t: performance.now() };
  };
  private move = (e: PointerEvent) => {
    if (!this.enabled) return;
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.moveTouch();
      return;
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const now = performance.now(), dt = Math.max(1, now - d.t) / 1000;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (d.mode === 'turn') {
      const dyaw = -dx * 0.006;
      this.yawGoal += dyaw;
      this.tiltGoal += (this.rightTurns ? -dy : dy) * 0.004;
      this.yawVel = THREE.MathUtils.lerp(this.yawVel, dyaw / dt, 0.5);
    } else if (d.grab) this.panTo(d.grab, e.clientX, e.clientY, dt);
    d.x = e.clientX; d.y = e.clientY; d.t = now;
    this.clampGoal();
  };
  /** Move the goal so the grabbed ground point sits under the pointer again. */
  private panTo(grab: THREE.Vector3, cx: number, cy: number, dt: number) {
    const p = this.pick(cx, cy, true, grab.y);
    if (!p) return;
    const shift = grab.clone().sub(p); shift.y = 0;
    // A ray near the horizon reaches miles away: cap a single step.
    const cap = this.distGoal * 0.5;
    if (shift.length() > cap) shift.setLength(cap);
    this.goal.add(shift);
    this.vel.lerp(shift.clone().divideScalar(dt), 0.5);
  }
  private up = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      if (!this.touches.has(e.pointerId)) return;
      // A finger lifted while still: no fling.
      const last = this.drag?.t ?? this.pinch?.t ?? 0;
      if (performance.now() - last > 80 || this.touches.size > 1) { this.vel.set(0, 0, 0); this.yawVel = 0; }
      this.touches.delete(e.pointerId);
      this.startTouch(true);
      return;
    }
    if (this.drag?.id !== e.pointerId) return;
    // Only carry on if the pointer was still moving when let go.
    if (performance.now() - this.drag.t > 80) { this.vel.set(0, 0, 0); this.yawVel = 0; }
    this.drag = null;
  };
  private startTouch(lifted = false) {
    const t = [...this.touches.values()];
    this.drag = null; this.pinch = null;
    if (t.length === 1) {
      this.drag = { mode: 'pan', id: [...this.touches.keys()][0], x: t[0].x, y: t[0].y, grab: this.pick(t[0].x, t[0].y), t: performance.now() };
      if (lifted) this.vel.set(0, 0, 0);
    } else if (t.length >= 2) {
      const [a, b] = t, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.vel.set(0, 0, 0); this.yawVel = 0;
      this.pinch = { d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x), mx, my, mx0: mx, my0: my, dist: this.distGoal, yaw: this.yawGoal,
        mode: 'undecided', twist: false, grab: this.pick(mx, my), ys: [a.y, b.y], t: performance.now() };
    }
  }
  private moveTouch() {
    const t = [...this.touches.values()];
    const now = performance.now();
    if (t.length === 1 && this.drag?.grab) {
      this.panTo(this.drag.grab, t[0].x, t[0].y, Math.max(1, now - this.drag.t) / 1000);
      this.drag.t = now;
    } else if (t.length >= 2 && this.pinch) {
      const [a, b] = t, p = this.pinch;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      let dAng = Math.atan2(b.y - a.y, b.x - a.x) - p.a;
      dAng = Math.atan2(Math.sin(dAng), Math.cos(dAng));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (p.mode === 'undecided') {
        // Decide what this is once the fingers have moved ~12 px. Tilt: both fingers going the same
        // way up or down, the gap and the angle between them barely changing.
        const dyA = a.y - p.ys[0], dyB = b.y - p.ys[1];
        const moved = Math.max(Math.abs(dyA), Math.abs(dyB), Math.abs(d - p.d), Math.hypot(mx - p.mx0, my - p.my0));
        if (moved < 12) return;
        const together = Math.sign(dyA) === Math.sign(dyB) && Math.min(Math.abs(dyA), Math.abs(dyB)) > 6;
        p.mode = together && Math.abs(d - p.d) < 0.4 * Math.abs(my - p.my0) && Math.abs(dAng) < 0.12 && Math.abs(mx - p.mx0) < Math.abs(my - p.my0) ? 'tilt' : 'pinch';
        p.my = my;
      }
      if (p.mode === 'tilt') {
        this.tiltGoal += (my - p.my) * 0.005; p.my = my;
      } else {
        this.distGoal = THREE.MathUtils.clamp(p.dist * p.d / Math.max(10, d), this.minDistance, this.maxDistance);
        // Turn only after a clear twist, then follow it from there without a jump.
        if (!p.twist && Math.abs(dAng) > 0.18) { p.twist = true; p.yaw = this.yawGoal - dAng; }
        if (p.twist) this.yawGoal = p.yaw + dAng;
        // The ground under the fingers stays under them.
        if (p.grab) this.panTo(p.grab, mx, my, Math.max(1, now - p.t) / 1000);
        this.vel.set(0, 0, 0);
      }
      p.t = now;
    }
    this.clampGoal();
  }
  private wheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.free = false;
    // Lines and pages to pixels; a trackpad's pinch arrives as ctrl + wheel.
    const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1) * (e.ctrlKey ? 4 : 1);
    const before = this.distGoal;
    const under = this.pick(e.clientX, e.clientY);
    this.distGoal = THREE.MathUtils.clamp(before * Math.exp(px * 0.0012), this.minDistance, this.maxDistance);
    // Toward the pointer: the point under it moves toward the centre as much as the zoom closes in.
    if (under) {
      const f = 1 - this.distGoal / before, shift = under.clone().sub(this.goal);
      shift.y = 0;
      this.goal.addScaledVector(shift, f);
    }
    this.vel.set(0, 0, 0);
    this.clampGoal();
  };

  /** Each frame. */
  update(dt = 1 / 60) {
    if (!this.enabled) return;
    dt = Math.min(dt, 0.1);
    const k = this.keys;
    // Keys: pan at a pace that suits the zoom, relative to where the camera faces.
    let fx = 0, fz = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) fz -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) fz += 1;
    if (k.has('KeyD') || k.has('ArrowRight')) fx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) fx -= 1;
    if (fx || fz || k.has('KeyQ') || k.has('KeyE') || k.has('KeyR') || k.has('KeyF')) this.free = false;
    if (fx || fz) {
      const sp = this.distGoal * 0.9 * (k.has('ShiftLeft') || k.has('ShiftRight') ? 2.5 : 1) * dt;
      const s = Math.sin(this.yawGoal), c = Math.cos(this.yawGoal);
      this.goal.x += (fx * c + fz * s) * sp;
      this.goal.z += (-fx * s + fz * c) * sp;
      this.vel.set(0, 0, 0);
    }
    if (k.has('KeyQ')) this.yawGoal += 1.6 * dt;
    if (k.has('KeyE')) this.yawGoal -= 1.6 * dt;
    if (k.has('KeyR')) this.distGoal *= Math.exp(-1.8 * dt);
    if (k.has('KeyF')) this.distGoal *= Math.exp(1.8 * dt);
    // A drag let go carries on and slows.
    // (Slowing at rate 3 / glide: it goes on about glide / 3 s worth of the speed it had.)
    if (!this.drag && !this.pinch) {
      if (this.feel.glide <= 0) { this.vel.set(0, 0, 0); this.yawVel = 0; }
      const decay = Math.exp(-dt * 3 / Math.max(0.01, this.feel.glide));
      this.goal.addScaledVector(this.vel, dt);
      this.yawGoal += this.yawVel * dt;
      this.vel.multiplyScalar(decay); this.yawVel *= decay;
    }
    this.clampGoal();

    // Ease toward the goal. Zoom eases in log space, so a step feels the same near and far.
    const f = ease(this.feel.follow, dt);
    this.target.x += (this.goal.x - this.target.x) * f;
    this.target.z += (this.goal.z - this.target.z) * f;
    this.yaw += (this.yawGoal - this.yaw) * f;
    if (Math.abs(this.yaw) > TAU * 4) { const w = Math.round(this.yaw / TAU) * TAU; this.yaw -= w; this.yawGoal -= w; }
    this.dist = Math.exp(Math.log(this.dist) + (Math.log(this.distGoal) - Math.log(this.dist)) * f);
    this.tilt += (this.tiltGoal - this.tilt) * f;
    // The point follows the ground's height, smoothed (bumps would make the view twitch).
    const gy = this.ground(this.target.x, this.target.z);
    this.groundY += (gy - this.groundY) * ease(4, dt);
    this.target.y = this.groundY;
    this.place(this.camera, this.target, this.yaw, this.dist, this.tilt);
    // Never into the ground: lift, looking at the point still.
    const clear = this.ground(this.camera.position.x, this.camera.position.z) + Math.max(1.5, this.dist * 0.04);
    if (this.camera.position.y < clear) { this.camera.position.y = clear; this.camera.lookAt(this.target); }
  }

  /** Turn (eased) to face a heading, the short way round (the compass: north up). */
  turnTo(yaw: number) {
    const d = THREE.MathUtils.euclideanModulo(yaw - this.yawGoal + Math.PI, TAU) - Math.PI;
    this.yawGoal += d;
    this.yawVel = 0;
    this.free = false;
  }
  /** When the user last took hold of the camera (performance.now()): a camera that follows something
   * (Primundi's caravan) lets go once they do. */
  touched = 0;
  /** Ease the point looked at to (x, z), three's frame; and the distance, if given. */
  glideTo(x: number, z: number, dist?: number) {
    this.goal.x = x; this.goal.z = z;
    if (dist !== undefined) this.distGoal = dist;
    this.vel.set(0, 0, 0);
    this.free = false;
    this.clampGoal();
  }
  /** How far the camera is (or is going) from the point it looks at. */
  get distance() { return this.distGoal; }
  /** The camera's heading (0: north), for whoever takes over from it (walking). */
  get heading() { return this.yaw; }
}
