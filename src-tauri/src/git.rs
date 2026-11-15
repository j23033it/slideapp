use crate::files::sha256_hex;
use serde::Serialize;
use std::{
    ffi::OsStr,
    fs,
    io::{Read, Write},
    path::Path,
    process::{Command, Output, Stdio},
    thread,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    kind: &'static str,
    branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitError {
    Conflict,
    Error { message: String },
}
#[derive(Serialize)]
pub struct CommitResult {
    commit: String,
}

fn error(message: impl Into<String>) -> GitError {
    GitError::Error {
        message: message.into(),
    }
}

// Drain both pipes concurrently so a verbose hook cannot block the child process.
fn run_git(dir: &Path, args: &[&OsStr], input: Option<&str>) -> Result<Output, std::io::Error> {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.spawn()?;
    if let Some(input) = input {
        let mut stdin = child.stdin.take().unwrap();
        let bytes = input.as_bytes().to_vec();
        thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        });
    }
    let mut stdout = child.stdout.take().unwrap();
    let out = thread::spawn(move || {
        let mut data = Vec::new();
        let _ = stdout.read_to_end(&mut data);
        data
    });
    let mut stderr = child.stderr.take().unwrap();
    let err = thread::spawn(move || {
        let mut data = Vec::new();
        let _ = stderr.read_to_end(&mut data);
        data
    });
    let status = child.wait()?;
    Ok(Output {
        status,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}
fn args<'a>(values: &'a [&'a str]) -> Vec<&'a OsStr> {
    values.iter().map(OsStr::new).collect()
}
fn output_error(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr)
        .trim_end()
        .to_owned()
}
fn location(path: &Path) -> Result<(&Path, &OsStr), GitError> {
    Ok((
        path.parent().ok_or_else(|| error("Invalid path"))?,
        path.file_name().ok_or_else(|| error("Invalid path"))?,
    ))
}
fn status(path: &Path) -> Result<(GitStatus, bool), GitError> {
    let (dir, file) = location(path)?;
    let mut a = args(&[
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--ignored=matching",
        "--untracked-files=all",
        "--",
    ]);
    a.push(file);
    let output = match run_git(dir, &a, None) {
        Ok(output) => output,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((
                GitStatus {
                    kind: "unavailable",
                    branch: None,
                    message: None,
                },
                false,
            ))
        }
        Err(e) => {
            return Ok((
                GitStatus {
                    kind: "error",
                    branch: None,
                    message: Some(e.to_string()),
                },
                false,
            ))
        }
    };
    if !output.status.success() {
        let check = run_git(dir, &args(&["rev-parse", "--is-inside-work-tree"]), None);
        let outside = matches!(check, Ok(ref result) if !result.status.success());
        return Ok((
            GitStatus {
                kind: if outside { "outside" } else { "error" },
                branch: None,
                message: if outside {
                    None
                } else {
                    Some(output_error(&output))
                },
            },
            false,
        ));
    }
    let mut branch = None;
    let mut kind = "clean";
    let mut untracked = false;
    let mut entries = output.stdout.split(|b| *b == 0);
    while let Some(entry) = entries.next() {
        if let Some(name) = entry.strip_prefix(b"# branch.head ") {
            if name != b"(detached)" {
                branch = Some(String::from_utf8_lossy(name).into_owned());
            }
        } else if entry.starts_with(b"! ") {
            kind = "ignored";
        } else if entry.starts_with(b"? ") {
            kind = "changed";
            untracked = true;
        } else if entry.starts_with(b"2 ") {
            kind = "changed";
            entries.next();
        } else if entry.starts_with(b"1 ") || entry.starts_with(b"u ") {
            kind = "changed";
        }
    }
    Ok((
        GitStatus {
            kind,
            branch,
            message: None,
        },
        untracked,
    ))
}
fn commit(path: &Path, message: &str, expected_hash: &str) -> Result<CommitResult, GitError> {
    if message.trim().is_empty() {
        return Err(error("Empty commit message"));
    }
    let bytes = fs::read(path).map_err(|e| error(e.to_string()))?;
    if sha256_hex(&bytes) != expected_hash {
        return Err(GitError::Conflict);
    }
    let (state, untracked) = status(path)?;
    if state.kind != "changed" {
        return Err(error(
            state.message.unwrap_or_else(|| state.kind.to_owned()),
        ));
    }
    let (dir, file) = location(path)?;
    if untracked {
        let mut a = args(&["add", "--"]);
        a.push(file);
        let output = run_git(dir, &a, None).map_err(|e| error(e.to_string()))?;
        if !output.status.success() {
            return Err(error(output_error(&output)));
        }
    }
    let mut a = args(&["commit", "--only", "-F", "-", "--"]);
    a.push(file);
    let output = run_git(dir, &a, Some(message)).map_err(|e| error(e.to_string()))?;
    if !output.status.success() {
        return Err(error(output_error(&output)));
    }
    let output = run_git(dir, &args(&["rev-parse", "--short", "HEAD"]), None)
        .map_err(|e| error(e.to_string()))?;
    if !output.status.success() {
        return Err(error(output_error(&output)));
    }
    Ok(CommitResult {
        commit: String::from_utf8_lossy(&output.stdout).trim().to_owned(),
    })
}
#[tauri::command]
pub async fn git_file_status(path: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        status(Path::new(&path))
            .map(|v| v.0)
            .map_err(|e| format!("{e:?}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn git_commit_file(
    path: String,
    message: String,
    expected_hash: String,
) -> Result<CommitResult, GitError> {
    tauri::async_runtime::spawn_blocking(move || commit(Path::new(&path), &message, &expected_hash))
        .await
        .map_err(|e| error(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, sync::Once};
    use tempfile::TempDir;

    fn repo() -> TempDir {
        static CONFIG: Once = Once::new();
        CONFIG.call_once(|| {
            std::env::set_var(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            );
            std::env::set_var(
                "GIT_CONFIG_SYSTEM",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            );
            std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        });
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        git(dir.path(), &["config", "user.name", "SlideApp Test"]);
        git(
            dir.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        git(dir.path(), &["config", "commit.gpgsign", "false"]);
        dir
    }
    fn git(dir: &Path, values: &[&str]) -> Output {
        let out = run_git(dir, &args(values), None).unwrap();
        assert!(
            out.status.success(),
            "git {:?}: {}",
            values,
            output_error(&out)
        );
        out
    }
    fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, text).unwrap();
        p
    }
    fn do_commit(path: &Path, message: &str) -> Result<CommitResult, GitError> {
        commit(path, message, &sha256_hex(&fs::read(path).unwrap()))
    }
    #[test]
    fn states_and_detached_head() {
        let outside = tempfile::tempdir().unwrap();
        let file = write(outside.path(), "outside.md", "x");
        assert_eq!(status(&file).unwrap().0.kind, "outside");
        let repo = repo();
        let dir = repo.path();
        let file = write(dir, "slide.md", "first");
        assert_eq!(status(&file).unwrap().0.kind, "changed");
        do_commit(&file, "initial").unwrap();
        assert_eq!(status(&file).unwrap().0.kind, "clean");
        fs::write(&file, "changed").unwrap();
        assert_eq!(status(&file).unwrap().0.kind, "changed");
        write(dir, ".gitignore", "ignored.md\n");
        let ignored = write(dir, "ignored.md", "x");
        assert_eq!(status(&ignored).unwrap().0.kind, "ignored");
        git(dir, &["checkout", "--detach", "-q"]);
        assert_eq!(status(&file).unwrap().0.branch, None);
    }
    #[test]
    fn commits_only_target_and_preserves_staged_changes() {
        let repo = repo();
        let dir = repo.path();
        let a = write(dir, "a.md", "a1");
        let b = write(dir, "b.md", "b1");
        git(dir, &["add", "--", "a.md", "b.md"]);
        git(dir, &["commit", "-qm", "initial"]);
        fs::write(&a, "a2").unwrap();
        fs::write(&b, "b2").unwrap();
        git(dir, &["add", "--", "b.md"]);
        do_commit(&a, "target").unwrap();
        assert_eq!(git(dir, &["show", "HEAD:a.md"]).stdout, b"a2");
        assert_eq!(git(dir, &["show", "HEAD:b.md"]).stdout, b"b1");
        assert_eq!(git(dir, &["show", ":b.md"]).stdout, b"b2");
    }
    #[test]
    fn initial_commit_literal_name_and_multiline_message() {
        let repo = repo();
        let dir = repo.path();
        let file = write(dir, "日本 語 [one].md", "one");
        let other = write(dir, "日本 語 o.md", "other");
        do_commit(&file, "first line\n\nsecond line\n").unwrap();
        assert_eq!(
            git(dir, &["log", "-1", "--format=%B"]).stdout,
            b"first line\n\nsecond line\n\n"
        );
        assert_eq!(status(&other).unwrap().0.kind, "changed");
        #[cfg(not(windows))]
        {
            let star = write(dir, "literal *.md", "star");
            do_commit(&star, "star").unwrap();
            assert_eq!(status(&other).unwrap().0.kind, "changed");
        }
    }
    #[test]
    fn commit_drains_large_hook_output_while_writing_message() {
        let repo = repo();
        let dir = repo.path();
        let file = write(dir, "slide.md", "one");
        let hook = dir.join(".git/hooks/pre-commit");
        fs::write(
            &hook,
            "#!/bin/sh\ni=0\nwhile [ \"$i\" -lt 3000 ]; do\n  printf 'stdout:01234567890123456789012345678901234567890123456789\\n'\n  printf 'stderr:01234567890123456789012345678901234567890123456789\\n' >&2\n  i=$((i + 1))\ndone\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }
        git(dir, &["add", "--", "slide.md"]);
        let output = run_git(
            dir,
            &args(&["commit", "--only", "-F", "-", "--", "slide.md"]),
            Some("message on stdin\n"),
        )
        .unwrap();
        assert!(output.status.success(), "{}", output_error(&output));
        // Git may forward hook stdout through its own stderr.
        assert!(output.stdout.len() + output.stderr.len() > 300_000);
        assert!(output.stderr.len() > 100_000);
        assert_eq!(
            git(dir, &["log", "-1", "--format=%B"]).stdout,
            b"message on stdin\n\n"
        );
        assert_eq!(git(dir, &["show", "HEAD:slide.md"]).stdout, b"one");
        assert_eq!(fs::read(file).unwrap(), b"one");
    }
    #[test]
    fn conflict_and_failing_hook_do_not_commit() {
        let repo = repo();
        let dir = repo.path();
        let file = write(dir, "slide.md", "one");
        assert!(matches!(
            commit(&file, "no", "wrong"),
            Err(GitError::Conflict)
        ));
        assert!(
            !run_git(dir, &args(&["rev-parse", "--verify", "HEAD"]), None)
                .unwrap()
                .status
                .success()
        );
        do_commit(&file, "initial").unwrap();
        fs::write(&file, "two").unwrap();
        let hook = dir.join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\necho hook-failed >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let result = do_commit(&file, "rejected");
        assert!(
            matches!(result, Err(GitError::Error { message }) if message.contains("hook-failed"))
        );
        assert_eq!(git(dir, &["show", "HEAD:slide.md"]).stdout, b"one");
    }
}
