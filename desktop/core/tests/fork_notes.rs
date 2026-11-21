mod support;
use serde_json::json;
use support::*;
use threadbear_core::reducer::*;

#[test]
fn fork_provenance_stays_visible_without_opening_the_work_group() {
    let text = "Forked from [Original](thread:source). Independent conversation.";
    let model = from_events(vec![
        user(1, "Hello"),
        call_titled(2, "c1", "Read files"),
        result(3, "c1"),
        done(4),
        event_no_turn(5, "system.note", json!({"text": text, "fork": true})),
    ]);
    let note = model
        .rows()
        .iter()
        .find(|r| r.id == "n:5")
        .expect("visible provenance row");
    assert_eq!(RowDebug::text(note), text);
    assert!(!note.in_group);
}

#[test]
fn old_and_malformed_note_flags_keep_the_existing_note_behavior() {
    for flag in [json!(null), json!(false), json!("yes"), json!(42)] {
        let event = event_no_turn(
            1,
            "system.note",
            json!({"text": "Ordinary note", "fork": flag}),
        );
        assert!(matches!(
            event.payload,
            EventPayload::SystemNote { fork: false, .. }
        ));
    }
    let event = event_no_turn(1, "system.note", json!({"text": "Ordinary note"}));
    assert!(matches!(
        event.payload,
        EventPayload::SystemNote { fork: false, .. }
    ));
}
