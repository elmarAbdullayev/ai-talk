import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { AvatarSpec } from "./avatars";
import { canonicalBone, canonicalMorph } from "./morphs";

/**
 * Loads the avatar file and finds what the animation needs: the bones and the blendshapes
 * (under their standard names, see morphs.ts).
 *
 * - Rocketbox FBX: "Business_Male_03" from the Microsoft Rocketbox library (MIT), facial version.
 *   Its TGA textures were converted to WebP; the materials are rebuilt as physically based ones.
 * - GLB (Avaturn and similar): materials come with the file.
 */

const BASE = `${import.meta.env.BASE_URL}avatar/`;

export interface MorphHandle {
  mesh: THREE.Mesh;
  index: number;
}

export interface Rig {
  spec: AvatarSpec;
  root: THREE.Object3D;
  bones: Map<string, THREE.Bone>;
  /** standard blendshape name (lower case) -> every mesh that has it */
  morphs: Map<string, MorphHandle[]>;
  /** rest rotation of every bone, to animate on top of it */
  rest: Map<THREE.Bone, THREE.Quaternion>;
  height: number;
}

function texture(loader: THREE.TextureLoader, file: string, color: boolean): THREE.Texture {
  const t = loader.load(BASE + file);
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Rocketbox: without real ambient occlusion the inside of the mouth gets as much light as the face
 * and looks grey-blue. This darkens the mouth area of the head texture (inside, teeth, tongue) and
 * makes the eyeballs a little darker and glossier. The UV boxes were measured on the head texture.
 */
function shadeMouthAndEyes(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float aiMouth = 0.0;
        float aiEye = 0.0;
        #ifdef USE_MAP
          aiMouth = step(vMapUv.x, 0.205) * step(vMapUv.y, 0.41);
          aiEye = step(0.2, vMapUv.x) * step(vMapUv.x, 0.36) * step(vMapUv.y, 0.165);
        #endif
        // teeth are the bright parts of the mouth texture: keep them lighter than gums and tongue
        float aiTeeth = smoothstep(0.28, 0.55, dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)));
        float aiMouthLight = mix(1.0, mix(0.3, 0.7, aiTeeth), aiMouth);
        diffuseColor.rgb *= mix(1.0, 0.88, aiEye);`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, mix(0.9, 0.55, aiTeeth), aiMouth);
        roughnessFactor = mix(roughnessFactor, 0.22, aiEye);`,
      )
      .replace(
        "#include <opaque_fragment>",
        `outgoingLight *= aiMouthLight; // the mouth gets little light from outside
        #include <opaque_fragment>`,
      );
  };
}

async function loadRocketbox(file: string): Promise<THREE.Object3D> {
  const root = await new FBXLoader().loadAsync(BASE + file);
  const textures = new THREE.TextureLoader();
  const headMaterial = new THREE.MeshStandardMaterial({
    name: "head",
    map: texture(textures, "head_color.webp", true),
    normalMap: texture(textures, "head_normal.webp", false),
    roughnessMap: texture(textures, "head_roughness.webp", false),
    roughness: 1,
    metalness: 0,
  });
  shadeMouthAndEyes(headMaterial);
  const bodyMaterial = new THREE.MeshStandardMaterial({
    name: "body",
    map: texture(textures, "body_color.webp", true),
    normalMap: texture(textures, "body_normal.webp", false),
    roughnessMap: texture(textures, "body_roughness.webp", false),
    roughness: 1,
    metalness: 0,
  });
  const hairMaterial = new THREE.MeshStandardMaterial({
    name: "hair",
    map: texture(textures, "hair_opacity.webp", true),
    alphaTest: 0.45,
    transparent: false,
    side: THREE.DoubleSide,
    roughness: 0.75,
    metalness: 0,
  });
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const old = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const replaced = old.map((m) => {
      const name = (m.name || "").toLowerCase();
      if (name.includes("opacity") || name.includes("hair") || name.includes("lash")) return hairMaterial;
      if (name.includes("head")) return headMaterial;
      return bodyMaterial;
    });
    mesh.material = replaced.length === 1 ? replaced[0] : replaced;
    for (const m of old) m.dispose();
  });
  return root;
}

async function loadGlb(file: string): Promise<THREE.Object3D> {
  const gltf = await new GLTFLoader().loadAsync(BASE + file);
  gltf.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const material = m as THREE.MeshStandardMaterial;
      if (material.map) material.map.anisotropy = 4;
      // hair and eyelash cards: cut out instead of blending, so they sort correctly
      if (material.transparent && material.map && /hair|lash|brow/i.test(`${mesh.name} ${material.name}`)) {
        material.transparent = false;
        material.alphaTest = 0.4;
        material.side = THREE.DoubleSide;
        material.needsUpdate = true;
      }
    }
  });
  return gltf.scene;
}

export async function loadRig(spec: AvatarSpec): Promise<Rig> {
  const root = spec.format === "rocketbox-fbx" ? await loadRocketbox(spec.file) : await loadGlb(spec.file);

  const bones = new Map<string, THREE.Bone>();
  const morphs = new Map<string, MorphHandle[]>();
  const rest = new Map<THREE.Bone, THREE.Quaternion>();
  root.traverse((object) => {
    if ((object as THREE.Bone).isBone) {
      const bone = object as THREE.Bone;
      bones.set(canonicalBone(bone.name), bone);
      rest.set(bone, bone.quaternion.clone());
    }
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false; // skinned meshes move outside their original bounds
    for (const [name, index] of Object.entries(mesh.morphTargetDictionary ?? {})) {
      const key = canonicalMorph(name);
      const list = morphs.get(key) ?? [];
      list.push({ mesh, index });
      morphs.set(key, list);
    }
  });

  // FBX files from 3ds Max are in centimetres: scale to metres
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const scale = size.y > 10 ? 0.01 : 1;
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);

  if (import.meta.env.DEV) {
    const missing = Object.values(spec.bones).filter((b) => !bones.has(b));
    console.info(
      `[avatar] ${spec.id}: height ${(size.y * scale).toFixed(2)} m, ${bones.size} bones, ${morphs.size} blendshapes` +
        (missing.length ? `, MISSING bones: ${missing.join(", ")}` : ""),
    );
  }
  return { spec, root, bones, morphs, rest, height: size.y * scale };
}
