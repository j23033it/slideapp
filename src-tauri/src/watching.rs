use crate::files::{self, OpenedFile, SaveError, SavedFile};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_millis(150);
const RETRY_DELAY: Duration = Duration::from_millis(35);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    #[serde(flatten)]
    pub file: OpenedFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemovedFile {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnreadableFile {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileEvent {
    Changed(ChangedFile),
    Removed(RemovedFile),
    Unreadable(UnreadableFile),
}

type EventSink = Arc<dyn Fn(FileEvent) + Send + Sync>;

#[derive(Default)]
pub struct FileService {
    // Serialize open/save/stop. The worker only locks `known`, never `active`.
    active: Mutex<Vec<WatchSession>>,
}

#[derive(Clone)]
struct KnownFile {
    hash: Option<String>,
    removed: bool,
}

enum WatchMessage {
    Event(notify::Result<Event>),
    Stop,
}

struct WatchSession {
    path: PathBuf,
    requested_path: PathBuf,
    known: Arc<Mutex<KnownFile>>,
    sender: mpsc::Sender<WatchMessage>,
    watcher: Option<RecommendedWatcher>,
    worker: Option<JoinHandle<()>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

// Canonicalize the parent, not the target, so a removed file can reappear under
// the same watched name. No directory traversal or recursive watch is performed.
fn absolute_path(path: &Path) -> io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let name = absolute
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing file name"))?;
    Ok(absolute.parent().unwrap().canonicalize()?.join(name))
}

fn same_name(left: &Path, right: &Path) -> bool {
    match (left.file_name(), right.file_name()) {
        (Some(left), Some(right)) => {
            #[cfg(windows)]
            {
                use std::os::windows::ffi::OsStrExt;
                use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
                let left: Vec<u16> = left.encode_wide().collect();
                let right: Vec<u16> = right.encode_wide().collect();
                // SAFETY: Both UTF-16 buffers are live and their explicit lengths
                // are bounded by the Windows maximum file-name length.
                unsafe {
                    CompareStringOrdinal(
                        left.as_ptr(),
                        left.len() as i32,
                        right.as_ptr(),
                        right.len() as i32,
                        1,
                    ) == CSTR_EQUAL
                }
            }
            #[cfg(not(windows))]
            {
                left == right
            }
        }
        _ => false,
    }
}

fn same_target(left: &Path, right: &Path) -> bool {
    left.parent() == right.parent() && same_name(left, right)
}

impl FileService {
    pub fn open(
        &self,
        path: &Path,
        emit: impl Fn(FileEvent) + Send + Sync + 'static,
    ) -> Result<OpenedFile, String> {
        let mut active = lock(&self.active);
        let target = absolute_path(path).map_err(|error| error.to_string())?;
        if let Some(watch) = active
            .iter()
            .find(|watch| same_target(&watch.path, &target))
        {
            // Serialize the read and baseline update with save and observation.
            // A failed read leaves the last known state intact.
            let mut known = lock(&watch.known);
            let opened = files::read_open_file(&target).map_err(|error| error.to_string())?;
            known.hash = Some(opened.hash.clone());
            known.removed = false;
            return Ok(opened);
        }
        let (sender, receiver) = mpsc::channel();
        let callback_sender = sender.clone();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = callback_sender.send(WatchMessage::Event(event));
        })
        .map_err(|error| error.to_string())?;
        watcher
            .watch(target.parent().unwrap(), RecursiveMode::NonRecursive)
            .map_err(|error| error.to_string())?;

        // Register before reading: events during the initial read are queued.
        let opened = files::read_open_file(&target).map_err(|error| error.to_string())?;
        let known = Arc::new(Mutex::new(KnownFile {
            hash: Some(opened.hash.clone()),
            removed: false,
        }));
        let worker_known = known.clone();
        let worker_path = target.clone();
        // The frontend uses the exact path passed to open_file to route events.
        let event_path = path.to_string_lossy().into_owned();
        let emit: EventSink = Arc::new(emit);

        let worker = thread::Builder::new()
            .name("slideapp-file-watch".into())
            .spawn(move || {
                watch_loop(receiver, worker_path, event_path, worker_known, emit);
            })
            .map_err(|error| error.to_string())?;
        active.push(WatchSession {
            path: target,
            requested_path: path.to_owned(),
            known,
            sender,
            watcher: Some(watcher),
            worker: Some(worker),
        });
        Ok(opened)
    }

    pub fn save(
        &self,
        path: &Path,
        text: &str,
        has_bom: bool,
        expected_hash: &str,
    ) -> Result<SavedFile, SaveError> {
        let active = lock(&self.active);
        let target = absolute_path(path)?;
        let matching = active
            .iter()
            .find(|watch| same_target(&watch.path, &target));
        let mut known = matching.map(|watch| lock(&watch.known));
        let previous = known.as_ref().map(|known| (**known).clone());
        let result = files::save_markdown(&target, text, has_bom, expected_hash, |hash| {
            if let Some(known) = known.as_mut() {
                known.hash = Some(hash.to_owned());
                known.removed = false;
            }
        });
        if result.is_err() {
            if let (Some(known), Some(previous)) = (known.as_mut(), previous) {
                **known = previous;
            }
        }
        result
    }

    pub fn write_new(
        &self,
        path: &Path,
        text: &str,
        has_bom: bool,
    ) -> Result<SavedFile, SaveError> {
        // Serialize with open/save/stop, but leave the original file monitored.
        let _active = lock(&self.active);
        files::write_new_markdown(&absolute_path(path)?, text, has_bom)
    }

    pub fn stop_path(&self, path: &Path) -> Result<(), String> {
        // Closing must still work after the parent directory itself disappeared.
        let target = absolute_path(path).ok();
        lock(&self.active).retain(|watch| {
            watch.requested_path != path
                && !target
                    .as_ref()
                    .is_some_and(|target| same_target(&watch.path, target))
        });
        Ok(())
    }

    pub fn stop(&self) {
        lock(&self.active).clear();
    }
}

