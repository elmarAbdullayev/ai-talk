import { describe, expect, it } from "vitest";
import { TeacherParser, parseCorrection, parseTeacherAnswer } from "./teacher";

/** Streams `text` in small pieces; returns the spoken reply parts joined. */
function stream(text: string, size = 4): { spoken: string; parser: TeacherParser } {
  const parser = new TeacherParser();
  let spoken = "";
  for (let i = 0; i < text.length; i += size) spoken += parser.push(text.slice(i, i + size));
  spoken += parser.finish();
  return { spoken, parser };
}

const WITH_FIX = [
  "YOU SAID: Gestern ich bin gegangen zu Arbeit",
  "BETTER: Gestern bin ich zur Arbeit gegangen.",
  'WHY: Nach "gestern" kommt das Verb zuerst.',
  "REPLY: Das klingt nach Stress! Was ist passiert?",
].join("\n");

describe("TeacherParser", () => {
  it("speaks only the reply and shows the correction", () => {
    for (const size of [1, 3, 8, 500]) {
      const { spoken, parser } = stream(WITH_FIX, size);
      expect(spoken).toBe("Das klingt nach Stress! Was ist passiert?");
      expect(parser.correction()).toEqual({
        said: "Gestern ich bin gegangen zu Arbeit",
        better: "Gestern bin ich zur Arbeit gegangen.",
        why: 'Nach "gestern" kommt das Verb zuerst.',
      });
      expect(parser.reply).toBe("Das klingt nach Stress! Was ist passiert?");
      expect(parser.text).toBe(WITH_FIX);
    }
  });

  it("does not speak anything before the reply starts", () => {
    const parser = new TeacherParser();
    expect(parser.push("YOU SAID: ich habe gelest\nBETTER: Ich habe gelesen.\n")).toBe("");
    expect(parser.push("WHY: Partizip von lesen.\nREP")).toBe("");
    expect(parser.push("LY: Super! Welches")).toBe("Super! Welches");
    expect(parser.push(" Buch?")).toBe(" Buch?");
  });

  it("shows the correction as soon as its lines are complete", () => {
    const parser = new TeacherParser();
    parser.push("YOU SAID: ich gehe gestern\nBETTER: Ich bin gestern gega");
    expect(parser.correction()).toBeNull();
    parser.push("ngen.\nWHY: Vergangenheit.\n");
    expect(parser.correction()?.better).toBe("Ich bin gestern gegangen.");
  });

  it("treats an answer without labels as the reply", () => {
    const { spoken, parser } = stream("Hallo! Wie war dein Tag?");
    expect(spoken).toBe("Hallo! Wie war dein Tag?");
    expect(parser.correction()).toBeNull();
  });

  it("handles a reply line without a correction", () => {
    const { spoken, parser } = stream("REPLY: Sehr gut gesagt! Und dann?");
    expect(spoken).toBe("Sehr gut gesagt! Und dann?");
    expect(parser.correction()).toBeNull();
  });

  it("waits while the start could still be a label", () => {
    const parser = new TeacherParser();
    expect(parser.push("YOU")).toBe("");
    expect(parser.push(" SA")).toBe("");
  });

  it("finds the reply when the model forgets the REPLY label", () => {
    const text = "YOU SAID: I go yesterday\nBETTER: I went yesterday.\nWHY: Past tense.\n\nNice! Where did you go?";
    const { spoken, parser } = stream(text, 5);
    expect(spoken.trim()).toBe("Nice! Where did you go?");
    expect(parser.correction()?.better).toBe("I went yesterday.");
  });

  it("accepts markdown around the labels", () => {
    const text = "**YOU SAID:** ich wohne seit drei Jahre\n**BETTER:** Ich wohne seit drei Jahren.\n**WHY:** Dativ.\n**REPLY:** Toll!";
    const { spoken, parser } = stream(text, 6);
    expect(spoken).toBe("Toll!");
    expect(parser.correction()).toEqual({ said: "ich wohne seit drei Jahre", better: "Ich wohne seit drei Jahren.", why: "Dativ." });
  });
});

describe("parseCorrection", () => {
  it("drops a 'correction' that is the same sentence", () => {
    expect(parseCorrection("YOU SAID: Ich trinke gern Kaffee.\nBETTER: ich trinke gern Kaffee\nWHY: ok")).toBeNull();
  });

  it("drops a 'correction' that says nothing was wrong", () => {
    const block = "YOU SAID: Ich habe drei Jahre Erfahrung.\nBETTER: Ich habe drei Jahre Erfahrung. (Keine Änderung nötig)\nWHY: Korrekt.";
    expect(parseCorrection(block)).toBeNull();
    expect(parseCorrection("YOU SAID: alles korrekt\nBETTER: Ich gehe nach Hause.\nWHY: -")).toBeNull();
    expect(parseCorrection("YOU SAID: I am fine\nBETTER: No change\nWHY: -")).toBeNull();
  });

  it("keeps quotes inside the reason", () => {
    const fix = parseCorrection('YOU SAID: mit die Kunden\nBETTER: mit den Kunden\nWHY: "mit" braucht den Dativ: "den Kunden".');
    expect(fix?.why).toBe('"mit" braucht den Dativ: "den Kunden".');
  });

  it("needs at least the better sentence", () => {
    expect(parseCorrection("WHY: something")).toBeNull();
  });

  it("removes quotes around the sentences", () => {
    expect(parseCorrection('YOU SAID: "ich gehen"\nBETTER: „Ich gehe.“\nWHY: x')).toEqual({
      said: "ich gehen",
      better: "Ich gehe.",
      why: "x",
    });
  });
});

describe("parseTeacherAnswer", () => {
  it("splits a saved answer", () => {
    expect(parseTeacherAnswer(WITH_FIX).reply).toBe("Das klingt nach Stress! Was ist passiert?");
    expect(parseTeacherAnswer("Nur eine Antwort.").correction).toBeNull();
  });
});
