mod files;
mod binary;
mod prefs;
mod themes;
mod watching;

use std::path::{Path, PathBuf};

use files::{OpenedFile, SaveError, SavedFile};
use tauri::{Emitter, Manager};
use watching::{FileEvent, FileService};

/// ファイルを開き、その親フォルダを資産プロトコルの許可範囲に加える。
#[tauri::command]
fn open_file(
    app: tauri::AppHandle,
    service: tauri::State<'_, FileService>,
    path: String,
) -> Result<OpenedFile, String> {
    let path = PathBuf::from(path);
    let event_app = app.clone();
    let opened = service.open(&path, move |event| {
        let result = match event {
            FileEvent::Changed(payload) => event_app.emit("file-changed", payload),
            FileEvent::Removed(payload) => event_app.emit("file-removed", payload),
            FileEvent::Unreadable(payload) => event_app.emit("file-unreadable", payload),
        };
        if let Err(error) = result {
            eprintln!("File event delivery failed: {error}");
        }
    })?;

    if let Some(parent) = path.parent() {
        allow_asset_directory(&app, parent);
    }

    Ok(opened)
}

#[tauri::command]
fn save_file(
    service: tauri::State<'_, FileService>,
    path: String,
    text: String,
    has_bom: bool,
    expected_hash: String,
) -> Result<SavedFile, SaveError> {
    service.save(Path::new(&path), &text, has_bom, &expected_hash)
}

#[tauri::command]
fn write_new_file(
    service: tauri::State<'_, FileService>,
    path: String,
    text: String,
    has_bom: bool,
) -> Result<SavedFile, SaveError> {
    service.write_new(Path::new(&path), &text, has_bom)
}

#[tauri::command]
fn stop_watching(
    service: tauri::State<'_, FileService>,
    path: Option<String>,
) -> Result<(), String> {
    if let Some(path) = path {
        service.stop_path(Path::new(&path))
    } else {
        service.stop();
        Ok(())
    }
}

/// 開いたMarkdownの近くにあるMarpのテーマ設定を読み、
/// 読み込んだCSSのフォルダを資産プロトコルの許可範囲に加える。
#[tauri::command]
fn read_theme_config(app: tauri::AppHandle, markdown_path: String) -> themes::ThemeConfig {
    let config = themes::read_theme_config(Path::new(&markdown_path));
    for theme in &config.themes {
        if let Some(parent) = Path::new(&theme.path).parent() {
            allow_asset_directory(&app, parent);
        }
    }
    config
}

/// 親フォルダ以下（画像サブフォルダを含む）を資産プロトコルで読めるようにする。
fn allow_asset_directory(app: &tauri::AppHandle, directory: &Path) {
    if let Err(error) = app.asset_protocol_scope().allow_directory(directory, true) {
        eprintln!(
            "資産プロトコルの許可範囲を追加できません ({}): {error}",
            directory.display()
        );
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(FileService::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            binary::write_binary,
            open_file,
            save_file,
            write_new_file,
            stop_watching,
            read_theme_config,
            prefs::recent_files_get,
            prefs::recent_files_add,
            prefs::settings_get,
            prefs::settings_set,
        ])
        .build(tauri::generate_context!())
        .expect("SlideAppの起動に失敗しました")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<FileService>().stop();
            }
        });
}