impl Drop for WatchSession {
    fn drop(&mut self) {
        let _ = self.sender.send(WatchMessage::Stop);
        self.watcher.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn watch_loop(
    receiver: mpsc::Receiver<WatchMessage>,
    target: PathBuf,
    event_path: String,
    known: Arc<Mutex<KnownFile>>,
    emit: EventSink,
) {
    let mut deadline: Option<Instant> = None;
    let mut retry_delay = RETRY_DELAY;
    let mut retrying = false;
    let mut unreadable_reported = false;
    loop {
        let message = match deadline {
            Some(at) => receiver.recv_timeout(at.saturating_duration_since(Instant::now())),
            None => receiver
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        match message {
            Ok(WatchMessage::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Ok(WatchMessage::Event(Ok(event))) => {
                if !matches!(event.kind, EventKind::Access(_))
                    && event.paths.iter().any(|path| same_name(path, &target))
                {
                    let debounce = Instant::now() + DEBOUNCE;
                    // Notifications while retrying must not restart the backoff
                    // or postpone a retry indefinitely.
                    deadline = Some(if retrying {
                        deadline.map_or(debounce, |pending| pending.min(debounce))
                    } else {
                        debounce
                    });
                }
            }
            Ok(WatchMessage::Event(Err(error))) => {
                emit(FileEvent::Unreadable(UnreadableFile {
                    path: event_path.clone(),
                    message: error.to_string(),
                }));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                deadline = None;
                let mut known = lock(&known);
                // Read and emit under the same lock used by open/save; an older
                // read must not be emitted after either advances the known hash.
                // Keep short sharing violations silent, then report once while
                // continuing to retry. The wait happens in recv_timeout, outside
                // this lock, so Stop/open/save never wait for an entire retry loop.
                let report_unreadable = retry_delay >= RETRY_DELAY * 16 && !unreadable_reported;
                retrying = observe_file(&target, &event_path, &mut known, &emit, report_unreadable);
                if retrying {
                    unreadable_reported |= report_unreadable;
                    deadline = Some(Instant::now() + retry_delay);
                    retry_delay = (retry_delay * 2).min(MAX_RETRY_DELAY);
                } else {
                    retry_delay = RETRY_DELAY;
                    unreadable_reported = false;
                }
            }
        }
    }
}

// Return true when an OS read failure needs another interruptible retry.
fn observe_file(
    target: &Path,
    event_path: &str,
    known: &mut KnownFile,
    emit: &EventSink,
    report_unreadable: bool,
) -> bool {
    let result = files::read_bytes(target);
    let retry = result.is_err();
    match result {
        Ok((bytes, mtime)) => {
            let hash = files::sha256_hex(&bytes);
            known.removed = false;
            if known.hash.as_ref() == Some(&hash) {
                return false;
            }
            known.hash = Some(hash.clone());
            match files::decode_markdown(&bytes) {
                Ok((text, has_bom)) => emit(FileEvent::Changed(ChangedFile {
                    path: event_path.into(),
                    file: OpenedFile {
                        text,
                        has_bom,
                        hash,
                        mtime,
                    },
                })),
                Err(error) => emit(FileEvent::Unreadable(UnreadableFile {
                    path: event_path.into(),
                    message: error.to_string(),
                })),
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if !known.removed {
                known.removed = true;
                known.hash = None;
                emit(FileEvent::Removed(RemovedFile {
                    path: event_path.into(),
                }));
            }
        }
        Err(error) if report_unreadable => emit(FileEvent::Unreadable(UnreadableFile {
            path: event_path.into(),
            message: error.to_string(),
        })),
        Err(_) => {}
    }
    retry
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    const EVENT_TIMEOUT: Duration = Duration::from_secs(5);
    const QUIET_PERIOD: Duration = Duration::from_millis(550);

    fn watching() -> (
        TempDir,
        PathBuf,
        FileService,
        OpenedFile,
        mpsc::Receiver<FileEvent>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deck.md");
        fs::write(&path, b"initial\r\n").unwrap();
        let service = FileService::default();
        let (sender, receiver) = mpsc::channel();
        let opened = service
            .open(&path, move |event| {
                sender.send(event).unwrap();
            })
            .unwrap();
        (directory, path, service, opened, receiver)
    }

    fn no_event(receiver: &mpsc::Receiver<FileEvent>) {
        assert!(
            matches!(
                receiver.recv_timeout(QUIET_PERIOD),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "unexpected file event"
        );
    }

    fn changed(receiver: &mpsc::Receiver<FileEvent>) -> ChangedFile {
        match receiver
            .recv_timeout(EVENT_TIMEOUT)
            .expect("file-changed event")
        {
            FileEvent::Changed(changed) => changed,
            event => panic!("expected changed, got {event:?}"),
        }
    }

    // Keep the real worker, but deliver notifications explicitly so it cannot
    // observe an intermediate write before the test finishes reopening the file.
    fn manual_notifications(service: &FileService) -> mpsc::Sender<WatchMessage> {
        let mut active = lock(&service.active);
        let watch = &mut active[0];
        watch.watcher.take();
        watch.sender.clone()
    }

    #[test]
    fn reopening_a_watched_file_detects_a_return_to_the_previous_contents() {
        let (_directory, path, service, opened, receiver) = watching();
        let notifications = manual_notifications(&service);
        fs::write(&path, b"external\r\n").unwrap();
        let reopened = service
            .open(&path, |_| {
                panic!("reopening must preserve the original event sink")
            })
            .unwrap();
        assert_eq!(reopened.text, "external\r\n");
        assert_ne!(reopened.hash, opened.hash);

        // The external writer restores A before the pending observation of B.
        fs::write(&path, b"initial\r\n").unwrap();
        notifications
            .send(WatchMessage::Event(Ok(Event::new(EventKind::Modify(
                notify::event::ModifyKind::Any,
            ))
            .add_path(path.clone()))))
            .unwrap();
        let event = changed(&receiver);
        assert_eq!(event.path, path.to_string_lossy());
        assert_eq!(event.file.text, opened.text);
        assert_eq!(event.file.hash, opened.hash);
        no_event(&receiver);
    }

    #[test]
    fn failed_reopening_preserves_the_known_hash_and_removed_state() {
        let (_directory, path, service, opened, _receiver) = watching();
        let _notifications = manual_notifications(&service);
        fs::write(&path, [0xFF, 0xFE]).unwrap();
        assert!(service.open(&path, |_| {}).is_err());
        {
            let active = lock(&service.active);
            let known = lock(&active[0].known);
            assert_eq!(known.hash.as_ref(), Some(&opened.hash));
            assert!(!known.removed);
        }

        fs::remove_file(&path).unwrap();
        assert!(service.open(&path, |_| {}).is_err());
        let active = lock(&service.active);
        let known = lock(&active[0].known);
        assert_eq!(known.hash.as_ref(), Some(&opened.hash));
        assert!(!known.removed);
    }

    #[test]
    fn reopening_a_reappeared_file_clears_the_removed_state() {
        let (_directory, path, service, _opened, _receiver) = watching();
        let _notifications = manual_notifications(&service);
        fs::remove_file(&path).unwrap();
        let known = lock(&service.active)[0].known.clone();
        {
            let emit: EventSink = Arc::new(|_| {});
            assert!(observe_file(
                &path,
                &path.to_string_lossy(),
                &mut lock(&known),
                &emit,
                false,
            ));
        }
        assert!(service.open(&path, |_| {}).is_err());
        {
            let known = lock(&known);
            assert!(known.hash.is_none());
            assert!(known.removed);
        }

        fs::write(&path, b"reappeared\r\n").unwrap();
        let reopened = service.open(&path, |_| {}).unwrap();
        let known = lock(&known);
        assert_eq!(known.hash.as_ref(), Some(&reopened.hash));
        assert!(!known.removed);
    }

    #[test]
    fn own_saves_are_silent_and_external_write_emits_once() {
        let (_directory, path, service, opened, receiver) = watching();
        let saved = service.save(&path, "mine\r\n", true, &opened.hash).unwrap();
        no_event(&receiver);
        fs::write(&path, b"\xEF\xBB\xBFexternal\r\n").unwrap();
        let event = changed(&receiver);
        assert_eq!(event.path, path.to_string_lossy());
        assert_eq!(event.file.text, "external\r\n");
        assert!(event.file.has_bom);
        assert!(event.file.mtime > 0);
        assert_ne!(event.file.hash, saved.hash);
        no_event(&receiver);
        // Repeated OS notifications/writes of identical bytes remain silent.
        fs::write(&path, b"\xEF\xBB\xBFexternal\r\n").unwrap();
        no_event(&receiver);
    }

    #[test]
    fn deletion_emits_once_and_reappearance_is_detected() {
        let (_directory, path, _service, _opened, receiver) = watching();
        fs::remove_file(&path).unwrap();
        assert_eq!(
            receiver.recv_timeout(EVENT_TIMEOUT).unwrap(),
            FileEvent::Removed(RemovedFile {
                path: path.to_string_lossy().into_owned()
            })
        );
        no_event(&receiver);
        fs::write(&path, b"initial\r\n").unwrap();
        assert_eq!(changed(&receiver).file.text, "initial\r\n");
        no_event(&receiver);
    }

    #[test]
    fn replacement_save_is_detected_and_unrelated_files_are_ignored() {
        let (directory, path, _service, _opened, receiver) = watching();
        let replacement = directory.path().join("replacement.md");
        fs::write(&replacement, b"replacement\r\n").unwrap();
        no_event(&receiver);
        // Model editors that stage another file and rename it into place.
        fs::remove_file(&path).unwrap();
        fs::rename(&replacement, &path).unwrap();
        assert_eq!(changed(&receiver).file.text, "replacement\r\n");
        no_event(&receiver);
    }

    #[test]
    fn invalid_utf8_emits_unreadable_and_can_recover() {
        let (_directory, path, _service, _opened, receiver) = watching();
        fs::write(&path, [0xFF, 0xFE]).unwrap();
        match receiver.recv_timeout(EVENT_TIMEOUT).unwrap() {
            FileEvent::Unreadable(event) => {
                assert_eq!(event.path, path.to_string_lossy());
                assert!(!event.message.is_empty());
            }
            event => panic!("expected unreadable, got {event:?}"),
        }
        no_event(&receiver);
        fs::write(&path, b"readable again").unwrap();
        assert_eq!(changed(&receiver).file.text, "readable again");
    }

    #[test]
    fn opening_another_file_preserves_previous_watch_and_stop_path_is_independent() {
        let (directory, path, service, _opened, old_receiver) = watching();
        let next = directory.path().join("next.md");
        fs::write(&next, b"next").unwrap();
        let (sender, receiver) = mpsc::channel();
        service
            .open(&next, move |event| {
                sender.send(event).unwrap();
            })
            .unwrap();
        fs::write(&path, b"first external").unwrap();
        assert_eq!(changed(&old_receiver).file.text, "first external");
        no_event(&receiver);
        service.stop_path(&path).unwrap();
        fs::write(&path, b"after close").unwrap();
        assert!(old_receiver.recv_timeout(QUIET_PERIOD).is_err());
        fs::write(&next, b"changed next").unwrap();
        assert_eq!(changed(&receiver).file.text, "changed next");
        service.stop();
        fs::write(&next, b"after stop").unwrap();
        assert!(receiver.recv_timeout(QUIET_PERIOD).is_err());
        service.stop();
    }

    #[test]
    fn closing_after_parent_directory_is_removed_stops_the_watch() {
        let (directory, path, service, _opened, _receiver) = watching();
        fs::remove_file(&path).unwrap();
        fs::remove_dir(directory.path()).unwrap();
        service.stop_path(&path).unwrap();
        assert!(lock(&service.active).is_empty());
    }

    #[test]
    fn own_save_on_one_file_does_not_suppress_another_file() {
        let (directory, path, service, opened, receiver) = watching();
        let next = directory.path().join("next.md");
        fs::write(&next, b"initial\r\n").unwrap();
        let (sender, next_receiver) = mpsc::channel();
        let next_opened = service
            .open(&next, move |event| {
                sender.send(event).unwrap();
            })
            .unwrap();
        service.save(&path, "same", false, &opened.hash).unwrap();
        fs::write(&next, b"same").unwrap();
        assert_eq!(changed(&next_receiver).file.text, "same");
        no_event(&receiver);
        service
            .save(
                &next,
                "second own save",
                false,
                &files::read_open_file(&next).unwrap().hash,
            )
            .unwrap();
        fs::write(&path, b"second own save").unwrap();
        assert_eq!(changed(&receiver).file.text, "second own save");
        no_event(&next_receiver);
        assert_eq!(opened.hash, next_opened.hash);
    }

    #[test]
    fn failed_save_restores_the_known_hash_for_external_notifications() {
        let (_directory, path, service, opened, receiver) = watching();
        fs::write(&path, b"external").unwrap();
        assert!(matches!(
            service.save(&path, "mine", false, &opened.hash),
            Err(SaveError::Conflict { .. })
        ));
        assert_eq!(changed(&receiver).file.text, "external");
        no_event(&receiver);
    }

    #[cfg(windows)]
    #[test]
    fn temporarily_locked_files_are_retried() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_directory, path, _service, _opened, receiver) = watching();
        fs::write(&path, b"after lock").unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        // The first read happens at ~150 ms; unlock before retries are exhausted.
        thread::sleep(Duration::from_millis(210));
        drop(held);
        assert_eq!(changed(&receiver).file.text, "after lock");
        no_event(&receiver);
    }

    #[cfg(windows)]
    #[test]
    fn lock_longer_than_the_old_retry_limit_still_emits_after_unlock() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_directory, path, _service, _opened, receiver) = watching();
        fs::write(&path, b"external after long lock").unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(matches!(
            receiver.recv_timeout(EVENT_TIMEOUT).unwrap(),
            FileEvent::Unreadable(_)
        ));
        // Keep it locked beyond the first error notification and several retries.
        // Releasing a read handle generates no new content-change event.
        no_event(&receiver);
        no_event(&receiver);
        drop(held);
        assert_eq!(changed(&receiver).file.text, "external after long lock");
        no_event(&receiver);
    }

    #[cfg(windows)]
    #[test]
    fn retry_waits_do_not_block_save_or_stop() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_directory, path, service, opened, receiver) = watching();
        fs::write(&path, b"locked").unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(matches!(
            receiver.recv_timeout(EVENT_TIMEOUT).unwrap(),
            FileEvent::Unreadable(_)
        ));
        let started = Instant::now();
        assert!(matches!(
            service.save(&path, "mine", false, &opened.hash),
            Err(SaveError::Io { .. })
        ));
        service.stop();
        assert!(started.elapsed() < Duration::from_millis(500));
        drop(held);
        assert!(receiver.recv_timeout(QUIET_PERIOD).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn closing_one_target_cancels_only_its_pending_retry() {
        use std::os::windows::fs::OpenOptionsExt;
        let (directory, path, service, _opened, old_receiver) = watching();
        fs::write(&path, b"locked").unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(matches!(
            old_receiver.recv_timeout(EVENT_TIMEOUT).unwrap(),
            FileEvent::Unreadable(_)
        ));
        let next = directory.path().join("next.md");
        fs::write(&next, b"next").unwrap();
        let (sender, receiver) = mpsc::channel();
        let started = Instant::now();
        service
            .open(&next, move |event| {
                sender.send(event).unwrap();
            })
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(500));
        service.stop_path(&path).unwrap();
        drop(held);
        assert!(old_receiver.recv_timeout(QUIET_PERIOD).is_err());
        fs::write(&next, b"next external").unwrap();
        assert_eq!(changed(&receiver).file.text, "next external");
    }

    #[cfg(windows)]
    #[test]
    fn failed_replace_rolls_back_own_save_suppression() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_directory, path, service, opened, receiver) = watching();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(matches!(
            service.save(&path, "mine", false, &opened.hash),
            Err(SaveError::Io { .. })
        ));
        drop(held);
        no_event(&receiver);
        fs::write(&path, b"mine").unwrap();
        assert_eq!(changed(&receiver).file.text, "mine");
        no_event(&receiver);
    }

    #[test]
    fn rename_away_and_back_keeps_the_parent_watch_active() {
        let (directory, path, _service, _opened, receiver) = watching();
        let renamed = directory.path().join("renamed.md");
        fs::rename(&path, &renamed).unwrap();
        assert!(matches!(
            receiver.recv_timeout(EVENT_TIMEOUT).unwrap(),
            FileEvent::Removed(_)
        ));
        fs::rename(&renamed, &path).unwrap();
        assert_eq!(changed(&receiver).file.text, "initial\r\n");
        no_event(&receiver);
    }

    #[cfg(windows)]
    #[test]
    fn windows_file_name_matching_includes_unicode_case() {
        assert!(same_name(Path::new("DÉCK.md"), Path::new("déck.MD")));
        assert!(!same_name(Path::new("deck.md"), Path::new("another.md")));
    }

    #[test]
    fn changed_payload_is_flattened_and_camel_case() {
        let value = serde_json::to_value(ChangedFile {
            path: "deck.md".into(),
            file: OpenedFile {
                text: "text".into(),
                has_bom: true,
                hash: "hash".into(),
                mtime: 12,
            },
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "path": "deck.md", "text": "text", "hasBom": true, "hash": "hash", "mtime": 12 })
        );
    }
}
