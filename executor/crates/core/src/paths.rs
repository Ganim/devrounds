//! Whether a program is named by path, and the case folding Windows uses to
//! compare names. Trimmed from devlanes-core `paths`: only what the runner needs.

/// Whether `program` names a path rather than a bare command searched in `PATH`.
#[cfg(not(windows))]
pub fn names_a_path(program: &str) -> bool {
    program.contains('/')
}

/// Whether `program` names a path rather than a bare command searched in `PATH`:
/// either separator or a drive letter.
#[cfg(windows)]
pub fn names_a_path(program: &str) -> bool {
    program.contains(['/', '\\'])
        || matches!(program.as_bytes(), [letter, b':', ..] if letter.is_ascii_alphabetic())
}

/// `text` with every character mapped to its simple uppercase form when
/// that is one character, which is close to how NTFS compares names
/// (one character for one, no `ß` to `SS`).
#[cfg(windows)]
pub fn fold_case(text: &str) -> String {
    text.chars()
        .map(|c| {
            let mut upper = c.to_uppercase();
            match (upper.next(), upper.next()) {
                (Some(single), None) => single,
                _ => c,
            }
        })
        .collect()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    /// Either separator or a drive letter names a path; a bare name or a
    /// colon elsewhere does not.
    fn programs_named_by_path() {
        for program in [r".\tool", "bin/tool", r"C:\tools\x.exe", "c:tool"] {
            assert!(names_a_path(program), "{program}");
        }
        for program in ["tool", "tool.exe", "1:tool", "db:migrate", ""] {
            assert!(!names_a_path(program), "{program}");
        }
    }
}
