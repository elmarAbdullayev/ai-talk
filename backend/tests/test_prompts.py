from app.prompts import (
    INTERVIEW_TOPICS,
    WINDOW,
    WINDOW_STEP,
    build_messages,
    generation_options,
    interview_finished,
    system_prompt,
    window_start,
)


def talk(n_pairs: int) -> list[dict]:
    history = []
    for i in range(n_pairs):
        history.append({"role": "assistant", "content": f"Frage {i}?"})
        history.append({"role": "user", "content": f"Antwort {i}."})
    return history


def test_free_mode_answers_in_the_chosen_language():
    prompt = system_prompt("free", "az")
    assert "Always answer in Azerbaijani" in prompt
    assert "Leon" in prompt
    assert "no markdown" in prompt


def test_unknown_language_falls_back_to_english():
    assert "Always answer in English" in system_prompt("free", "xx")


def test_teacher_mode_asks_for_the_correction_format():
    prompt = system_prompt("teacher", "de", explain_language="az")
    for label in ("YOU SAID:", "BETTER:", "WHY:", "REPLY:"):
        assert label in prompt
    assert "German teacher" in prompt
    assert "reason, written in Azerbaijani" in prompt


def test_teacher_reminder_names_the_explanation_language():
    note = build_messages("teacher", "de", [{"role": "user", "content": "ich gehe gestern"}], explain_language="az")[-1]["content"]
    assert "WHY line written in Azerbaijani" in note
    note = build_messages("teacher", "de", [{"role": "user", "content": "ich gehe gestern"}])[-1]["content"]
    assert "WHY line written in German" in note


def test_teacher_explains_in_the_practice_language_by_default():
    assert "written in Turkish" in system_prompt("teacher", "tr")


def test_interview_is_german_with_sie_whatever_the_language():
    prompt = system_prompt("interview", "en")
    assert "Speak only German" in prompt
    assert "'Sie'" in prompt
    assert "IT Service Desk" in prompt


def test_build_messages_wraps_history_with_system_prompt_and_reminder():
    history = [{"role": "user", "content": "Hallo"}]
    messages = build_messages("free", "de", history)
    assert messages[0]["role"] == "system"
    assert messages[1] == {"role": "user", "content": "Hallo"}
    assert messages[-1]["role"] == "system"
    assert "German" in messages[-1]["content"]


def test_window_moves_in_steps():
    assert window_start(WINDOW) == 0
    assert window_start(WINDOW + 1) == WINDOW_STEP
    assert window_start(WINDOW + WINDOW_STEP) == WINDOW_STEP
    assert window_start(WINDOW + WINDOW_STEP + 1) == 2 * WINDOW_STEP


def test_build_messages_sends_only_the_window_and_drops_empty_messages():
    history = [{"role": "user" if i % 2 else "assistant", "content": f"m{i}"} for i in range(50)]
    history.insert(10, {"role": "assistant", "content": "  "})
    messages = build_messages("free", "en", history)
    talk_only = [m for m in messages[1:] if m["role"] != "system"]
    assert talk_only[0]["content"] == f"m{window_start(50)}"
    assert talk_only[-1]["content"] == "m49"
    assert len(talk_only) <= WINDOW


def test_every_user_message_is_followed_by_a_reminder():
    history = talk(3)
    messages = build_messages("teacher", "de", history)
    for i, m in enumerate(messages):
        if m["role"] == "user":
            assert messages[i + 1]["role"] == "system"
            assert "REPLY" in messages[i + 1]["content"]


def test_each_prompt_extends_the_previous_one_so_ollama_can_reuse_its_cache():
    for mode in ("free", "teacher", "interview"):
        history: list[dict] = []
        previous = build_messages(mode, "de", history, action="start")
        for turn in range(10):
            history.append({"role": "assistant", "content": f"Antwort {turn}"})
            history.append({"role": "user", "content": f"Satz {turn}"})
            current = build_messages(mode, "de", history)
            assert current[: len(previous)] == previous, (mode, turn)
            assert current[len(previous)] == {"role": "assistant", "content": f"Antwort {turn}"}
            previous = current


def test_a_conversation_started_by_the_user_has_no_start_note():
    messages = build_messages("free", "de", [{"role": "user", "content": "Hallo"}])
    assert [m["role"] for m in messages] == ["system", "user", "system"]


def test_start_action_asks_for_a_greeting():
    messages = build_messages("free", "ru", [], action="start")
    assert [m["role"] for m in messages] == ["system", "system"]
    assert "Greet the user" in messages[-1]["content"]
    assert "Russian" in messages[-1]["content"]


def test_teacher_start_writes_only_the_reply_line():
    assert "only the REPLY line" in build_messages("teacher", "de", [], action="start")[-1]["content"]


def test_interview_start_asks_the_first_topic():
    note = build_messages("interview", "de", [], action="start")[-1]["content"]
    assert "starts now" in note
    assert INTERVIEW_TOPICS[0] in note


def test_interview_asks_the_next_topic_in_order():
    history = talk(2)  # two questions asked and answered
    note = build_messages("interview", "de", history)[-1]["content"]
    assert "asked 2 of" in note
    assert INTERVIEW_TOPICS[2] in note


def test_interview_ends_with_feedback_after_the_last_topic():
    history = talk(len(INTERVIEW_TOPICS))
    assert interview_finished(history)
    note = build_messages("interview", "de", history)[-1]["content"]
    assert "interview is over" in note
    assert "score from 1 to 10" in note


def test_interview_progress_counts_the_whole_interview_not_only_recent_messages():
    history = talk(WINDOW)  # longer than the window that is sent
    assert "interview is over" in build_messages("interview", "de", history)[-1]["content"]


def test_feedback_button_ends_the_interview_early():
    note = build_messages("interview", "de", talk(1), action="feedback")[-1]["content"]
    assert "interview is over" in note


def test_feedback_button_right_after_a_question():
    history = talk(1) + [{"role": "assistant", "content": "Frage?"}]
    messages = build_messages("interview", "de", history, action="feedback")
    assert messages[-2]["content"] == "Frage?"
    assert "interview is over" in messages[-1]["content"]


def test_feedback_gets_room_for_a_longer_answer():
    assert generation_options("interview", talk(1), "feedback").max_tokens > generation_options("free", [], "reply").max_tokens
    assert generation_options("teacher", [], "reply").max_tokens > generation_options("free", [], "reply").max_tokens
