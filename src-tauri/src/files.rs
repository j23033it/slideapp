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
    Exists,
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

// Reserve names independently of the destination's length. tempfile uses
// create_new and retries random-name collisions without touching existing files.
fn create_sibling(path: &Path, suffix: &str) -> io::Result<(File, RemoveOnDrop)> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temporary = tempfile::Builder::new()
        .prefix(".slideapp-")
        .rand_bytes(8)
        .suffix(suffix)
        .tempfile_in(parent)?;
    let (file, path) = temporary.keep().map_err(|error| error.error)?;
    Ok((file, RemoveOnDrop(Some(path))))
}

// Only remove files created by this operation, never a pre-existing file.
struct RemoveOnDrop(Option<PathBuf>);

impl RemoveOnDrop {
    fn path(&self) -> &Path {
        self.0.as_deref().expect("owned temporary path")
    }

    fn retain(&mut self, reason: &str) {
        if let Some(path) = self.0.take() {
            eprintln!("SlideApp: {reason}; retained at {}", path.display());
        }
    }
}

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            if let Err(error) = remove_with_retry(path) {
                eprintln!(
                    "SlideApp: temporary cleanup failed: {error}; retained at {}",
                    path.display()
                );
            }
        }
    }
}

fn remove_with_retry(path: &Path) -> io::Result<()> {
    for attempt in 0..4 {
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) if attempt == 3 => return Err(error),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(20 << attempt)),
        }
    }
    unreachable!()
}

#[cfg(windows)]
fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    // Canonicalize only the parent to support long paths even for a missing name.
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing file name"))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let absolute = parent.canonicalize()?.join(name);
    let mut wide: Vec<u16> = absolute.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "NUL in file path",
        ));
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(windows)]
fn move_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let source = wide_path(source)?;
    let destination = wide_path(destination)?;
    // SAFETY: Both NUL-terminated paths live for the call. No REPLACE_EXISTING.
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn move_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::hard_link(source, destination)?;
    fs::remove_file(source)
}

fn move_to_missing(source: &Path, destination: &Path) -> Result<(), SaveError> {
    move_no_replace(source, destination).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            if let Ok(bytes) = fs::read(destination) {
                return SaveError::Conflict {
                    disk_hash: sha256_hex(&bytes),
                };
            }
        }
        error.into()
    })
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
    let (mut file, temporary) = create_sibling(path, ".tmp")?;
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
        replace_existing(path, temporary.path(), expected_hash, &hash)?;
    } else {
        move_to_missing(temporary.path(), path)?;
    }
    Ok(SavedFile {
        hash,
        mtime: modified_millis(fs::metadata(path)),
    })
}

