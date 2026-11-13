import { describe, expect, it } from "vitest";
import { ROCKETBOX, activeAvatar } from "./avatars";
import { canonicalBone, canonicalMorph } from "./morphs";

describe("canonicalMorph", () => {
  it("maps Rocketbox names to the standard ones", () => {
    expect(canonicalMorph("blendShape1.AK_09_EyeBlinkLeft")).toBe("eyeblinkleft");
    expect(canonicalMorph("AK_44_MouthSmileLeft")).toBe("mouthsmileleft");
    expect(canonicalMorph("blendShape1.AA_VI_10_aa")).toBe("viseme_aa");
    expect(canonicalMorph("AA_VI_05_KK")).toBe("viseme_kk");
    expect(canonicalMorph("AA_VI_00_Sil")).toBe("viseme_sil");
  });

  it("keeps standard names (Avaturn) and ignores case", () => {
    expect(canonicalMorph("eyeBlinkLeft")).toBe("eyeblinkleft");
    expect(canonicalMorph("viseme_kk")).toBe(canonicalMorph("AA_VI_05_KK"));
    expect(canonicalMorph("viseme_CH")).toBe(canonicalMorph("AA_VI_06_CH"));
  });
});

describe("canonicalBone", () => {
  it("removes rig prefixes and cleaned-up underscores", () => {
    expect(canonicalBone("mixamorig:Head")).toBe("Head");
    expect(canonicalBone("mixamorigLeftArm")).toBe("LeftArm");
    expect(canonicalBone("Bip01_L_UpperArm")).toBe("Bip01 L UpperArm");
    expect(canonicalBone("Spine2")).toBe("Spine2");
  });
});

describe("activeAvatar", () => {
  it("can be chosen in the address for comparing", () => {
    expect(activeAvatar("?avatar=rocketbox")).toBe(ROCKETBOX);
    expect(activeAvatar("?avatar=video").format).toBe("video");
    const glb = activeAvatar("?avatar=leon.glb");
    expect(glb.format === "glb" && glb.file).toBe("leon.glb");
    expect(activeAvatar("?avatar=../secret.glb").id).not.toContain("secret");
  });
});
