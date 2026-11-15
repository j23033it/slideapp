use std::{fs, io::{self, Write}, path::{Component, Path}};

fn encoded_relative(path: &Path) -> io::Result<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(name) = component else { return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid relative path")); };
        let name = name.to_str().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "non-Unicode path"))?;
        let mut part = String::new();
        for byte in name.bytes() {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) { part.push(byte as char); }
            else { part.push_str(&format!("%{byte:02X}")); }
        }
        parts.push(part);
    }
    if parts.is_empty() { return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty path")); }
    Ok(parts.join("/"))
}

fn import(md: &Path, source: &Path) -> io::Result<String> {
    let source = source.canonicalize()?;
    let extension = source.extension().and_then(|x| x.to_str()).unwrap_or("");
    if !["png", "jpg", "jpeg", "gif", "webp"].iter().any(|x| extension.eq_ignore_ascii_case(x)) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "image-unsupported-type"));
    }
    if !source.is_file() { return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a file")); }
    let base = md.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent"))?.canonicalize()?;
    if let Ok(relative) = source.strip_prefix(&base) { return encoded_relative(relative); }
    let directory = base.join("images");
    fs::create_dir_all(&directory)?;
    if directory.canonicalize()? != directory { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "images directory is redirected")); }
    let name = source.file_name().and_then(|x| x.to_str()).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid file name"))?;
    let safe: String = name.chars().map(|c| if c.is_whitespace() || c.is_control() || "()<>[]#%?\\".contains(c) { '-' } else { c }).collect();
    let safe_path = Path::new(&safe);
    let stem = safe_path.file_stem().and_then(|x| x.to_str()).unwrap_or("image");
    let ext = safe_path.extension().and_then(|x| x.to_str()).unwrap_or("");
    let data = fs::read(&source)?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
    temporary.write_all(&data)?;
    temporary.as_file().sync_all()?;
    for n in 1u32.. {
        let candidate = if n == 1 { safe.clone() } else { format!("{stem}-{n}.{ext}") };
        let dest = directory.join(&candidate);
        match temporary.persist_noclobber(&dest) {
            Ok(_) => return encoded_relative(Path::new("images").join(candidate).as_path()),
            Err(error) => {
                temporary = error.file;
                if error.error.kind() != io::ErrorKind::AlreadyExists { return Err(error.error); }
                // Do not reuse a symlink, even if its contents happen to match.
                if fs::symlink_metadata(&dest)?.file_type().is_file() && fs::read(&dest)? == data {
                    return encoded_relative(Path::new("images").join(candidate).as_path());
                }
            }
        }
    }
    unreachable!()
}

#[tauri::command]
pub fn import_image(md_path: String, source_path: String) -> Result<String, String> {
    import(Path::new(&md_path), Path::new(&source_path)).map_err(|error| {
        if error.to_string() == "image-unsupported-type" { "image-unsupported-type".into() } else { "image-copy-failed".into() }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_copy_dedup_and_normalize() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("deck"); fs::create_dir(&base).unwrap();
        let md = base.join("deck.md"); fs::write(&md, "").unwrap();
        let local = base.join("空 白.png"); fs::write(&local, b"local").unwrap();
        assert_eq!(import(&md, &local).unwrap(), "%E7%A9%BA%20%E7%99%BD.png");
        let outside = temp.path().join("日 本(1)#%.png"); fs::write(&outside, b"one").unwrap();
        let first = import(&md, &outside).unwrap();
        assert_eq!(first, "images/%E6%97%A5-%E6%9C%AC-1---.png");
        assert_eq!(import(&md, &outside).unwrap(), first);
        fs::write(&outside, b"two").unwrap();
        let second = import(&md, &outside).unwrap();
        assert!(second.ends_with("-2.png"));
        assert_eq!(fs::read(base.join("images/日-本-1---.png")).unwrap(), b"one");
        assert!(import(&md, &temp.path().join("x.txt")).is_err());
    }
    #[test]
    fn rejects_unsafe_relative_paths() {
        assert!(encoded_relative(Path::new("../x.png")).is_err());
        assert!(encoded_relative(Path::new("/x.png")).is_err());
    }
}


