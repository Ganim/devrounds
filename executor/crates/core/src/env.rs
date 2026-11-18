//! Environment variable names as the runner keeps them. Trimmed from
//! devlanes-core `env`: layers and assembly are gone, the executor only passes
//! a job type's allowlisted variables.

/// An environment variable name unchanged on Unix, where names are case-sensitive.
#[cfg(not(windows))]
pub fn fold_name(name: String) -> String {
    name
}

/// An environment variable name uppercased on Windows, where names ignore
/// case, so `Path` and `PATH` are one key. The folding is
/// [`crate::paths::fold_case`]'s, which is how Windows compares names.
#[cfg(windows)]
pub fn fold_name(name: String) -> String {
    crate::paths::fold_case(&name)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    /// Names fold to uppercase on Windows, one character for one.
    fn names_fold_on_windows() {
        assert_eq!(fold_name("ProgramFiles(x86)".into()), "PROGRAMFILES(X86)");
        assert_eq!(fold_name("straße".into()), "STRAßE");
    }
}
