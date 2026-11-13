/**
 * The avatars the app can show. Each one says how its file is built: which bones move the head
 * and arms, which local axes turn the head, and how to bring the arms down from the T-pose.
 */

export type Axis = "x" | "y" | "z";
export type Euler3 = [number, number, number];

export interface AvatarSpec {
  id: string;
  /** file in public/avatar/ */
  file: string;
  format: "rocketbox-fbx" | "glb";
  bones: {
    head: string;
    neck: string;
    chest: string;
    spine: string;
  };
  /** which local axis of the head bone turns it, and in which direction (+1 / -1) */
  headAxes: { yaw: [Axis, number]; pitch: [Axis, number]; roll: [Axis, number] };
  /** rest pose -> natural standing pose: rotation offsets (radians) per bone */
  pose: Record<string, Euler3>;
  /** eye height above the head bone in metres (the camera looks at the face) */
  eyesAboveHeadBone: number;
  /** lids a little closed when relaxed (a wide-open stare looks scared) */
  relaxedLids: number;
  credit: string;
}

/** Microsoft Rocketbox "Business_Male_03", facial version (MIT). The first avatar. */
export const ROCKETBOX: AvatarSpec = {
  id: "rocketbox",
  file: "leon.fbx",
  format: "rocketbox-fbx",
  bones: { head: "Bip01 Head", neck: "Bip01 Neck", chest: "Bip01 Spine2", spine: "Bip01 Spine1" },
  headAxes: { yaw: ["x", 1], pitch: ["z", 1], roll: ["y", 1] },
  pose: {
    // the model stands in an A-pose: arms down along the body, a little forward
    "Bip01 L UpperArm": [0, 0.62, -0.15],
    "Bip01 R UpperArm": [0, -0.62, -0.15],
    // elbows slightly bent
    "Bip01 L Forearm": [0, 0, -0.25],
    "Bip01 R Forearm": [0, 0, -0.25],
  },
  eyesAboveHeadBone: 0.06,
  relaxedLids: 0.1,
  credit: "Microsoft Rocketbox Business_Male_03 (MIT)",
};

/**
 * An Avaturn "T2" export (avaturn.me): realistic face from photos, Mixamo-style skeleton,
 * 52 ARKit blendshapes and the 15 Oculus visemes. Free for non-commercial use.
 */
export function avaturn(file: string): AvatarSpec {
  return {
    id: `avaturn:${file}`,
    file,
    format: "glb",
    bones: { head: "Head", neck: "Neck", chest: "Spine2", spine: "Spine1" },
    headAxes: { yaw: ["y", 1], pitch: ["x", 1], roll: ["z", 1] },
    pose: {
      // the export stands in a T-pose: arms down along the body, hands a little forward
      LeftArm: [1.3, 0, 0.1],
      RightArm: [1.3, 0, -0.1],
      LeftForeArm: [0, 0, 0.3],
      RightForeArm: [0, 0, -0.3],
    },
    eyesAboveHeadBone: 0.08,
    relaxedLids: 0.12,
    credit: "Avaturn avatar (avaturn.me, non-commercial use)",
  };
}

/** Leon as video: short loops of a photo-real face, switched by state (see VideoAvatar.tsx). */
export interface VideoAvatarSpec {
  id: string;
  format: "video";
  /** folder in public/avatar/ */
  folder: string;
  clips: Record<VideoClip, string>;
  poster: string;
  /** colour of the photo's background (the page around the video uses it) */
  background: string;
  /** width / height of the video */
  aspect: number;
  credit: string;
}

export type VideoClip = "listening" | "thinking" | "talking";

export const VIDEO_LEON: VideoAvatarSpec = {
  id: "video",
  format: "video",
  folder: "video/",
  clips: { listening: "listening.mp4", thinking: "thinking.mp4", talking: "talking.mp4" },
  poster: "poster.jpg",
  background: "#171e25",
  aspect: 512 / 704,
  credit: "AI-generated face (Stable Diffusion, Realistic Vision 5.1), animated with LivePortrait",
};

export type AnyAvatar = AvatarSpec | VideoAvatarSpec;

/**
 * The avatar in use. `?avatar=video`, `?avatar=rocketbox` or `?avatar=<file.glb>` in the address
 * picks another one (for comparing); the default is set here.
 */
export function activeAvatar(search = typeof location !== "undefined" ? location.search : ""): AnyAvatar {
  const wanted = new URLSearchParams(search).get("avatar");
  if (wanted === "video") return VIDEO_LEON;
  if (wanted === "rocketbox") return ROCKETBOX;
  if (wanted && /^[\w.-]+\.glb$/i.test(wanted)) return avaturn(wanted);
  return DEFAULT_AVATAR;
}

// the 3D man: his lips follow every word; the video face looks more real but only loops
export const DEFAULT_AVATAR: AnyAvatar = ROCKETBOX;
