use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// `open_file` の戻り値。本文はBOMを除いたUTF-8、hashはディスク上のバイト列のSHA-256。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub text: String,
    pub has_bom: bool,
    pub hash: String,
    /// 最終更新時刻（UNIXエポックからのミリ秒）。取得できなければ 0
    pub mtime: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    pub hash: String,
    pub mtime: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SaveError {
    Conflict { disk_hash: String },
    Io { message: String },
}

impl From<io::Error> for SaveError {
    fn from(error: io::Error) -> Self {
        Self::Io {
            message: error.to_string(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReadError {
    Io(String),
    NotUtf8,
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::Io(message) => write!(formatter, "ファイルを読み込めません: {message}"),
            ReadError::NotUtf8 => write!(
                formatter,
                "UTF-8ではないファイルは開けません。エディタでUTF-8に変換してください"
            ),
        }
    }
}

impl std::error::Error for ReadError {}

/// バイト列のSHA-256（16進・小文字）
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// UTF-8として検証し、BOMを取り除いた本文を返す。BOMの有無は別に返す。
pub fn decode_markdown(bytes: &[u8]) -> Result<(String, bool), ReadError> {
    let has_bom = bytes.starts_with(&UTF8_BOM);
    let body = if has_bom {
        &bytes[UTF8_BOM.len()..]
    } else {
        bytes
    };
    let text = std::str::from_utf8(body)
        .map_err(|_| ReadError::NotUtf8)?
        .to_owned();
    Ok((text, has_bom))
}

/// ファイルをバイト列で読み、UTF-8検証・BOM除去・SHA-256計算を行う。
pub fn read_open_file(path: &Path) -> Result<OpenedFile, ReadError> {
    let (bytes, mtime) = read_bytes(path).map_err(|error| ReadError::Io(error.to_string()))?;
    let (text, has_bom) = decode_markdown(&bytes)?;
    Ok(OpenedFile {
        text,
        has_bom,
        hash: sha256_hex(&bytes),
        mtime,
    })
}

pub(crate) fn read_bytes(path: &Path) -> io::Result<(Vec<u8>, u64)> {
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok((bytes, modified_millis(file.metadata())))
}

fn modified_millis(metadata: io::Result<fs::Metadata>) -> u64 {
    metadata
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn encoded_markdown(text: &str, has_bom: bool) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() + if has_bom { 3 } else { 0 });
    if has_bom {
        bytes.extend_from_slice(&UTF8_BOM);
    }
    bytes.extend_from_slice(text.as_bytes());
    bytes
}

fn temporary_path(path: &Path) -> io::Result<PathBuf> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing file name"))?;
    let mut temporary_name = std::ffi::OsString::from(".");
    temporary_name.push(name);
    temporary_name.push(".slideapp.tmp");
    Ok(path.with_file_name(temporary_name))
}

// Only remove files created by this operation, never a pre-existing temporary file.
struct RemoveOnDrop(Option<PathBuf>);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

