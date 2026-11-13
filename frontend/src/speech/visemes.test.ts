import { describe, expect, it } from "vitest";
import { LipSync } from "./lipsync";
import { VISEMES, buildTimeline, visemeInWord, wordVisemes } from "./visemes";

describe("wordVisemes", () => {
  it("uses the language's letter groups", () => {
    expect(wordVisemes("Schule", "de")).toEqual(["CH", "U", "nn", "E"]);
    expect(wordVisemes("think", "en")).toEqual(["TH", "I", "nn", "kk"]);
    expect(wordVisemes("çay", "tr")).toEqual(["CH", "aa", "I"]);
    expect(wordVisemes("Məktəb", "az")).toEqual(["PP", "aa", "kk", "DD", "aa", "PP"]);
    expect(wordVisemes("Привет", "ru")).toEqual(["PP", "RR", "I", "FF", "E", "DD"]);
  });

  it("merges double letters and never returns an empty list", () => {
    expect(wordVisemes("Kaffee", "de")).toEqual(["kk", "aa", "FF", "E"]);
    expect(wordVisemes("h", "de")).toEqual(["aa"]);
  });

  it("gives numbers some movement", () => {
    expect(wordVisemes("25", "de").length).toBeGreaterThan(2);
  });

  it("only returns known visemes for all kinds of text", () => {
    const text = "Größe Ärger ışık Ğ Şəhər ЁЖЩЪЬ Ünlü q x ß 1984";
    for (const lang of ["de", "en", "tr", "az", "ru"] as const) {
      for (const w of text.split(" ")) for (const v of wordVisemes(w, lang)) expect(VISEMES).toContain(v);
    }
  });
});

describe("buildTimeline", () => {
  it("keeps the character positions of the words and adds pauses at punctuation", () => {
    const text = "Hallo Elmar, wie geht's? Gut.";
    const words = buildTimeline(text, "de", 14);
    expect(words.map((w) => text.slice(w.start, w.end))).toEqual(["Hallo", "Elmar", "wie", "geht's", "Gut"]);
    for (let i = 1; i < words.length; i++) expect(words[i].t0).toBeGreaterThan(words[i - 1].t1);
    const gapComma = words[2].t0 - words[1].t1;
    const gapSpace = words[1].t0 - words[0].t1;
    expect(gapComma).toBeGreaterThan(gapSpace + 0.1);
  });
});

describe("visemeInWord", () => {
  it("walks through the word from first to last shape", () => {
    const v = wordVisemes("Mama", "de");
    expect(visemeInWord(v, 0)).toBe("PP");
    expect(visemeInWord(v, 0.99)).toBe("aa");
    expect(visemeInWord(v, 2)).toBe("aa");
  });
});

describe("LipSync", () => {
  it("is closed when nothing is spoken", () => {
    const lip = new LipSync();
    expect(lip.sample(0)).toEqual({ viseme: "sil", amount: 0 });
  });

  it("moves the mouth along the estimated timeline", () => {
    const lip = new LipSync();
    lip.start("Mama Papa", "de", 1, 1000);
    expect(lip.sample(1000 + 60).viseme).toBe("PP");
    const shapes = new Set<string>();
    for (let t = 1000; t < 2000; t += 20) shapes.add(lip.sample(t).viseme);
    expect(shapes).toContain("aa");
    expect(shapes).toContain("PP");
    lip.stop();
    expect(lip.sample(1100).amount).toBe(0);
  });

  it("jumps to the word that the voice reports", () => {
    const lip = new LipSync();
    const text = "Guten Morgen und willkommen";
    lip.start(text, "de", 1, 0);
    const third = text.indexOf("und");
    lip.boundary(third, 100); // the voice is faster than estimated
    const words = buildTimeline(text, "de", 14.5);
    expect(lip.position(100)).toBeCloseTo(words[2].t0, 5);
    expect(lip.sample(110).viseme).not.toBe("sil");
  });

  it("learns the voice's speed from the boundary events", () => {
    const lip = new LipSync();
    const text = "eins zwei drei vier fünf sechs";
    lip.start(text, "de", 1, 0);
    const words = buildTimeline(text, "de", 14.5);
    // the voice speaks twice as slowly as estimated
    lip.boundary(words[0].start, words[0].t0 * 2000);
    lip.boundary(words[1].start, words[1].t0 * 2000);
    lip.boundary(words[2].start, words[2].t0 * 2000);
    const before = lip.position(words[2].t0 * 2000 + 100);
    expect(before - words[2].t0).toBeLessThan(0.1 * 0.8); // slower than real time
  });
});
