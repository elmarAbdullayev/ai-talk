/**
 * Blendshape names differ between avatar files. The animation uses the standard names (ARKit:
 * "eyeBlinkLeft", Oculus visemes: "viseme_aa"); this turns each file's names into those.
 *
 *   Rocketbox: "blendShape1.AK_09_EyeBlinkLeft" -> "eyeblinkleft", "AA_VI_10_aa" -> "viseme_aa"
 *   Avaturn / Ready Player Me style: already standard ("eyeBlinkLeft", "viseme_aa")
 *
 * Keys are lower case so that "viseme_KK" and "viseme_kk" are the same shape.
 */
export function canonicalMorph(name: string): string {
  const bare = name.replace(/^.*\./, "");
  const arkit = /^AK_\d+_(.+)$/.exec(bare);
  if (arkit) return arkit[1].toLowerCase();
  const viseme = /^AA_VI_\d+_(.+)$/.exec(bare);
  if (viseme) return `viseme_${viseme[1]}`.toLowerCase();
  return bare.toLowerCase();
}

/** Bone names: "mixamorig:Head" / "mixamorigHead" -> "Head", "Bip01_Head" -> "Bip01 Head". */
export function canonicalBone(name: string): string {
  return name
    .replace(/^mixamorig[:_]?/i, "")
    .replace(/[_\s]+/g, " ")
    .trim();
}