fn check_expected_hash(path: &Path, expected_hash: &str) -> Result<bool, SaveError> {
    match fs::read(path) {
        Ok(bytes) => {
            let disk_hash = sha256_hex(&bytes);
            if disk_hash != expected_hash {
                return Err(SaveError::Conflict { disk_hash });
            }
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// `before_replace` runs while the caller holds the watcher lock. Advance its hash
/// before the rename, so the watcher cannot observe our write as an external edit.
pub(crate) fn save_markdown(
    path: &Path,
    text: &str,
    has_bom: bool,
    expected_hash: &str,
    before_replace: impl FnOnce(&str),
) -> Result<SavedFile, SaveError> {
    let existed = check_expected_hash(path, expected_hash)?;
    let bytes = encoded_markdown(text, has_bom);
    let hash = sha256_hex(&bytes);
    let temporary = temporary_path(path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let _cleanup = RemoveOnDrop(Some(temporary.clone()));
    file.write_all(&bytes)?;
    file.flush()?;
    file.sync_all()?;
    drop(file);

    // Narrow the window for an external write while the temporary file is flushed.
    let still_exists = check_expected_hash(path, expected_hash)?;
    if existed && !still_exists {
        return Err(
            io::Error::new(io::ErrorKind::NotFound, "File was removed while saving").into(),
        );
    }
    before_replace(&hash);
    if still_exists {
        replace_existing(path, &temporary)?;
    } else {
        // Windows rename fails if a competing writer created the destination.
        fs::rename(&temporary, path)?;
    }
    Ok(SavedFile {
        hash,
        mtime: modified_millis(fs::metadata(path)),
    })
}

#[cfg(windows)]
fn replace_existing(path: &Path, temporary: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    // A backup is needed for ERROR_UNABLE_TO_MOVE_REPLACEMENT[_2]: without it,
    // ReplaceFileW may remove the original name even though it reports failure.
    let mut backup_name = temporary.as_os_str().to_os_string();
    backup_name.push(".bak");
    let backup = PathBuf::from(backup_name);
    let reservation = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&backup)?;
    let mut cleanup = RemoveOnDrop(Some(backup.clone()));
    drop(reservation);
    let wide = |value: &Path| -> io::Result<Vec<u16>> {
        let mut value: Vec<u16> = value.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "NUL in file path",
            ));
        }
        value.push(0);
        Ok(value)
    };
    let original_wide = wide(path)?;
    let temporary_wide = wide(temporary)?;
    let backup_wide = wide(&backup)?;
    // SAFETY: All paths are NUL-terminated, live for this call; reserved args are null.
    let replaced = unsafe {
        ReplaceFileW(
            original_wide.as_ptr(),
            temporary_wide.as_ptr(),
            backup_wide.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(1177) {
            // With this error, the original has moved to the backup name. A
            // concurrent creator must not be overwritten during recovery.
            let restore = if path.exists() {
                Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "Destination appeared during recovery",
                ))
            } else {
                fs::rename(&backup, path)
            };
            if let Err(restore) = restore {
                // Keep the only copy of the original if the OS also refuses recovery.
                cleanup.0 = None;
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "{error}; recovery failed: {restore}; original retained at {}",
                        backup.display()
                    ),
                ));
            }
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_existing(path: &Path, temporary: &Path) -> io::Result<()> {
    fs::rename(temporary, path)
}

