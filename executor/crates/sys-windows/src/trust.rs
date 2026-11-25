//! Authenticode signature of a file, as `WinVerifyTrust` judges it.

use std::{ffi::c_void, io, os::windows::ffi::OsStrExt, path::Path, ptr};

use windows_sys::Win32::{
    Foundation::{HWND, TRUST_E_NOSIGNATURE},
    Security::WinTrust::{
        WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO,
        WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY,
        WTD_UI_NONE, WinVerifyTrust,
    },
};

/// What `WinVerifyTrust` says of a file's embedded signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signature {
    /// Signed by a certificate this user trusts, and unmodified since.
    Valid,
    /// No embedded signature.
    Unsigned,
    /// Signed, but not trusted or not intact; the `HRESULT` says why.
    Invalid(i32),
}

/// The embedded Authenticode signature of `path`, revocation not checked
/// (offline machines and self-signed certificates have no revocation list).
/// Catalog-signed system files read as [`Signature::Unsigned`].
pub fn file_signature(path: &Path) -> io::Result<Signature> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    if !path.is_file() {
        return Err(io::Error::from(io::ErrorKind::NotFound));
    }
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: wide.as_ptr(),
        hFile: ptr::null_mut(),
        pgKnownSubject: ptr::null_mut(),
    };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        pPolicyCallbackData: ptr::null_mut(),
        pSIPClientData: ptr::null_mut(),
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 {
            pFile: &raw mut file,
        },
        dwStateAction: WTD_STATEACTION_VERIFY,
        hWVTStateData: ptr::null_mut(),
        pwszURLReference: ptr::null_mut(),
        dwProvFlags: 0,
        dwUIContext: 0,
        pSignatureSettings: ptr::null_mut(),
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let hwnd: HWND = ptr::null_mut();
    // SAFETY: `data` and `file` are fully initialised, live until both calls
    // return, and `wide` (the NUL-terminated path) outlives them.
    let result = unsafe { WinVerifyTrust(hwnd, &raw mut action, (&raw mut data).cast::<c_void>()) };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    // SAFETY: as above; CLOSE releases the state the VERIFY call allocated.
    unsafe { WinVerifyTrust(hwnd, &raw mut action, (&raw mut data).cast::<c_void>()) };
    Ok(match result {
        0 => Signature::Valid,
        TRUST_E_NOSIGNATURE => Signature::Unsigned,
        other => Signature::Invalid(other),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// A cargo-built test binary carries no signature; a missing file is an
    /// error rather than "unsigned".
    fn unsigned_and_missing() {
        let me = std::env::current_exe().expect("test exe");
        assert_eq!(file_signature(&me).expect("read"), Signature::Unsigned);
        let missing = me.with_file_name("no-such-file.exe");
        assert_eq!(
            file_signature(&missing).expect_err("missing").kind(),
            io::ErrorKind::NotFound
        );
    }
}
