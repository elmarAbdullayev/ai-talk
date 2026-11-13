import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { MouthSample } from "../speech/lipsync";
import { AvatarAnimator, type AvatarMood } from "./animator";
import type { AvatarSpec } from "./avatars";
import { loadRig, type Rig } from "./rig";

/** Where the camera looks: head and shoulders, like a video call. */
export const FRAMING = {
  fov: 22,
  /** camera distance from the face in metres (wide screens) */
  distance: 1.6,
  /** look this far below the eyes, so the shoulders are in the picture */
  lookBelow: 0.06,
  /** camera height above the look target */
  above: 0.04,
};

/**
 * The 3D view of Leon: a soft studio light setup, the avatar and its animation loop.
 * The canvas is transparent; the page draws the background behind it.
 */
export class AvatarScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.05, 30);
  rig: Rig | null = null;
  animator: AvatarAnimator | null = null;
  private target = new THREE.Vector3(0, 1.6, 0);
  private last = 0;
  private running = false;
  private raf = 0;
  /** in tests: render only when asked */
  manual = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly mouth: () => MouthSample,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance", preserveDrawingBuffer: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x000000, 0);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2420, 0.55));
    const key = new THREE.DirectionalLight(0xfff0e0, 2.1);
    key.position.set(-0.9, 2.4, 1.6); // from Leon's right, above
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xd6e4ff, 0.55);
    fill.position.set(1.4, 1.7, 1.2);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0x9fd8ff, 1.6);
    rim.position.set(0.6, 2.1, -1.6);
    this.scene.add(rim);
    for (const light of [key, fill, rim]) {
      light.target.position.set(0, 1.55, 0);
      this.scene.add(light.target);
    }
  }

  async load(spec: AvatarSpec): Promise<void> {
    this.rig = await loadRig(spec);
    this.scene.add(this.rig.root);
    this.animator = new AvatarAnimator(this.rig);
    const head = this.rig.bones.get(spec.bones.head);
    if (head) {
      this.rig.root.updateMatrixWorld(true);
      head.getWorldPosition(this.target);
      this.target.y += spec.eyesAboveHeadBone; // the camera looks at the eyes
      // the avatar faces the camera: put it in front of the camera, whatever its file origin
      this.target.x = head.getWorldPosition(new THREE.Vector3()).x;
    }
    this.resize();
  }

  set mood(mood: AvatarMood) {
    if (this.animator) this.animator.mood = mood;
  }

  resize(): void {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    this.camera.aspect = aspect;
    // narrow (portrait) views: step back so the shoulders still fit
    const distance = FRAMING.distance * (aspect < 0.8 ? 0.8 / aspect : 1);
    const look = this.target.clone();
    look.y -= FRAMING.lookBelow;
    this.camera.position.set(look.x, look.y + FRAMING.above, look.z + distance);
    this.camera.lookAt(look);
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      if (!this.manual) this.step((t - this.last) / 1000, t);
      this.last = t;
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** One frame: animate and draw. */
  step(dt: number, nowMs = performance.now()): void {
    this.animator?.update(dt, nowMs / 1000, this.mouth());
    this.renderer.render(this.scene, this.camera);
  }

  capture(type = "image/jpeg", quality = 0.9): string {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL(type, quality);
  }

  dispose(): void {
    this.stop();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of materials) {
          for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose();
          m.dispose();
        }
      }
    });
    this.renderer.dispose();
  }
}
