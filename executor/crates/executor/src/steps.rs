//! Step markers a job prints on its own lines:
//! `::devrounds::step-start name=<name>` and
//! `::devrounds::step-end name=<name> outcome=finished|failed`.

use devrounds_protocol::StepOutcome;

const START: &str = "::devrounds::step-start ";
const END: &str = "::devrounds::step-end ";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepMarker {
    Start { name: String },
    End { name: String, outcome: StepOutcome },
}

/// The marker on `line`, if it is one. Surrounding whitespace (a CR of a
/// Windows line ending included) is ignored; anything else makes it output.
pub fn parse_step_marker(line: &str) -> Option<StepMarker> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix(START) {
        let name = rest.strip_prefix("name=")?;
        return valid(name).then(|| StepMarker::Start {
            name: name.to_owned(),
        });
    }
    let rest = line.strip_prefix(END)?;
    let (name, outcome) = rest.strip_prefix("name=")?.split_once(" outcome=")?;
    let outcome = match outcome {
        "finished" => StepOutcome::Finished,
        "failed" => StepOutcome::Failed,
        _ => return None,
    };
    valid(name).then(|| StepMarker::End {
        name: name.to_owned(),
        outcome,
    })
}

fn valid(name: &str) -> bool {
    !name.is_empty() && !name.contains(char::is_whitespace)
}

/// Numbers steps from 0 in the order they start.
#[derive(Debug, Default)]
pub struct Steps {
    next: u32,
    /// Started and not ended yet, oldest first.
    open: Vec<(u32, String)>,
}

/// A step event to report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepChange {
    Started { step: u32, name: String },
    Finished { step: u32, outcome: StepOutcome },
}

impl Steps {
    /// The change `marker` makes. An end closes the latest open step of that
    /// name; an end with no such step is ignored. Steps never ended stay open.
    pub fn apply(&mut self, marker: StepMarker) -> Option<StepChange> {
        match marker {
            StepMarker::Start { name } => {
                let step = self.next;
                self.next += 1;
                self.open.push((step, name.clone()));
                Some(StepChange::Started { step, name })
            }
            StepMarker::End { name, outcome } => {
                let at = self.open.iter().rposition(|(_, open)| *open == name)?;
                let (step, _) = self.open.remove(at);
                Some(StepChange::Finished { step, outcome })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use devrounds_protocol::StepOutcome;

    use super::{StepChange, StepMarker, Steps, parse_step_marker};

    #[test]
    fn markers_parse_and_anything_else_is_output() {
        assert_eq!(
            parse_step_marker("::devrounds::step-start name=build\r"),
            Some(StepMarker::Start {
                name: "build".into()
            })
        );
        assert_eq!(
            parse_step_marker("::devrounds::step-end name=build outcome=failed"),
            Some(StepMarker::End {
                name: "build".into(),
                outcome: StepOutcome::Failed
            })
        );
        for line in [
            "::devrounds::step-start name=",
            "::devrounds::step-end name=build outcome=skipped",
            "::devrounds::step-end name=build",
            "echo ::devrounds::step-start name=build",
        ] {
            assert_eq!(parse_step_marker(line), None, "{line}");
        }
    }

    #[test]
    fn an_end_closes_the_latest_open_step_of_its_name() {
        let mut steps = Steps::default();
        let start = |name: &str| StepMarker::Start { name: name.into() };
        let end = |name: &str| StepMarker::End {
            name: name.into(),
            outcome: StepOutcome::Finished,
        };
        assert!(matches!(
            steps.apply(start("a")),
            Some(StepChange::Started { step: 0, .. })
        ));
        assert!(matches!(
            steps.apply(start("b")),
            Some(StepChange::Started { step: 1, .. })
        ));
        assert_eq!(
            steps.apply(end("a")),
            Some(StepChange::Finished {
                step: 0,
                outcome: StepOutcome::Finished
            })
        );
        assert_eq!(steps.apply(end("a")), None);
    }
}
