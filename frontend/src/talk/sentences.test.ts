import { describe, expect, it } from "vitest";
import { SentenceSplitter, cleanForDisplay, cleanForSpeech, findSentenceEnd } from "./sentences";

/** Feeds the text in small pieces, like a streaming model. */
function stream(text: string, size = 3, splitter = new SentenceSplitter()): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...splitter.push(text.slice(i, i + size)));
  out.push(...splitter.flush());
  return out;
}

describe("SentenceSplitter", () => {
  it("returns a sentence as soon as the next word starts", () => {
    const s = new SentenceSplitter();
    expect(s.push("Hallo Elmar")).toEqual([]);
    expect(s.push("! Wie")).toEqual(["Hallo Elmar!"]);
    expect(s.push(" geht's?")).toEqual([]);
    expect(s.flush()).toEqual(["Wie geht's?"]);
  });

  it("splits a streamed answer into sentences in every language", () => {
    expect(stream("Salam! Mən Leon. Necəsən?")).toEqual(["Salam!", "Mən Leon.", "Necəsən?"]);
    expect(stream("Привет! Как дела? Всё хорошо…")).toEqual(["Привет!", "Как дела?", "Всё хорошо…"]);
    expect(stream("Merhaba. Bugün nasılsın?")).toEqual(["Merhaba.", "Bugün nasılsın?"]);
  });

  it("does not split numbers, abbreviations and initials", () => {
    expect(stream("Das kostet 3.50 Euro, z. B. im Café. Gut?", 2)).toEqual(["Das kostet 3.50 Euro, z. B. im Café.", "Gut?"]);
    expect(stream("Ich treffe Dr. Weber usw. morgen. Ok.")).toEqual(["Ich treffe Dr. Weber usw. morgen.", "Ok."]);
    expect(stream("Это было, т. е. вчера. Да.")).toEqual(["Это было, т. е. вчера.", "Да."]);
  });

  it("keeps German ordinal numbers inside the sentence", () => {
    expect(stream("Das Gespräch ist am 3. Oktober in Hamburg. Passt das?")).toEqual([
      "Das Gespräch ist am 3. Oktober in Hamburg.",
      "Passt das?",
    ]);
  });

  it("still ends a sentence after a number at the end", () => {
    expect(stream("Ich bin 25. Und du?")).toEqual(["Ich bin 25.", "Und du?"]);
  });

  it("keeps closing quotes and grouped punctuation with the sentence", () => {
    expect(stream('Er sagte: "Gut." Dann ging er?! Ja...')).toEqual(['Er sagte: "Gut."', "Dann ging er?!", "Ja..."]);
  });

  it("splits at line breaks", () => {
    expect(stream("Erster Teil\nZweiter Teil")).toEqual(["Erster Teil", "Zweiter Teil"]);
  });

  it("cuts a long first sentence at a comma so speaking can start early", () => {
    const long =
      "Wenn ein Mitarbeiter sich nicht mehr anmelden kann, frage ich zuerst nach der genauen Fehlermeldung, " +
      "dann prüfe ich im Active Directory, ob das Konto gesperrt ist, und setze das Passwort zurück.";
    const out = stream(long, 4, new SentenceSplitter({ firstMaxChars: 80 }));
    expect(out.length).toBeGreaterThan(1);
    expect(out[0].length).toBeLessThanOrEqual(81);
    expect(out[0].endsWith(",")).toBe(true);
    expect(out.join(" ")).toBe(long);
  });

  it("skips pieces without words", () => {
    expect(stream("Gut. ... – Danke.")).toEqual(["Gut.", "Danke."]);
  });

  it("gives the same result for any chunk size", () => {
    const text = "Hallo! Ich bin Leon, z. B. dein Partner. Was machst du am 3. Mai? Super.";
    const expected = stream(text, 1);
    for (const size of [2, 5, 7, 100]) expect(stream(text, size)).toEqual(expected);
  });
});

describe("findSentenceEnd", () => {
  it("waits until it sees what follows the dot", () => {
    expect(findSentenceEnd("Hallo.")).toBe(-1);
    expect(findSentenceEnd("Hallo. ")).toBe(6);
  });
});

describe("cleanForSpeech", () => {
  it("removes markdown, emojis and stage directions", () => {
    expect(cleanForSpeech("**Super!** Das ist *wirklich* gut 😊 *lächelt*")).toBe("Super! Das ist wirklich gut");
    expect(cleanForSpeech("- Erstens\n- Zweitens")).toBe("Erstens Zweitens");
    expect(cleanForSpeech("Siehe https://example.com bitte.")).toBe("Siehe bitte.");
  });

  it("drops the teacher labels", () => {
    expect(cleanForSpeech("REPLY: Das klingt gut!")).toBe("Das klingt gut!");
  });
});

describe("cleanForDisplay", () => {
  it("keeps line breaks but removes markdown symbols", () => {
    expect(cleanForDisplay("**Gut** gemacht.\n\n\n*Weiter* so")).toBe("Gut gemacht.\n\nWeiter so");
  });
});
