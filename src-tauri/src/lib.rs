mod files;
mod prefs;

use std::path::{Path, PathBuf};

use files::OpenedFile;
use tauri::Manager;

/// ファイルを開き、その親フォルダを資産プロトコルの許可範囲に加える。
#[tauri::command]
fn open_file(app: tauri::AppHandle, path: String) -> Result<OpenedFile, String> {
    let path = PathBuf::from(path);
    let opened = files::read_open_file(&path).map_err(|error| error.to_string())?;

    if let Some(parent) = path.parent() {
        allow_asset_directory(&app, parent);
    }

    Ok(opened)
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_file,
            prefs::recent_files_get,
            prefs::recent_files_add,
            prefs::settings_get,
            prefs::settings_set,
        ])
        .run(tauri::generate_context!())
        .expect("SlideAppの起動に失敗しました");
}
