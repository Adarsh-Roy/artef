//! Interval strings, as `--every` takes them and as `artef.toml` writes them (spec §7.4).

use std::time::Duration;

use anyhow::{bail, Result};

/// Parse `"60s"`, `"5m"`, `"1h"` into a duration.
///
/// Three units and whole numbers only. Anything else is a typo in a config file that
/// nobody will look at again for months, so it is refused now rather than guessed at.
pub fn parse_interval(text: &str) -> Result<Duration> {
    let trimmed = text.trim();
    let seconds = unit_seconds(trimmed.chars().last())
        .and_then(|unit| {
            let count: u64 = trimmed[..trimmed.len() - 1].parse().ok()?;
            count.checked_mul(unit)
        })
        .filter(|seconds| *seconds > 0);

    match seconds {
        Some(seconds) => Ok(Duration::from_secs(seconds)),
        // Zero is in here too: an interval of nothing is a loop that never sleeps.
        None => bail!("{text:?} is not an interval — write it like 60s, 5m, or 1h"),
    }
}

/// How many seconds one of that unit is. `None` for anything that is not a unit, which
/// also covers the empty string.
fn unit_seconds(unit: Option<char>) -> Option<u64> {
    match unit {
        Some('s') => Some(1),
        Some('m') => Some(60),
        Some('h') => Some(3600),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_units_from_the_spec_parse() {
        assert_eq!(parse_interval("60s").unwrap(), Duration::from_secs(60));
        assert_eq!(parse_interval("5m").unwrap(), Duration::from_secs(300));
        assert_eq!(parse_interval("1h").unwrap(), Duration::from_secs(3600));
    }

    #[test]
    fn surrounding_space_is_not_a_typo_worth_failing_over() {
        assert_eq!(parse_interval("  30s\n").unwrap(), Duration::from_secs(30));
    }

    #[test]
    fn anything_else_is_an_error_that_shows_the_forms_that_work() {
        for bad in [
            "90x",  // not a unit
            "",     // nothing at all
            "s",    // no number
            "m5",   // the wrong way round
            "60",   // no unit: 60 what?
            "60 s", // a space where the unit should be
            "1.5m", // no fractions
            "-5m",  // no going backwards
            "1d",   // days are not one of the three
            "99999999999999999999s",
        ] {
            let err = parse_interval(bad)
                .err()
                .unwrap_or_else(|| panic!("{bad:?} must not parse"));
            let message = format!("{err:#}");
            assert!(message.contains("60s"), "{bad:?} gave {message}");
        }
    }

    #[test]
    fn zero_is_rejected_because_it_would_spin() {
        assert!(parse_interval("0s").is_err());
        assert!(parse_interval("0m").is_err());
    }
}
