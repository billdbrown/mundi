/**
 * Walking in the hex view, first person: dropped onto the ground (drag the little figure onto
 * the map, as in Street View), the mouse looks round (pointer lock), Esc leaves.
 *
 *   W A S D walk · Shift sprint · Space jump · mouse look · Esc back to the map
 *
 * Speeds up and slows down rather than starting and stopping dead; gravity and a jump; sprint
 * comes on over a moment and widens the view a little; steep ground uphill slows you. A slight
 * head bob follows the steps (it fades out standing still; `bob` 0 turns it off). The eye
 * height is smoothed, so a bumpy ground doesn't shake the view. Going in, the camera glides
 * down from where it was to the eye; leaving, it glides back.
 */
import * as THREE from 'three';

const EYE = 1.7;
const WALK = 4, SPRINT = 14;           // m/s (Bill, 2026-11-06: faster than 2.4 / 9)
/** The walker's field of view (vertical, degrees): wider than the map camera's, as in games. */
const FOV = 68;
const ACCEL = 10, DECEL = 12;          // how fast speed changes (1/s)
const GRAVITY = 14, JUMP = 4.6;        // a little heavier than real: real gravity feels floaty
const GLIDE_S = 1.1;                   // the drop's and the return's glide, seconds

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Walker {
  /** Walking (or gliding in or out). */
  active = false;
  /** Head bob strength: 1 the default, 0 off. */
  bob = 1;
  /** Height of the ground (or water) at (x, z), three's frame. */
  ground: (x: number, z: number) => number = () => 0;
  /** Where the walker may go: |x|, |z| within this. */
  limit = 1000;
  /** Called once it has glided back out (the map camera takes over again). */
  onDone: () => void = () => {};

  private camera: THREE.PerspectiveCamera;
  private dom: HTMLElement;
  private keys = new Set<string>();
  private pos = new THREE.Vector3();      // feet
  private vel = new THREE.Vector3();      // horizontal, m/s
  private vy = 0;
  private onGround = true;
  private yaw = 0;                        // 0: looking north (-z)
  private pitch = 0;
  private eyeY = 0;                       // smoothed eye height
  private stride = 0;                     // distance walked, for the bob's phase
  private bobAmp = 0;
  private land = 0;                       // dip on landing
  private sprintK = 0;
  private baseFov = 50;
  private outFov = FOV;
  private glide: null | { t: number; from: THREE.Vector3; fromQ: THREE.Quaternion; to: THREE.Vector3; toQ: THREE.Quaternion; out: boolean } = null;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera; this.dom = dom;
    addEventListener('keydown', (e) => {
      if (!this.active) return;
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
      if (e.code === 'Escape') this.leave();   // (when the pointer wasn't locked, Esc comes here)
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (!this.active || this.glide?.out || document.pointerLockElement !== this.dom) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.45, 1.45);
    });
    document.addEventListener('pointerlockchange', () => {
      if (this.active && document.pointerLockElement !== this.dom && !this.glide?.out) this.leave();
    });
  }

  /** Drop in at (x, z), facing `yaw` (0: north). Call from the gesture that drops (pointer lock
   * needs one). The camera glides from where it is now. */
  start(x: number, z: number, yaw: number) {
    this.active = true;
    this.baseFov = this.camera.fov;
    this.pos.set(x, this.ground(x, z), z);
    this.vel.set(0, 0, 0); this.vy = 0; this.onGround = true;
    this.yaw = yaw; this.pitch = -0.08;
    this.eyeY = this.pos.y + EYE; this.bobAmp = 0; this.land = 0; this.sprintK = 0;
    this.keys.clear();
    this.glide = { t: 0, from: this.camera.position.clone(), fromQ: this.camera.quaternion.clone(), to: new THREE.Vector3(x, this.eyeY, z), toQ: this.look(), out: false };
    void this.dom.requestPointerLock?.()?.catch?.(() => {});
  }

  /** Glide back to a pose (the map camera's), then onDone. */
  private back: null | { p: THREE.Vector3; q: THREE.Quaternion } = null;
  setReturn(p: THREE.Vector3, target: THREE.Vector3) {
    const m = new THREE.Matrix4().lookAt(p, target, new THREE.Vector3(0, 1, 0));
    this.back = { p: p.clone(), q: new THREE.Quaternion().setFromRotationMatrix(m) };
  }
  leave() {
    if (!this.active || this.glide?.out) return;
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
    this.outFov = this.camera.fov;
    if (!this.back) { this.camera.fov = this.baseFov; this.camera.updateProjectionMatrix(); this.active = false; this.onDone(); return; }
    this.glide = { t: 0, from: this.camera.position.clone(), fromQ: this.camera.quaternion.clone(), to: this.back.p, toQ: this.back.q, out: true };
  }

  private look() {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  update(dt: number) {
    if (!this.active) return;
    dt = Math.min(dt, 0.05);
    const cam = this.camera;
    if (this.glide) {
      const g = this.glide;
      g.t = Math.min(1, g.t + dt / GLIDE_S);
      const k = easeInOut(g.t);
      // In: the eye pose follows the mouse while gliding, so the end doesn't jump.
      if (!g.out) g.toQ.copy(this.look());
      cam.position.lerpVectors(g.from, g.to, k);
      cam.quaternion.slerpQuaternions(g.fromQ, g.toQ, k);
      // The lens widens going in and narrows coming out.
      cam.fov = g.out ? THREE.MathUtils.lerp(this.outFov, this.baseFov, k) : THREE.MathUtils.lerp(this.baseFov, FOV, k);
      cam.updateProjectionMatrix();
      if (g.t >= 1) {
        this.glide = null;
        if (g.out) { this.active = false; this.onDone(); }
      }
      return;
    }
    const kz = this.keys, sprint = kz.has('ShiftLeft') || kz.has('ShiftRight');
    let fx = 0, fz = 0;
    if (kz.has('KeyW') || kz.has('ArrowUp')) fz -= 1;
    if (kz.has('KeyS') || kz.has('ArrowDown')) fz += 1;
    if (kz.has('KeyD') || kz.has('ArrowRight')) fx += 1;
    if (kz.has('KeyA') || kz.has('ArrowLeft')) fx -= 1;
    const len = Math.hypot(fx, fz);
    this.sprintK += ((sprint && len && fz < 0 ? 1 : 0) - this.sprintK) * (1 - Math.exp(-dt * 3));
    const top = WALK + (SPRINT - WALK) * this.sprintK;
    // Wanted velocity, in the facing frame.
    const want = new THREE.Vector3();
    if (len) {
      const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
      want.set((fx * c + fz * s) / len, 0, (-fx * s + fz * c) / len).multiplyScalar(top);
    }
    // Uphill slows: the ground's rise over the next half metre the way you are going.
    if (want.lengthSq() > 0) {
      const d = want.clone().normalize().multiplyScalar(0.5);
      const rise = (this.ground(this.pos.x + d.x, this.pos.z + d.z) - this.ground(this.pos.x, this.pos.z)) / 0.5;
      want.multiplyScalar(THREE.MathUtils.clamp(1 - Math.max(0, rise - 0.3) * 1.2, 0.15, 1));
    }
    // Speeding up and slowing down; less grip in the air.
    const rate = (want.lengthSq() > this.vel.lengthSq() ? ACCEL : DECEL) * (this.onGround ? 1 : 0.15);
    this.vel.lerp(want, 1 - Math.exp(-dt * rate));
    this.pos.x = THREE.MathUtils.clamp(this.pos.x + this.vel.x * dt, -this.limit, this.limit);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z + this.vel.z * dt, -this.limit, this.limit);
    // Gravity and the jump.
    const g = this.ground(this.pos.x, this.pos.z);
    if (this.onGround && kz.has('Space')) { this.vy = JUMP; this.onGround = false; }
    if (!this.onGround) {
      this.vy -= GRAVITY * dt;
      this.pos.y += this.vy * dt;
      if (this.pos.y <= g) {
        this.land = Math.min(0.12, -this.vy * 0.02);
        this.pos.y = g; this.vy = 0; this.onGround = true;
      }
    } else if (g < this.pos.y - 0.6) {
      // Walked off something steep: fall.
      this.onGround = false; this.vy = 0;
    } else this.pos.y = g;
    // The eye: smoothed when walking on the ground (so bumps don't shake it), direct in the air.
    const eyeTo = this.pos.y + EYE;
    this.eyeY = this.onGround ? this.eyeY + (eyeTo - this.eyeY) * (1 - Math.exp(-dt * 14)) : eyeTo;
    this.land *= Math.exp(-dt * 8);
    // Head bob: phase from distance walked (a step every ~0.8 m, longer at a run), strength from speed.
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.stride += speed * dt / (0.8 + 0.5 * this.sprintK);
    const ampTo = this.onGround ? Math.min(1, speed / WALK) * this.bob : 0;
    this.bobAmp += (ampTo - this.bobAmp) * (1 - Math.exp(-dt * 6));
    const ph = this.stride * Math.PI;
    const up = Math.abs(Math.sin(ph)) * 0.035 * this.bobAmp * (1 + 0.6 * this.sprintK);
    const side = Math.sin(ph) * 0.018 * this.bobAmp;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    cam.position.set(this.pos.x + c * side, this.eyeY + up - this.land, this.pos.z - s * side);
    cam.quaternion.copy(this.look());
    // Sprint widens the view a touch.
    const fov = FOV + 7 * this.sprintK;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }
}

