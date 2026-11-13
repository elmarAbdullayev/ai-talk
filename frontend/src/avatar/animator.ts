import * as THREE from "three";
import type { MouthSample } from "../speech/lipsync";
import type { Viseme } from "../speech/visemes";
import type { Rig } from "./rig";

export type AvatarMood = "idle" | "listening" | "thinking" | "speaking";

/** Standard viseme blendshape names (Oculus set; see morphs.ts for how files are mapped). */
const VISEME_SHAPES: Record<Viseme, string> = {
  sil: "viseme_sil",
  PP: "viseme_pp",
  FF: "viseme_ff",
  TH: "viseme_th",
  DD: "viseme_dd",
  kk: "viseme_kk",
  CH: "viseme_ch",
  SS: "viseme_ss",
  nn: "viseme_nn",
  RR: "viseme_rr",
  aa: "viseme_aa",
  E: "viseme_e",
  I: "viseme_i",
  O: "viseme_o",
  U: "viseme_u",
};

/** Standard ARKit blendshape names (lower case, see morphs.ts). */
const SHAPE = {
  blinkL: "eyeblinkleft",
  blinkR: "eyeblinkright",
  browDownL: "browdownleft",
  browDownR: "browdownright",
  browInnerUp: "browinnerup",
  browOuterUpL: "browouterupleft",
  browOuterUpR: "browouterupright",
  lookDownL: "eyelookdownleft",
  lookDownR: "eyelookdownright",
  lookInL: "eyelookinleft",
  lookInR: "eyelookinright",
  lookOutL: "eyelookoutleft",
  lookOutR: "eyelookoutright",
  lookUpL: "eyelookupleft",
  lookUpR: "eyelookupright",
  squintL: "eyesquintleft",
  squintR: "eyesquintright",
  jawOpen: "jawopen",
  pressL: "mouthpressleft",
  pressR: "mouthpressright",
  smileL: "mouthsmileleft",
  smileR: "mouthsmileright",
  cheekSquintL: "cheeksquintleft",
  cheekSquintR: "cheeksquintright",
} as const;

const tmpEuler = new THREE.Euler();
const tmpQuat = new THREE.Quaternion();

function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Smooth wandering value in about -1..1 (sum of slow sines). */
function wander(t: number, seed: number): number {
  return (
    Math.sin(t * 0.31 + seed * 1.7) * 0.5 +
    Math.sin(t * 0.73 + seed * 3.1) * 0.3 +
    Math.sin(t * 1.37 + seed * 5.3) * 0.2
  );
}

interface Nod {
  start: number;
  amp: number;
  duration: number;
}

/** Brings Leon to life: breathing, blinking, eyes, head moves, moods and lip-sync. */
export class AvatarAnimator {
  mood: AvatarMood = "idle";
  /** 0..1 how strongly each mood shows (blends smoothly) */
  private amount: Record<AvatarMood, number> = { idle: 1, listening: 0, thinking: 0, speaking: 0 };
  private weights = new Map<string, number>();
  private nextBlink = 1.5;
  private blinkStart = -1;
  private doubleBlink = false;
  private gaze = { x: 0, y: 0 };
  private gazeTarget = { x: 0, y: 0 };
  private nextSaccade = 0.5;
  private nods: Nod[] = [];
  private browLift = 0;
  private userTalking = false;
  private nextListenNod = 0;
  private visemes = new Map<Viseme, number>();
  /** extra pose offsets for tuning in development */
  readonly poseOverride = new Map<string, [number, number, number]>();

  constructor(private readonly rig: Rig) {}

  hasShape(name: string): boolean {
    return this.rig.morphs.has(name.toLowerCase());
  }

  setUserTalking(talking: boolean): void {
    this.userTalking = talking;
  }

  /** A new sentence starts: small nod, eyebrows up a little (more for questions). */
  sentence(text: string, now: number): void {
    const question = /\?\s*$/.test(text);
    this.nods.push({ start: now, amp: question ? -0.035 : 0.045, duration: 0.6 });
    this.browLift = Math.max(this.browLift, question ? 0.55 : 0.3);
  }