pub(crate) fn write_new_markdown(
    path: &Path,
    text: &str,
    has_bom: bool,
) -> Result<SavedFile, SaveError> {
    let bytes = encoded_markdown(text, has_bom);
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let result = (|| -> io::Result<()> {
        file.write_all(&bytes)?;
        file.flush()?;
        file.sync_all()
    })();
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(path);
        return Err(error.into());
    }
    Ok(SavedFile {
        hash: sha256_hex(&bytes),
        mtime: modified_millis(fs::metadata(path)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(bytes: &[u8]) -> NamedTempFile {
        let mut file = NamedTempFile::new().expect("create temp file");
        file.write_all(bytes).expect("write temp file");
        file.flush().expect("flush temp file");
        file
    }

    #[test]
    fn reads_utf8_file_without_bom() {
        let file = write_temp("こんにちは\r\n世界\n".as_bytes());
        let opened = read_open_file(file.path()).expect("read");

        assert!(!opened.has_bom);
        assert_eq!(opened.text, "こんにちは\r\n世界\n");
        assert_eq!(opened.hash, sha256_hex("こんにちは\r\n世界\n".as_bytes()));
        assert_eq!(opened.hash.len(), 64);
        assert!(opened.mtime > 0);
    }

    #[test]
    fn strips_bom_and_reports_it() {
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice("# タイトル\n".as_bytes());
        let file = write_temp(&bytes);
        let opened = read_open_file(file.path()).expect("read");

        assert!(opened.has_bom);
        assert_eq!(opened.text, "# タイトル\n");
        // ハッシュはBOMを含むディスク上のバイト列から計算する
        assert_eq!(opened.hash, sha256_hex(&bytes));
    }

    #[test]
    fn bom_only_file_becomes_empty_text() {
        let file = write_temp(&UTF8_BOM);
        let opened = read_open_file(file.path()).expect("read");

        assert!(opened.has_bom);
        assert_eq!(opened.text, "");
    }

    #[test]
    fn rejects_non_utf8_file() {
        let file = write_temp(&[0xFF, 0xFE, 0x41, 0x00]);
        let error = read_open_file(file.path()).expect_err("must fail");

        assert_eq!(error, ReadError::NotUtf8);
    }

    #[test]
    fn rejects_invalid_utf8_after_bom() {
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(&[0x80, 0x80]);
        let file = write_temp(&bytes);
        let error = read_open_file(file.path()).expect_err("must fail");

        assert_eq!(error, ReadError::NotUtf8);
    }

    #[test]
    fn keeps_mixed_line_endings_as_is() {
        let file = write_temp(b"a\r\nb\nc\r\n");
        let opened = read_open_file(file.path()).expect("read");

        assert_eq!(opened.text, "a\r\nb\nc\r\n");
    }

    #[test]
    fn reports_io_error_for_missing_file() {
        let error =
            read_open_file(Path::new("Z:\\definitely\\missing\\file.md")).expect_err("must fail");
        assert!(matches!(error, ReadError::Io(_)));
    }

    #[test]
    fn decode_only_strips_the_bom_at_the_start() {
        let (text, has_bom) = decode_markdown("a\u{FEFF}b".as_bytes()).expect("decode");
        assert!(!has_bom);
        assert_eq!(text, "a\u{FEFF}b");
    }

    #[test]
    fn atomic_save_preserves_exact_bytes_with_and_without_bom() {
        for has_bom in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("deck 日本語.md");
            fs::write(&path, b"old").unwrap();
            let text = "# 日本語\r\n\r\nbody\nlast line  ";
            let saved = save_markdown(&path, text, has_bom, &sha256_hex(b"old"), |_| {}).unwrap();
            let expected = encoded_markdown(text, has_bom);
            assert_eq!(fs::read(&path).unwrap(), expected);
            assert_eq!(saved.hash, sha256_hex(&expected));
            assert!(saved.mtime > 0);
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn conflicting_save_keeps_original_and_creates_no_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        fs::write(&path, b"external").unwrap();
        let error = save_markdown(&path, "mine", false, &sha256_hex(b"old"), |_| {
            panic!("must not advance hash")
        })
        .unwrap_err();
        assert_eq!(
            error,
            SaveError::Conflict {
                disk_hash: sha256_hex(b"external")
            }
        );
        assert_eq!(fs::read(&path).unwrap(), b"external");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn saves_a_missing_file_using_rename() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        let saved =
            save_markdown(&path, "new\r\n", true, "previously opened hash", |_| {}).unwrap();
        assert_eq!(fs::read(&path).unwrap(), encoded_markdown("new\r\n", true));
        assert_eq!(saved.hash, sha256_hex(&fs::read(&path).unwrap()));
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn new_file_preserves_bytes_and_never_overwrites_an_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.mine.md");
        for has_bom in [false, true] {
            let saved = write_new_markdown(&path, "mine\r\n", has_bom).unwrap();
            let expected = encoded_markdown("mine\r\n", has_bom);
            assert_eq!(fs::read(&path).unwrap(), expected);
            assert_eq!(saved.hash, sha256_hex(&expected));
            assert!(matches!(
                write_new_markdown(&path, "overwritten", false),
                Err(SaveError::Io { .. })
            ));
            assert_eq!(fs::read(&path).unwrap(), expected);
            fs::remove_file(&path).unwrap();
        }
    }

    #[test]
    fn does_not_remove_or_overwrite_a_preexisting_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        fs::write(&path, b"original").unwrap();
        let temporary = temporary_path(&path).unwrap();
        fs::write(&temporary, b"someone else's data").unwrap();
        assert!(matches!(
            save_markdown(&path, "mine", false, &sha256_hex(b"original"), |_| {}),
            Err(SaveError::Io { .. })
        ));
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read(&temporary).unwrap(), b"someone else's data");
    }

    #[cfg(windows)]
    #[test]
    fn failed_replace_keeps_original_and_cleans_up_temporary_files() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        fs::write(&path, b"original").unwrap();
        let _deny_delete = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(matches!(
            save_markdown(&path, "mine", false, &sha256_hex(b"original"), |_| {}),
            Err(SaveError::Io { .. })
        ));
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn save_error_serializes_to_the_frontend_contract() {
        assert_eq!(
            serde_json::to_value(SaveError::Conflict {
                disk_hash: "abc".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "conflict", "diskHash": "abc" })
        );
        assert_eq!(
            serde_json::to_value(SaveError::Io {
                message: "locked".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "io", "message": "locked" })
        );
    }

    #[cfg(windows)]
    #[test]
    fn atomic_save_preserves_windows_file_attributes_and_creation_time() {
        use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};
        use windows_sys::Win32::Storage::FileSystem::{
            SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NOT_CONTENT_INDEXED,
        };
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        fs::write(&path, b"original").unwrap();
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let attributes = FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED;
        assert_ne!(unsafe { SetFileAttributesW(wide.as_ptr(), attributes) }, 0);
        let creation_time = fs::metadata(&path).unwrap().creation_time();
        save_markdown(&path, "saved", false, &sha256_hex(b"original"), |_| {}).unwrap();
        let metadata = fs::metadata(&path).unwrap();
        assert_eq!(metadata.file_attributes() & attributes, attributes);
        assert_eq!(metadata.creation_time(), creation_time);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
