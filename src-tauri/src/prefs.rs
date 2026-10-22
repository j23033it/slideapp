use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_RECENT_FILES: usize = 10;
const RECENT_FILES_FILE: &str = "recent-files.json";
const SETTINGS_FILE: &str = "settings.json";

const MIN_SIDEBAR_WIDTH: u32 = 80;
const MAX_SIDEBAR_WIDTH: u32 = 1000;
const DEFAULT_SIDEBAR_WIDTH: u32 = 180;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: Theme,
    pub sidebar_width: u32,
    pub sidebar_collapsed: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            sidebar_width: DEFAULT_SIDEBAR_WIDTH,
            sidebar_collapsed: false,
        }
    }
}

impl AppSettings {
    fn sanitized(mut self) -> Self {
        self.sidebar_width = self
            .sidebar_width
            .clamp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
        self
    }
}

/// 最近使ったファイルの一覧に1件追加し、重複を除いて最大10件にする。
pub fn merge_recent(mut list: Vec<String>, path: &str) -> Vec<String> {
    list.retain(|existing| !existing.eq_ignore_ascii_case(path));
    list.insert(0, path.to_owned());
    list.truncate(MAX_RECENT_FILES);
    list
}

fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("設定フォルダを取得できません: {error}"))?;
    Ok(directory.join(name))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(value) => Some(value),
        Err(error) => {
            eprintln!("設定ファイルを読めません ({}): {error}", path.display());
            None
        }
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("設定フォルダを作成できません: {error}"))?;
    }

    let text = serde_json::to_string_pretty(value)
        .map_err(|error| format!("設定をJSONにできません: {error}"))?;

    // 一瞬だけ存在する一時ファイル経由で置き換える
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, text).map_err(|error| format!("設定を書き込めません: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("設定を保存できません: {error}")
    })
}

#[tauri::command]
pub fn recent_files_get(app: AppHandle) -> Vec<String> {
    let Ok(path) = config_file(&app, RECENT_FILES_FILE) else {
        return Vec::new();
    };
    read_json::<Vec<String>>(&path)
        .unwrap_or_default()
        .into_iter()
        .take(MAX_RECENT_FILES)
        .collect()
}

#[tauri::command]
pub fn recent_files_add(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let file = config_file(&app, RECENT_FILES_FILE)?;
    let current = read_json::<Vec<String>>(&file).unwrap_or_default();
    let merged = merge_recent(current, &path);
    write_json(&file, &merged)?;
    Ok(merged)
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> AppSettings {
    let Ok(path) = config_file(&app, SETTINGS_FILE) else {
        return AppSettings::default();
    };
    read_json::<AppSettings>(&path)
        .unwrap_or_default()
        .sanitized()
}

#[tauri::command]
pub fn settings_set(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let file = config_file(&app, SETTINGS_FILE)?;
    write_json(&file, &settings.sanitized())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(count: usize) -> Vec<String> {
        (0..count)
            .map(|index| format!("C:\\deck\\slide-{index}.md"))
            .collect()
    }

    #[test]
    fn recent_files_are_limited_to_ten() {
        let list = merge_recent(paths(12), "C:\\deck\\new.md");

        assert_eq!(list.len(), MAX_RECENT_FILES);
        assert_eq!(list[0], "C:\\deck\\new.md");
        assert_eq!(list[1], "C:\\deck\\slide-0.md");
        assert_eq!(list[9], "C:\\deck\\slide-8.md");
    }

    #[test]
    fn recent_files_are_deduplicated_case_insensitively() {
        let list = merge_recent(paths(3), "c:\\DECK\\SLIDE-1.MD");

        assert_eq!(list.len(), 3);
        assert_eq!(list[0], "c:\\DECK\\SLIDE-1.MD");
        assert!(!list.iter().any(|path| path == "C:\\deck\\slide-1.md"));
    }

    #[test]
    fn default_settings_match_the_design() {
        let settings = AppSettings::default();

        assert_eq!(settings.theme, Theme::System);
        assert_eq!(settings.sidebar_width, DEFAULT_SIDEBAR_WIDTH);
        assert!(!settings.sidebar_collapsed);
    }

    #[test]
    fn settings_are_clamped_to_sane_bounds() {
        let too_wide = AppSettings {
            sidebar_width: 5_000,
            ..AppSettings::default()
        }
        .sanitized();
        assert_eq!(too_wide.sidebar_width, MAX_SIDEBAR_WIDTH);

        let too_narrow = AppSettings {
            sidebar_width: 1,
            ..AppSettings::default()
        }
        .sanitized();
        assert_eq!(too_narrow.sidebar_width, MIN_SIDEBAR_WIDTH);
    }

    #[test]
    fn theme_is_serialized_as_lowercase() {
        assert_eq!(serde_json::to_string(&Theme::System).unwrap(), "\"system\"");
        assert_eq!(serde_json::to_string(&Theme::Dark).unwrap(), "\"dark\"");
    }

    #[test]
    fn settings_json_uses_camel_case_keys() {
        let json = serde_json::to_string(&AppSettings::default()).unwrap();

        assert!(json.contains("\"sidebarWidth\""));
        assert!(json.contains("\"sidebarCollapsed\""));
    }
}
