"""What the AI is told in each mode: free talk, teacher, and job interview practice (German)."""

from __future__ import annotations

from typing import Literal

from .providers.base import ChatMessage, GenerationOptions

Mode = Literal["free", "teacher", "interview"]
Action = Literal["reply", "start", "feedback"]
Role = Literal["user", "assistant"]

LANGUAGES: dict[str, str] = {
    "az": "Azerbaijani",
    "tr": "Turkish",
    "de": "German",
    "en": "English",
    "ru": "Russian",
}

PERSONA = "Leon"

# Only the recent part of a long conversation is sent: small models get slow and confused with
# very long prompts. The window moves in steps (not one message at a time) so that Ollama can reuse
# its cache: when a prompt only extends the previous one, the answer starts in about 0.2 s instead
# of about 1 s on a GTX 1660 Ti (gemma3 cannot drop tokens from its cache, any change means a full
# recalculation).
WINDOW = 24
WINDOW_STEP = 12

VOICE_RULES = (
    "Your words are read aloud by a speech engine, so write the way people speak: "
    "no lists, no markdown, no emojis, no stage directions, no text in brackets."
)

# The job interview: one topic per question, in this order.
INTERVIEW_TOPICS: list[str] = [
    "greet the candidate, introduce yourself in one sentence, and ask them to introduce themselves briefly",
    "motivation: why this IT Service Desk job and why our company",
    "experience with IT support, ticket systems (for example Jira or ServiceNow), Windows, Active Directory and Microsoft 365",
    "a practical case: an employee cannot log in to their PC any more; how do they proceed step by step",
    "a difficult caller who is very angry because his problem is still not solved; what do they do",
    "priorities: many tickets at the same time, one of them an outage for a whole department; how do they prioritise",
    "teamwork and learning: how they work in a team and how they learn new technology",
    "ask whether the candidate has any questions for you, and answer them briefly",
]

INTERVIEW_ROLE = (
    "You are Leon Brandt, team lead of the IT Service Desk at NordTech Solutions GmbH, an IT service company in "
    "Hamburg with about 300 employees. You are interviewing the user for the job 'IT Service Desk Agent "
    "(1st Level Support)', full time, in Hamburg. Speak only German and use the formal 'Sie'. "
    "Be friendly, professional and realistic, like a real German interviewer. You do not know the candidate's "
    "name until they say it. Ask exactly one question per turn."
)


def language_name(code: str) -> str:
    return LANGUAGES.get(code, "English")


def interview_questions_asked(history: list[ChatMessage]) -> int:
    """Each interviewer turn asks one question, so the questions asked = interviewer turns so far."""
    return sum(1 for m in history if m["role"] == "assistant")


def interview_finished(history: list[ChatMessage]) -> bool:
    """All planned questions were asked and the candidate answered the last one."""
    return interview_questions_asked(history) >= len(INTERVIEW_TOPICS) and bool(history) and history[-1]["role"] == "user"


def system_prompt(mode: Mode, language: str, explain_language: str | None = None) -> str:
    lang = language_name(language)
    if mode == "interview":
        return f"{INTERVIEW_ROLE} {VOICE_RULES}"
    base = (
        f"You are {PERSONA}, a friendly man from Hamburg and the user's conversation partner. "
        f"If someone asks, you are an AI conversation partner. {VOICE_RULES} "
        f"Always answer in {lang}, even when the user uses another language."
    )
    if mode == "teacher":
        explain = language_name(explain_language or language)
        return (
            f"{base} You are also the user's {lang} teacher. The user is practising {lang} by speaking. "
            "Their text comes from speech recognition, so ignore punctuation, capital letters and missing commas. "
            "Check the user's last message for clear mistakes in grammar, word forms, word choice or word order. "
            "If there is a mistake, start your answer with exactly these lines:\n"
            "YOU SAID: <the user's sentence with the mistake>\n"
            f"BETTER: <the corrected sentence in {lang}>\n"
            f"WHY: <a very short reason, written in {explain}, at most 12 words>\n"
            f"REPLY: <your answer in {lang}>\n"
            "If the sentence is correct, even if you would say it a little differently, write only the REPLY line. "
            "Correct only one sentence. "
            f"In REPLY, react to what the user said in one or two short, simple sentences in {lang} and ask a question."
        )
    return (
        f"{base} Have a relaxed, natural conversation: react to what the user says, share a short thought, "
        "and often end with a short question so the talk goes on. Answer in one to three short sentences."
    )


