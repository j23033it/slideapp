use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    mem::{size_of, zeroed},
    os::windows::{ffi::OsStringExt, fs::OpenOptionsExt, io::{AsRawHandle, FromRawHandle}},
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    sync::atomic::{AtomicU64, Ordering},
};
use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem::{NtCreateFile, NtSetInformationFile, FileRenameInformation, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_IF, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT}},
    Win32::{Foundation::{HANDLE, OBJ_CASE_INSENSITIVE, UNICODE_STRING}, Storage::FileSystem::*, System::IO::IO_STATUS_BLOCK},
};

#[link(name = "ntdll")]
extern "system" { fn RtlNtStatusToDosError(status: i32) -> u32; }

// All child names are opened relative to an already validated directory handle.
fn open_relative(parent: &File, name: &str, access: u32, disposition: u32, options: u32, share: u32) -> io::Result<File> {
    let mut name: Vec<u16> = name.encode_utf16().collect();
    let len = u16::try_from(name.len() * 2).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file name too long"))?;
    let unicode = UNICODE_STRING { Length: len, MaximumLength: len, Buffer: name.as_mut_ptr() };
    let attributes = OBJECT_ATTRIBUTES { Length: size_of::<OBJECT_ATTRIBUTES>() as u32, RootDirectory: parent.as_raw_handle() as HANDLE, ObjectName: &unicode, Attributes: OBJ_CASE_INSENSITIVE, SecurityDescriptor: null(), SecurityQualityOfService: null() };
    let mut handle = null_mut();
    let mut status_block: IO_STATUS_BLOCK = unsafe { zeroed() };
    let status = unsafe { NtCreateFile(&mut handle, access | SYNCHRONIZE, &attributes, &mut status_block, null(), FILE_ATTRIBUTE_NORMAL, share, disposition, options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT, null(), 0) };
    if status < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32)); }
    Ok(unsafe { File::from_raw_handle(handle) })
}

fn final_path(file: &File) -> io::Result<PathBuf> {
    let mut buffer = vec![0u16; 512];
    loop {
        let n = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle() as HANDLE, buffer.as_mut_ptr(), buffer.len() as u32, 0) } as usize;
        if n == 0 { return Err(io::Error::last_os_error()); }
        if n < buffer.len() { return Ok(PathBuf::from(OsString::from_wide(&buffer[..n]))); }
        buffer.resize(n + 1, 0);
    }
}

fn reject_reparse(file: &File) -> io::Result<()> {
    let mut info: FILE_ATTRIBUTE_TAG_INFO = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandleEx(file.as_raw_handle() as HANDLE, FileAttributeTagInfo, (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(), size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32) } == 0 { return Err(io::Error::last_os_error()); }
    if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "reparse point")); }
    Ok(())
}

fn verify_directory(base: &File, directory: &File) -> io::Result<()> {
    if final_path(directory)? != final_path(base)?.join("images") { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "images directory is redirected")); }
    Ok(())
}

struct Temporary { file: File, committed: bool }
impl Drop for Temporary {
    fn drop(&mut self) {
        if !self.committed {
            let info = FILE_DISPOSITION_INFO { DeleteFile: true };
            unsafe { SetFileInformationByHandle(self.file.as_raw_handle() as HANDLE, FileDispositionInfo, (&info as *const FILE_DISPOSITION_INFO).cast(), size_of::<FILE_DISPOSITION_INFO>() as u32); }
        }
    }
}

fn rename(file: &File, directory: &File, name: &str) -> io::Result<()> {
    let name: Vec<u16> = name.encode_utf16().collect();
    // Vec<usize> supplies the alignment required by FILE_RENAME_INFO.
    let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let bytes = offset + name.len() * 2;
    let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = directory.as_raw_handle() as HANDLE;
        (*info).FileNameLength = (name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), (*info).FileName.as_mut_ptr(), name.len());
        let mut status_block: IO_STATUS_BLOCK = zeroed();
        let status = NtSetInformationFile(file.as_raw_handle() as HANDLE, &mut status_block, info.cast(), bytes as u32, FileRenameInformation);
        if status < 0 { return Err(io::Error::from_raw_os_error(RtlNtStatusToDosError(status) as i32)); }
    }
    Ok(())
}

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