/**
 * The little figure: drag it onto the map to walk there (a marker shows where it would land),
 * or click it to drop in at the middle of the view. pick: the ground under a screen point, or
 * null; drop: called from the pointer-up, so pointer lock may be asked for.
 */
export function pegman(el: HTMLElement, canvas: HTMLElement, marker: THREE.Object3D,
  pick: (x: number, y: number) => THREE.Vector3 | null, drop: (p: THREE.Vector3 | null) => void) {
  let ghost: HTMLElement | null = null, from: [number, number] | null = null, at: THREE.Vector3 | null = null;
  const over = (x: number, y: number) => document.elementFromPoint(x, y) === canvas;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    from = [e.clientX, e.clientY]; at = null;
  });
  el.addEventListener('pointermove', (e) => {
    if (!from) return;
    if (!ghost && Math.hypot(e.clientX - from[0], e.clientY - from[1]) > 5) {
      ghost = el.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('id');
      ghost.className = 'pegman-ghost';
      document.body.appendChild(ghost);
      el.classList.add('lifted');
    }
    if (!ghost) return;
    ghost.style.left = `${e.clientX}px`; ghost.style.top = `${e.clientY}px`;
    at = over(e.clientX, e.clientY) ? pick(e.clientX, e.clientY) : null;
    marker.visible = !!at;
    if (at) marker.position.copy(at);
    ghost.classList.toggle('nope', !at);
  });
  const end = (e: PointerEvent, cancel: boolean) => {
    if (!from) return;
    const dragged = !!ghost;
    ghost?.remove(); ghost = null; from = null;
    el.classList.remove('lifted');
    marker.visible = false; marker.removeFromParent();
    if (cancel) return;
    if (!dragged) drop(null);
    else if (at) drop(at);
    void e;
  };
  el.addEventListener('pointerup', (e) => end(e, false));
  el.addEventListener('pointercancel', (e) => end(e, true));
}
