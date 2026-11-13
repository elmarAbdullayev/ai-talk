export type LanguageCode = "az" | "tr" | "de" | "en" | "ru";

export interface Language {
  code: LanguageCode;
  /** name in English (for the interface) */
  name: string;
  /** name in the language itself */
  native: string;
  /** locale for speech recognition and the voice */
  locale: string;
  /**
   * Male voices, best first (part of the voice name; Edge shows some names localized, e.g. in Cyrillic).
   * Checked in Edge on Windows 11: all five languages have a natural male "Online" voice.
   */
  maleVoices: string[];
  /** placeholder for the text box */
  placeholder: string;
}

export const LANGUAGES: Language[] = [
  {
    code: "de",
    name: "German",
    native: "Deutsch",
    locale: "de-DE",
    maleVoices: ["Conrad", "Killian", "Florian", "Jonas", "Jan", "Stefan"],
    placeholder: "Schreib etwas …",
  },
  {
    code: "az",
    name: "Azerbaijani",
    native: "Azərbaycan",
    locale: "az-AZ",
    maleVoices: ["Babək", "Babek"],
    placeholder: "Bir şey yaz …",
  },
  {
    code: "tr",
    name: "Turkish",
    native: "Türkçe",
    locale: "tr-TR",
    maleVoices: ["Ahmet", "Tolga"],
    placeholder: "Bir şey yaz …",
  },
  {
    code: "en",
    name: "English",
    native: "English",
    locale: "en-US",
    maleVoices: ["Andrew", "Brian", "Christopher", "Guy", "Eric", "Roger", "Steffan", "Ryan", "Thomas", "David", "Mark", "George"],
    placeholder: "Type something …",
  },
  {
    code: "ru",
    name: "Russian",
    native: "Русский",
    locale: "ru-RU",
    maleVoices: ["Дмитрий", "Dmitry", "Pavel", "Павел"],
    placeholder: "Напиши что-нибудь …",
  },
];

export function language(code: LanguageCode): Language {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === "string" && LANGUAGES.some((l) => l.code === value);
}