  update(dt: number, now: number, mouth: MouthSample): void {
    dt = Math.min(dt, 0.1);
    for (const mood of Object.keys(this.amount) as AvatarMood[]) {
      this.amount[mood] = approach(this.amount[mood], mood === this.mood ? 1 : 0, 4, dt);
    }
    const listen = this.amount.listening;
    const think = this.amount.thinking;
    const speak = this.amount.speaking;

    this.updateBody(dt, now, listen, think, speak);
    this.updateEyes(dt, now, think);
    this.updateFace(dt, now, mouth, listen, think, speak);
  }

  // ---- body and head ----

  private updateBody(dt: number, now: number, listen: number, think: number, speak: number): void {
    const breath = Math.sin(now * Math.PI * 2 * 0.23);
    // listening: nod now and then while the user talks
    if (listen > 0.5 && this.userTalking && now > this.nextListenNod) {
      this.nods.push({ start: now, amp: 0.03, duration: 0.7 });
      this.nextListenNod = now + 2.2 + Math.random() * 2.5;
    }
    this.nods = this.nods.filter((n) => now - n.start < n.duration);
    let nod = 0;
    for (const n of this.nods) {
      const p = (now - n.start) / n.duration;
      nod += n.amp * Math.sin(p * Math.PI) * (1 - p * 0.3);
    }
    const motion = 0.6 + speak * 0.8 + listen * 0.2;
    const yaw = wander(now * 0.6, 1) * 0.04 * motion + think * 0.07;
    const pitch = wander(now * 0.5, 2) * 0.025 * motion + nod - think * 0.04 + breath * 0.004;
    const roll = wander(now * 0.4, 3) * 0.02 * motion + listen * 0.05 + think * -0.03;

    const { pose, bones } = this.rig.spec;
    for (const [name, offset] of Object.entries(pose)) {
      const extra = this.poseOverride.get(name);
      this.setBone(name, extra ?? offset);
    }
    const turned = new Set([bones.head, bones.neck, bones.chest, bones.spine]);
    for (const [name, offset] of this.poseOverride) {
      if (!(name in pose) && !turned.has(name)) this.setBone(name, offset);
    }
    this.turnBone(bones.head, yaw * 0.65, pitch * 0.65, roll * 0.7);
    this.turnBone(bones.neck, yaw * 0.35, pitch * 0.35, roll * 0.3);
    this.turnBone(bones.chest, wander(now * 0.25, 4) * 0.008, breath * 0.012, 0);
    this.turnBone(bones.spine, 0, breath * 0.006, wander(now * 0.2, 5) * 0.006);
    void dt;
  }

  private setBone(name: string, [x, y, z]: [number, number, number]): void {
    const bone = this.rig.bones.get(name);
    const rest = bone && this.rig.rest.get(bone);
    if (!bone || !rest) return;
    tmpQuat.setFromEuler(tmpEuler.set(x, y, z));
    bone.quaternion.copy(rest).multiply(tmpQuat);
  }

  /** Turns a bone by yaw/pitch/roll on top of its rest pose (axes depend on the skeleton). */
  private turnBone(name: string, yaw: number, pitch: number, roll: number): void {
    const v = { x: 0, y: 0, z: 0 };
    const axes = this.rig.spec.headAxes;
    v[axes.yaw[0]] += yaw * axes.yaw[1];
    v[axes.pitch[0]] += pitch * axes.pitch[1];
    v[axes.roll[0]] += roll * axes.roll[1];
    const extra = this.poseOverride.get(name);
    if (extra) {
      v.x += extra[0];
      v.y += extra[1];
      v.z += extra[2];
    }
    this.setBone(name, [v.x, v.y, v.z]);
  }

  // ---- eyes ----

