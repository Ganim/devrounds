//! DevRounds error codes as the executor emits them. The words for each code
//! live only in `control-plane/src/errors/words.ts`; the executor carries the
//! code and its data and prints `DR### <data json>`.

use std::fmt;

/// A DevRounds error: a `DR###` code and the data that explains it.
#[derive(Debug, Clone, PartialEq)]
pub struct DrError {
    pub code: &'static str,
    pub data: serde_json::Value,
}

impl DrError {
    /// An error with `code` (`DR` plus three digits) and `data`.
    pub fn new(code: &'static str, data: serde_json::Value) -> Self {
        Self { code, data }
    }
}

impl fmt::Display for DrError {
    /// `DR### <data json>`, the line the executor prints.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.code, self.data)
    }
}

impl std::error::Error for DrError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// The printed form is the code, one space and the data as compact JSON.
    fn displays_code_and_data() {
        let error = DrError::new("DR501", serde_json::json!({ "reason": "x" }));
        assert_eq!(error.to_string(), r#"DR501 {"reason":"x"}"#);
    }
}
