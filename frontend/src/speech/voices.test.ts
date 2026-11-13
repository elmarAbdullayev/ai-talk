import { describe, expect, it } from "vitest";
import { language } from "../config/languages";
import { pickVoice, rankVoices, voiceWarning, type VoiceLike } from "./voices";

const v = (name: string, lang: string, localService = false): VoiceLike => ({ name, lang, localService });

// a part of what Edge on Windows 11 really lists (checked 2026-11-12)
const EDGE: VoiceLike[] = [
  v("Microsoft Katja - German (Germany)", "de-DE", true),
  v("Microsoft Stefan - German (Germany)", "de-DE", true),
  v("Microsoft Hedda - German (Germany)", "de-DE", true),
  v("Microsoft Seraphina Mehrsprachig Online (Natural) - German (Germany)", "de-DE"),
  v("Microsoft Florian Mehrsprachig Online (Natural) - German (Germany)", "de-DE"),
  v("Microsoft Katja Online (Natural) - German (Germany)", "de-DE"),
  v("Microsoft Conrad Online (Natural) - German (Germany)", "de-DE"),
  v("Microsoft Jonas Online (Natural) - German (Austria)", "de-AT"),
  v("Microsoft Banu Online (Natural) - Azerbaijani (Latin, Azerbaijan)", "az-AZ"),
  v("Microsoft Babək Online (Natural) - Azerbaijani (Latin, Azerbaijan)", "az-AZ"),
  v("Microsoft Emel Online (Natural) - Turkish (Türkiye)", "tr-TR"),
  v("Microsoft Ahmet Online (Natural) - Turkish (Türkiye)", "tr-TR"),
  v("Microsoft Tolga - Turkish (Turkey)", "tr-TR", true),
  v("Microsoft Irina - Russian (Russia)", "ru-RU", true),
  v("Microsoft Pavel - Russian (Russia)", "ru-RU", true),
  v("Microsoft Светлана Online (Natural) - Russian (Russia)", "ru-RU"),
  v("Microsoft Дмитрий Online (Natural) - Russian (Russia)", "ru-RU"),
  v("Microsoft Zira - English (United States)", "en-US", true),
  v("Microsoft Ava Online (Natural) - English (United States)", "en-US"),
  v("Microsoft Andrew Online (Natural) - English (United States)", "en-US"),
  v("Microsoft Ryan Online (Natural) - English (United Kingdom)", "en-GB"),
];

describe("pickVoice", () => {
  it("picks a natural male voice for every language in Edge", () => {
    const expected = { de: "Conrad", az: "Babək", tr: "Ahmet", ru: "Дмитрий", en: "Andrew" } as const;
    for (const [code, name] of Object.entries(expected)) {
      const picked = pickVoice(EDGE, language(code as keyof typeof expected));
      expect(picked?.voice.name).toContain(name);
      expect(picked?.male).toBe(true);
      expect(picked?.natural).toBe(true);
    }
  });

  it("falls back to a local male voice (Chrome / no internet)", () => {
    const local = EDGE.filter((x) => x.localService);
    expect(pickVoice(local, language("de"))?.voice.name).toContain("Stefan");
    expect(pickVoice(local, language("ru"))?.voice.name).toContain("Pavel");
    expect(pickVoice(local, language("tr"))?.voice.name).toContain("Tolga");
  });

  it("returns null when there is no voice for the language", () => {
    expect(pickVoice(EDGE.filter((x) => x.localService), language("az"))).toBeNull();
  });

  it("keeps the user's own choice", () => {
    const name = "Microsoft Florian Mehrsprachig Online (Natural) - German (Germany)";
    expect(pickVoice(EDGE, language("de"), name)?.voice.name).toBe(name);
    expect(pickVoice(EDGE, language("de"), "gone")?.voice.name).toContain("Conrad");
  });

  it("lists only voices of the language, male ones first", () => {
    const ranked = rankVoices(EDGE, language("de"));
    expect(ranked.every((r) => r.voice.lang.startsWith("de"))).toBe(true);
    const firstFemale = ranked.findIndex((r) => !r.male);
    expect(ranked.slice(0, firstFemale).every((r) => r.male)).toBe(true);
    expect(ranked.slice(firstFemale).every((r) => !r.male)).toBe(true);
  });

  it("accepts underscores and lower case in the language tag", () => {
    expect(pickVoice([v("Microsoft Conrad Online (Natural)", "de_de")], language("de"))?.exactLocale).toBe(true);
  });
});

describe("voiceWarning", () => {
  it("is quiet for a natural male voice and explains the problems otherwise", () => {
    const de = language("de");
    expect(voiceWarning(pickVoice(EDGE, de), de, true)).toBeNull();
    expect(voiceWarning(null, language("az"), false)).toContain("no Azerbaijani voice");
    expect(voiceWarning(pickVoice([EDGE[0]], de), de, true)).toContain("No male German voice");
    expect(voiceWarning(pickVoice([EDGE[1]], de), de, false)).toContain("robotic");
  });
});
