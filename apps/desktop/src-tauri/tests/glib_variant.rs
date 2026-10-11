#![cfg(target_os = "linux")]

use glib::prelude::ToVariant;

#[test]
fn string_array_iteration_returns_borrowed_values_from_both_ends() {
    let value = ["first", "middle", "last"].to_variant();
    let mut iter = value.array_iter_str().unwrap();

    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.next(), Some("middle"));
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
}

#[test]
fn string_array_iteration_supports_skipping_and_last_value() {
    let value = ["zero", "one", "two", "three", "four"].to_variant();
    let mut iter = value.array_iter_str().unwrap();

    assert_eq!(iter.nth(1), Some("one"));
    assert_eq!(iter.nth_back(1), Some("three"));
    assert_eq!(iter.last(), Some("two"));
}
