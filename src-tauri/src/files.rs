use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
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
    let body = if has_bom { &bytes[UTF8_BOM.len()..] } else { bytes };
    let text = std::str::from_utf8(body)
        .map_err(|_| ReadError::NotUtf8)?
        .to_owned();
    Ok((text, has_bom))
}

/// ファイルをバイト列で読み、UTF-8検証・BOM除去・SHA-256計算を行う。
pub fn read_open_file(path: &Path) -> Result<OpenedFile, ReadError> {
    let bytes = fs::read(path).map_err(|error| ReadError::Io(error.to_string()))?;
    let (text, has_bom) = decode_markdown(&bytes)?;

    let mtime = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);

    Ok(OpenedFile {
        text,
        has_bom,
        hash: sha256_hex(&bytes),
        mtime,
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
        let error = read_open_file(Path::new("Z:\\definitely\\missing\\file.md"))
            .expect_err("must fail");
        assert!(matches!(error, ReadError::Io(_)));
    }

    #[test]
    fn decode_only_strips_the_bom_at_the_start() {
        let (text, has_bom) = decode_markdown("a\u{FEFF}b".as_bytes()).expect("decode");
        assert!(!has_bom);
        assert_eq!(text, "a\u{FEFF}b");
    }
}