def reminder(
    mode: Mode, language: str, history: list[ChatMessage], action: Action, explain_language: str | None = None
) -> str:
    """A short note right before the answer: small models follow rules better when they are close."""
    lang = language_name(language)
    if mode == "interview":
        if action == "feedback" or interview_finished(history):
            return (
                "The interview is over now. Thank the candidate in one sentence. Then step out of the interviewer role "
                "and give honest, helpful feedback in German, speaking directly to the candidate with 'Sie'. Judge only "
                "the candidate's answers, not your own questions: your overall impression in one sentence, two things "
                "that were good, two things to improve with a better example answer, and a score from 1 to 10. If the "
                "candidate made a clear German grammar mistake, quote it and give the correct form. "
                "About 110 words, plain sentences, no lists or symbols."
            )
        if action == "start":
            return (
                "The interview starts now. Greet the candidate, introduce yourself in one sentence and ask the first "
                f"question: {INTERVIEW_TOPICS[0]}. At most 45 words."
            )
        asked = interview_questions_asked(history)
        topic = INTERVIEW_TOPICS[min(asked, len(INTERVIEW_TOPICS) - 1)]
        return (
            f"You have asked {asked} of {len(INTERVIEW_TOPICS)} questions. React to the candidate's answer in one short, "
            "neutral sentence (no feedback yet; if the answer was very short or unclear, you may ask one follow-up "
            f"instead). Then ask exactly one new question about: {topic}. At most 45 words, in German."
        )
    if action == "start":
        if mode == "teacher":
            return (
                f"The lesson starts now. Greet the user in simple {lang} in one sentence and ask one easy question "
                "about their day. Write only the REPLY line."
            )
        return f"The conversation starts now. Greet the user briefly in {lang} and ask one simple question."
    if mode == "teacher":
        return (
            "Answer in the format from your instructions: the YOU SAID, BETTER and WHY lines only if there is a clear "
            f"mistake (the WHY line written in {language_name(explain_language or language)}), then the REPLY line "
            f"in {lang}."
        )
    return f"Answer in {lang}, in one to three short spoken sentences."


def window_start(length: int) -> int:
    """Index of the first message that is still sent. Moves in steps of WINDOW_STEP."""
    if length <= WINDOW:
        return 0
    return -(-(length - WINDOW) // WINDOW_STEP) * WINDOW_STEP


def build_messages(
    mode: Mode,
    language: str,
    history: list[ChatMessage],
    action: Action = "reply",
    explain_language: str | None = None,
) -> list[ChatMessage]:
    """System prompt, the conversation, and after every user message a short reminder.

    The reminders of earlier turns are rebuilt exactly as they were sent then, so each prompt
    starts with the previous one and Ollama can reuse its cache (fast answers).
    """
    convo = [m for m in history if m["role"] in ("user", "assistant") and m["content"].strip()]
    first = window_start(len(convo))

    def note(upto: int, act: Action) -> ChatMessage:
        # the interview progress always counts the whole interview, not only the window
        return {"role": "system", "content": reminder(mode, language, convo[:upto], act, explain_language)}

    messages: list[ChatMessage] = [{"role": "system", "content": system_prompt(mode, language, explain_language)}]
    if first == 0 and (not convo or convo[0]["role"] == "assistant") and (convo or action == "start"):
        # the conversation was opened by the AI (start button): the same note as back then
        messages.append(note(0, "start"))
    for i in range(first, len(convo)):
        message = convo[i]
        messages.append({"role": message["role"], "content": message["content"]})
        last = i == len(convo) - 1
        # after the last of several user messages in a row (an answer failed in between): one note,
        # because an instruction must be followed by the AI's answer (or end the prompt)
        if message["role"] == "user" and (last or convo[i + 1]["role"] != "user"):
            messages.append(note(i + 1, action if last else "reply"))
    if action == "feedback" and convo and convo[-1]["role"] == "assistant":
        messages.append(note(len(convo), "feedback"))
    return messages


def generation_options(mode: Mode, history: list[ChatMessage], action: Action) -> GenerationOptions:
    feedback = mode == "interview" and (action == "feedback" or interview_finished(history))
    if feedback:
        return GenerationOptions(temperature=0.5, max_tokens=420, long_answer=True)
    if mode == "teacher":
        return GenerationOptions(temperature=0.5, max_tokens=260)
    return GenerationOptions(temperature=0.7, max_tokens=200)