#[cfg(windows)]
fn replace_with_backup(path: &Path, replacement: &Path, backup: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let original_wide = wide_path(path)?;
    let replacement_wide = wide_path(replacement)?;
    let backup_wide = wide_path(backup)?;
    // SAFETY: Paths are NUL-terminated and live for the call; reserved args are null.
    let replaced = unsafe {
        ReplaceFileW(
            original_wide.as_ptr(),
            replacement_wide.as_ptr(),
            backup_wide.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

// ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 leaves the original under the backup name.
// A single no-replace move avoids a check-then-rename race during recovery.
#[cfg(windows)]
fn recover_failed_replace(path: &Path, backup: &mut RemoveOnDrop, error: io::Error) -> SaveError {
    if error.raw_os_error() == Some(1177) {
        if let Err(restore) = move_to_missing(backup.path(), path) {
            let location = backup.path().display().to_string();
            backup.retain("replacement recovery failed");
            return match restore {
                conflict @ SaveError::Conflict { .. } => conflict,
                SaveError::Io { message } => SaveError::Io {
                    message: format!(
                        "{error}; recovery failed: {message}; original retained at {location}"
                    ),
                },
                SaveError::Exists => SaveError::Io {
                    message: format!(
                        "{error}; recovery destination exists; original retained at {location}"
                    ),
                },
            };
        }
    }
    error.into()
}

#[cfg(windows)]
fn replace_existing(
    path: &Path,
    temporary: &Path,
    expected_hash: &str,
    saved_hash: &str,
) -> Result<(), SaveError> {
    let (reservation, mut backup) = create_sibling(path, ".bak")?;
    drop(reservation);
    if let Err(error) = replace_with_backup(path, temporary, backup.path()) {
        return Err(recover_failed_replace(path, &mut backup, error));
    }
    let disk_hash = match fs::read(backup.path()) {
        Ok(bytes) => sha256_hex(&bytes),
        Err(error) => {
            let location = backup.path().display().to_string();
            backup.retain("cannot verify replaced contents");
            return Err(SaveError::Io {
                message: format!("{error}; unverified original retained at {location}"),
            });
        }
    };
    if disk_hash != expected_hash {
        restore_conflicting_backup(path, &mut backup, saved_hash);
        return Err(SaveError::Conflict {
            disk_hash: fs::read(path)
                .map(|bytes| sha256_hex(&bytes))
                .unwrap_or(disk_hash),
        });
    }
    Ok(())
}

// Roll back the save, keeping a second backup so a later external writer is
// preserved too. Never delete an unverified copy on a recovery error.
#[cfg(windows)]
fn restore_conflicting_backup(path: &Path, backup: &mut RemoveOnDrop, saved_hash: &str) {
    let rollback = (|| -> io::Result<()> {
        let (reservation, mut displaced) = create_sibling(path, ".bak")?;
        drop(reservation);
        match replace_with_backup(path, backup.path(), displaced.path()) {
            Ok(()) => {
                if fs::read(displaced.path())
                    .map(|bytes| sha256_hex(&bytes))
                    .ok()
                    .as_deref()
                    != Some(saved_hash)
                {
                    displaced.retain("additional external contents found during rollback");
                }
            }
            Err(error) => {
                if error.raw_os_error() == Some(1177) {
                    // The second replacement moved the current disk file aside.
                    // Prefer restoring the external backup, without overwriting
                    // any destination created in the meantime.
                    let _ = move_to_missing(backup.path(), path);
                    displaced.retain("rollback replacement failed after moving disk contents");
                }
                return Err(error);
            }
        }
        Ok(())
    })();
    if let Err(error) = rollback {
        backup.retain(&format!("conflict rollback failed: {error}"));
    }
}

#[cfg(not(windows))]
fn replace_existing(
    path: &Path,
    temporary: &Path,
    _expected_hash: &str,
    _saved_hash: &str,
) -> Result<(), SaveError> {
    fs::rename(temporary, path).map_err(Into::into)
}

pub(crate) fn write_new_markdown(
    path: &Path,
    text: &str,
    has_bom: bool,
) -> Result<SavedFile, SaveError> {
    let bytes = encoded_markdown(text, has_bom);
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if is_name_collision(&error) => return Err(SaveError::Exists),
        Err(error) => return Err(error.into()),
    };
    let result = (|| -> io::Result<()> {
        file.write_all(&bytes)?;
        file.flush()?;
        file.sync_all()
    })();
    drop(file);
    if let Err(error) = result {
        drop(RemoveOnDrop(Some(path.to_owned())));
        return Err(error.into());
    }
    Ok(SavedFile {
        hash: sha256_hex(&bytes),
        mtime: modified_millis(fs::metadata(path)),
    })
}

fn is_name_collision(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::AlreadyExists
        || matches!(error.raw_os_error(), Some(80 | 183))
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
                Err(SaveError::Exists)
            ));
            assert_eq!(fs::read(&path).unwrap(), expected);
            fs::remove_file(&path).unwrap();
        }
    }

    #[test]
    fn leftover_temporary_file_does_not_block_the_next_save() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        fs::write(&path, b"original").unwrap();
        let (file, mut leftover) = create_sibling(&path, ".tmp").unwrap();
        let temporary = leftover.path().to_owned();
        drop(file);
        fs::write(&temporary, b"someone else's data").unwrap();
        leftover.0 = None;
        save_markdown(&path, "mine", false, &sha256_hex(b"original"), |_| {}).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"mine");
        assert_eq!(fs::read(&temporary).unwrap(), b"someone else's data");
    }

    #[test]
    fn competing_creation_of_missing_destination_returns_conflict() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        let error = save_markdown(&path, "mine", false, "old", |_| {
            fs::write(&path, b"external").unwrap();
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

    #[cfg(windows)]
    #[test]
    fn external_write_after_final_hash_check_is_restored_and_returns_conflict() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        fs::write(&path, b"old").unwrap();
        let error = save_markdown(&path, "mine", false, &sha256_hex(b"old"), |_| {
            fs::write(&path, b"external\r\n").unwrap();
        })
        .unwrap_err();
        assert_eq!(
            error,
            SaveError::Conflict {
                disk_hash: sha256_hex(b"external\r\n")
            }
        );
        assert_eq!(fs::read(&path).unwrap(), b"external\r\n");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn saves_long_basename_with_short_temporary_and_backup_names() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(format!("{}.md", "a".repeat(240)));
        fs::write(&path, b"old").unwrap();
        save_markdown(&path, "mine", false, &sha256_hex(b"old"), |_| {
            let temporary = fs::read_dir(directory.path())
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| path.extension().is_some_and(|extension| extension == "tmp"))
                .unwrap();
            assert_eq!(temporary.file_name().unwrap().len(), 22);
        })
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"mine");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn locked_temporary_cleanup_does_not_poison_subsequent_saves() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        fs::write(&path, b"old").unwrap();
        let mut held = None;
        let mut leftover = PathBuf::new();
        let error = save_markdown(&path, "mine", false, &sha256_hex(b"old"), |_| {
            leftover = fs::read_dir(directory.path())
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| path.extension().is_some_and(|extension| extension == "tmp"))
                .unwrap();
            held = Some(
                OpenOptions::new()
                    .read(true)
                    .share_mode(1)
                    .open(&leftover)
                    .unwrap(),
            );
        })
        .unwrap_err();
        assert!(matches!(error, SaveError::Io { .. }));
        assert!(leftover.exists());
        // Keep the stale file locked even during the next operation.
        save_markdown(&path, "retry", false, &sha256_hex(b"old"), |_| {}).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"retry");
        assert!(leftover.exists());
        drop(held);
        fs::remove_file(leftover).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn temporary_cleanup_retries_until_a_short_lock_is_released() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        let (file, cleanup) = create_sibling(&path, ".tmp").unwrap();
        let temporary = cleanup.path().to_owned();
        drop(file);
        let held = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&temporary)
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(45));
            drop(held);
        });
        drop(cleanup);
        release.join().unwrap();
        assert!(!temporary.exists());
    }

    #[cfg(windows)]
    #[test]
    fn error_1177_restores_original_from_backup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        let (file, mut backup) = create_sibling(&path, ".bak").unwrap();
        drop(file);
        fs::write(backup.path(), b"original").unwrap();
        let error = recover_failed_replace(&path, &mut backup, io::Error::from_raw_os_error(1177));
        assert!(matches!(error, SaveError::Io { .. }));
        assert_eq!(fs::read(&path).unwrap(), b"original");
        drop(backup);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn error_1177_never_overwrites_a_destination_created_during_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        let (file, mut backup) = create_sibling(&path, ".bak").unwrap();
        drop(file);
        let original_backup = backup.path().to_owned();
        fs::write(&original_backup, b"original").unwrap();
        fs::write(&path, b"new external").unwrap();
        let error = recover_failed_replace(&path, &mut backup, io::Error::from_raw_os_error(1177));
        assert_eq!(
            error,
            SaveError::Conflict {
                disk_hash: sha256_hex(b"new external")
            }
        );
        drop(backup);
        assert_eq!(fs::read(&path).unwrap(), b"new external");
        assert_eq!(fs::read(&original_backup).unwrap(), b"original");
    }

    #[cfg(windows)]
    #[test]
    fn error_1177_reports_backup_path_when_restore_is_locked() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        let (file, mut backup) = create_sibling(&path, ".bak").unwrap();
        drop(file);
        let original_backup = backup.path().to_owned();
        fs::write(&original_backup, b"original").unwrap();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&original_backup)
            .unwrap();
        let error = recover_failed_replace(&path, &mut backup, io::Error::from_raw_os_error(1177));
        assert!(
            matches!(error, SaveError::Io { message } if message.contains(&original_backup.display().to_string()))
        );
        drop(backup);
        assert!(!path.exists());
        assert_eq!(fs::read(&original_backup).unwrap(), b"original");
        drop(held);
    }

    #[cfg(windows)]
    #[test]
    fn conflict_rollback_preserves_an_additional_external_write() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        fs::write(&path, b"later external").unwrap();
        let (file, mut backup) = create_sibling(&path, ".bak").unwrap();
        drop(file);
        fs::write(backup.path(), b"first external").unwrap();
        restore_conflicting_backup(&path, &mut backup, &sha256_hex(b"mine"));
        drop(backup);
        assert_eq!(fs::read(&path).unwrap(), b"first external");
        let retained = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|file| file != &path)
            .unwrap();
        assert_eq!(fs::read(retained).unwrap(), b"later external");
    }

    #[cfg(windows)]
    #[test]
    fn conflict_rollback_failure_preserves_external_backup() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        fs::write(&path, b"mine").unwrap();
        let (file, mut backup) = create_sibling(&path, ".bak").unwrap();
        drop(file);
        let original_backup = backup.path().to_owned();
        fs::write(&original_backup, b"external").unwrap();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        restore_conflicting_backup(&path, &mut backup, &sha256_hex(b"mine"));
        drop(backup);
        assert_eq!(fs::read(&path).unwrap(), b"mine");
        assert_eq!(fs::read(original_backup).unwrap(), b"external");
        drop(held);
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
            serde_json::to_value(SaveError::Exists).unwrap(),
            serde_json::json!({ "kind": "exists" })
        );
        assert_eq!(
            serde_json::to_value(SaveError::Io {
                message: "locked".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "io", "message": "locked" })
        );
    }

    #[test]
    fn recognizes_name_collisions_by_kind_and_windows_error_code() {
        assert!(is_name_collision(&io::Error::new(
            io::ErrorKind::AlreadyExists,
            "localized message"
        )));
        for code in [80, 183] {
            assert!(is_name_collision(&io::Error::from_raw_os_error(code)));
        }
        assert!(!is_name_collision(&io::Error::new(
            io::ErrorKind::PermissionDenied,
            "denied"
        )));
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