  private updateEyes(dt: number, now: number, think: number): void {
    if (now >= this.nextSaccade) {
      // mostly look at the user (the camera), with small jumps; when thinking, look up to the side
      const wanderAmount = 0.12 + think * 0.1;
      this.gazeTarget = {
        x: (Math.random() * 2 - 1) * wanderAmount + think * 0.45,
        y: (Math.random() * 2 - 1) * wanderAmount * 0.6 + think * 0.5,
      };
      this.nextSaccade = now + (think > 0.5 ? 1.2 + Math.random() * 1.5 : 0.6 + Math.random() * 2.2);
      if (Math.abs(this.gazeTarget.x - this.gaze.x) > 0.3 && Math.random() < 0.5) this.startBlink(now);
    }
    this.gaze.x = approach(this.gaze.x, this.gazeTarget.x, 25, dt);
    this.gaze.y = approach(this.gaze.y, this.gazeTarget.y, 25, dt);
    const { x, y } = this.gaze;
    // x > 0: Leon looks to his left; y > 0: up
    this.setShape(SHAPE.lookOutL, Math.max(0, x));
    this.setShape(SHAPE.lookInR, Math.max(0, x));
    this.setShape(SHAPE.lookInL, Math.max(0, -x));
    this.setShape(SHAPE.lookOutR, Math.max(0, -x));
    this.setShape(SHAPE.lookUpL, Math.max(0, y));
    this.setShape(SHAPE.lookUpR, Math.max(0, y));
    this.setShape(SHAPE.lookDownL, Math.max(0, -y));
    this.setShape(SHAPE.lookDownR, Math.max(0, -y));

    if (now >= this.nextBlink) this.startBlink(now);
    let blink = 0;
    if (this.blinkStart >= 0) {
      const p = (now - this.blinkStart) / 0.16;
      if (p >= 1) {
        this.blinkStart = this.doubleBlink ? now + 0.08 : -1;
        this.doubleBlink = false;
      } else if (p >= 0) blink = Math.sin(p * Math.PI);
    }
    // relaxed lids (a wide-open stare looks scared); looking down closes them a little more
    const lid = this.rig.spec.relaxedLids + Math.max(0, -y) * 0.3;
    this.setShape(SHAPE.blinkL, Math.max(blink, lid));
    this.setShape(SHAPE.blinkR, Math.max(blink, lid));
  }

  private startBlink(now: number): void {
    if (this.blinkStart >= 0) return;
    this.blinkStart = now;
    this.doubleBlink = Math.random() < 0.15;
    this.nextBlink = now + 2 + Math.random() * 4;
  }

  // ---- face ----

  private updateFace(dt: number, now: number, mouth: MouthSample, listen: number, think: number, speak: number): void {
    this.browLift = approach(this.browLift, 0, 2.5, dt);
    const smile = 0.12 + listen * 0.1 - think * 0.1 + speak * 0.04;
    this.setSmooth(SHAPE.smileL, smile, 4, dt);
    this.setSmooth(SHAPE.smileR, smile * 0.92, 4, dt);
    this.setSmooth(SHAPE.cheekSquintL, smile * 0.4, 4, dt);
    this.setSmooth(SHAPE.cheekSquintR, smile * 0.4, 4, dt);
    this.setSmooth(SHAPE.browInnerUp, listen * 0.18 + this.browLift * 0.7 + wander(now, 6) * 0.04 * speak, 8, dt);
    this.setSmooth(SHAPE.browOuterUpL, this.browLift * 0.4, 8, dt);
    this.setSmooth(SHAPE.browOuterUpR, this.browLift * 0.4, 8, dt);
    this.setSmooth(SHAPE.browDownL, think * 0.25, 5, dt);
    this.setSmooth(SHAPE.browDownR, think * 0.2, 5, dt);
    this.setSmooth(SHAPE.squintL, 0.12 + think * 0.15 + smile * 0.3, 5, dt);
    this.setSmooth(SHAPE.squintR, 0.12 + think * 0.15 + smile * 0.3, 5, dt);
    this.setSmooth(SHAPE.pressL, think * 0.3, 5, dt);
    this.setSmooth(SHAPE.pressR, think * 0.3, 5, dt);

    // lip-sync: the current viseme rises fast, the others fall back (gives smooth transitions)
    for (const v of Object.keys(VISEME_SHAPES) as Viseme[]) {
      const target = v === mouth.viseme && v !== "sil" ? mouth.amount * 0.9 : 0;
      const current = this.visemes.get(v) ?? 0;
      const next = approach(current, target, target > current ? 28 : 16, dt);
      this.visemes.set(v, next);
      this.setShape(VISEME_SHAPES[v], next);
    }
  }

  private setSmooth(name: string, target: number, rate: number, dt: number): void {
    const current = this.weights.get(name) ?? 0;
    this.setShape(name, approach(current, Math.max(0, Math.min(1, target)), rate, dt));
  }

  private setShape(name: string, value: number): void {
    this.weights.set(name, value);
    const handles = this.rig.morphs.get(name.toLowerCase());
    if (!handles) return;
    for (const { mesh, index } of handles) {
      if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = value;
    }
  }

  /** For tuning in development: set a shape directly (it is overwritten by the next frame). */
  debugShape(name: string, value: number): void {
    this.setShape(name, value);
  }
}