pub(super) fn copy(base_path: &Path, source: &Path, after_check: impl FnOnce(), after_write: impl FnOnce() -> io::Result<()>) -> io::Result<String> {
    // Keep both directories open; every child operation uses these handles.
    // Windows may still allow a directory to be renamed, so recheck its path.
    let base = OpenOptions::new().read(true).access_mode(FILE_READ_ATTRIBUTES).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(base_path)?;
    if final_path(&base)? != base_path { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "base directory changed")); }
    let directory = open_relative(&base, "images", FILE_READ_ATTRIBUTES, FILE_OPEN_IF, FILE_DIRECTORY_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE)?;
    reject_reparse(&directory)?;
    verify_directory(&base, &directory)?;
    after_check();
    verify_directory(&base, &directory)?;

    let name = source.file_name().and_then(|x| x.to_str()).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid file name"))?;
    let safe: String = name.chars().map(|c| if c.is_whitespace() || c.is_control() || "()<>[]#%?\\".contains(c) { '-' } else { c }).collect();
    let safe_path = Path::new(&safe);
    let stem = safe_path.file_stem().and_then(|x| x.to_str()).unwrap_or("image");
    let ext = safe_path.extension().and_then(|x| x.to_str()).unwrap_or("");
    let data = fs::read(source)?;
    let mut temporary = loop {
        let name = format!(".slideapp-{}-{}.tmp", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed));
        match open_relative(&directory, &name, FILE_WRITE_DATA | DELETE, FILE_CREATE, FILE_NON_DIRECTORY_FILE, 0) {
            Ok(file) => break Temporary { file, committed: false },
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    };
    verify_directory(&base, &directory)?;
    temporary.file.write_all(&data)?;
    temporary.file.sync_all()?;
    after_write()?;
    for n in 1u32.. {
        verify_directory(&base, &directory)?;
        let candidate = if n == 1 { safe.clone() } else { format!("{stem}-{n}.{ext}") };
        match rename(&temporary.file, &directory, &candidate) {
            Ok(()) => {
                verify_directory(&base, &directory)?;
                temporary.committed = true;
                return super::encoded_relative(&Path::new("images").join(candidate));
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                match open_relative(&directory, &candidate, FILE_READ_DATA | FILE_READ_ATTRIBUTES, FILE_OPEN, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE) {
                    Ok(mut existing) => {
                        if reject_reparse(&existing).is_ok() && existing.metadata()?.is_file() {
                            let mut contents = Vec::new();
                            existing.read_to_end(&mut contents)?;
                            if contents == data {
                                verify_directory(&base, &directory)?;
                                return super::encoded_relative(&Path::new("images").join(candidate));
                            }
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e),
                }
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"]).arg(link).arg(target)
            .output().unwrap();
        assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stderr));
    }

    #[test]
    fn prevents_directory_swap_after_validation() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("deck");
        let outside = temp.path().join("outside");
        fs::create_dir(&base).unwrap();
        fs::create_dir(&outside).unwrap();
        let images = base.join("images");
        fs::create_dir(&images).unwrap();
        let source = temp.path().join("large.png");
        fs::write(&source, b"image contents").unwrap();
        let moved = base.join("moved");
        let base = base.canonicalize().unwrap();
        let result = copy(&base, &source, || {
            // If the directory could be moved, replace it with the attacker's junction.
            if fs::rename(&images, &moved).is_ok() { junction(&images, &outside); }
        }, || Ok(()));
        assert!(result.is_err());
        assert!(moved.exists());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&moved).unwrap().count(), 0);
    }


    #[test]
    fn prevents_directory_move_after_write() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("deck");
        let outside = temp.path().join("outside");
        fs::create_dir(&base).unwrap();
        fs::create_dir(&outside).unwrap();
        let images = base.join("images");
        fs::create_dir(&images).unwrap();
        let source = temp.path().join("image.png");
        fs::write(&source, b"image contents").unwrap();
        let moved = outside.join("moved");
        let result = copy(&base.canonicalize().unwrap(), &source, || {}, || {
            assert!(fs::rename(&images, &moved).is_err());
            Ok(())
        });
        assert_eq!(result.unwrap(), "images/image.png");
        assert_eq!(fs::read(images.join("image.png")).unwrap(), b"image contents");
        assert_eq!(fs::read_dir(&images).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn removes_temporary_file_on_error_after_write() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("deck");
        fs::create_dir(&base).unwrap();
        let source = temp.path().join("image.png");
        fs::write(&source, b"image contents").unwrap();
        let result = copy(&base.canonicalize().unwrap(), &source, || {}, || {
            Err(io::Error::other("injected failure"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read_dir(base.join("images")).unwrap().count(), 0);
    }

    #[test]
    fn rejects_existing_images_junction() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("deck");
        let outside = temp.path().join("outside");
        fs::create_dir(&base).unwrap();
        fs::create_dir(&outside).unwrap();
        junction(&base.join("images"), &outside);
        let source = temp.path().join("image.png");
        fs::write(&source, b"image contents").unwrap();
        assert!(copy(&base.canonicalize().unwrap(), &source, || {}, || Ok(())).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }
}
