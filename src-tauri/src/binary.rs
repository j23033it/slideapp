use std::io::Write;
use std::path::Path;

/// Write an export via a sibling temporary file so failed writes leave the target intact.
pub fn write_binary_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let mut temporary = tempfile::Builder::new()
        .prefix(".slideapp-export-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| e.to_string())?;
    temporary.write_all(bytes).map_err(|e| e.to_string())?;
    temporary.flush().map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn write_binary(path: String, bytes: Vec<u8>) -> Result<(), String> {
    write_binary_file(Path::new(&path), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn writes_binary_without_encoding_changes_and_replaces_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("日本語.pptx");
        write_binary_file(&path, &[0, 255, 128, 13, 10]).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), [0, 255, 128, 13, 10]);
        write_binary_file(&path, &[80, 75, 3, 4]).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), [80, 75, 3, 4]);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
    #[test]
    fn failed_persist_cleans_up_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("folder.pptx");
        std::fs::create_dir(&target).unwrap();
        assert!(write_binary_file(&target, &[1, 2]).is_err());
        assert!(target.is_dir());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
