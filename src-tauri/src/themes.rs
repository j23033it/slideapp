use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// 読み込むテーマCSSの上限（1MB）
pub const MAX_THEME_CSS_BYTES: u64 = 1024 * 1024;

/// 近い順に探すMarp CLIの設定ファイル
const MARP_RC_NAMES: [&str; 3] = [".marprc.yml", ".marprc.yaml", ".marprc.json"];

/// JSのMarp設定（読まずに警告だけ出す）
const JS_CONFIG_NAMES: [&str; 6] = [
    "marp.config.js",
    "marp.config.cjs",
    "marp.config.mjs",
    "marp.config.ts",
    ".marprc.js",
    ".marprc.cjs",
];

const VSCODE_SETTINGS: [&str; 2] = [".vscode", "settings.json"];

/// 読み込んだテーマCSS1件
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeCss {
    /// CSSファイルの絶対パス
    pub path: String,
    pub css: String,
}

/// `read_theme_config` の戻り値
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeConfig {
    pub themes: Vec<ThemeCss>,
    pub warnings: Vec<String>,
}

/// 開いたMarkdownのフォルダから上へ向かって設定を探し、テーマCSSを読み込む。
/// 最初に見つかった設定だけを使い、`.git` があるフォルダかドライブ直下で探索を止める。
pub fn read_theme_config(markdown_path: &Path) -> ThemeConfig {
    let mut config = ThemeConfig::default();
    let start = match markdown_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => normalize_lexically(parent),
        _ => return config,
    };

    let mut directory = Some(start);
    while let Some(current) = directory {
        warn_js_configs(&current, &mut config.warnings);

        if let Some((base, entries)) = theme_entries_in(&current, &mut config.warnings) {
            for entry in entries {
                for path in resolve_theme_entry(&base, &entry, &mut config.warnings) {
                    push_theme_css(path, &mut config);
                }
            }
            break;
        }

        if current.join(".git").exists() {
            break;
        }
        let parent = current.parent().map(Path::to_path_buf);
        if parent.as_deref() == Some(current.as_path()) {
            break;
        }
        directory = parent;
    }

    config
}

fn warn_js_configs(directory: &Path, warnings: &mut Vec<String>) {
    for name in JS_CONFIG_NAMES {
        let path = directory.join(name);
        if path.is_file() {
            warn(
                warnings,
                format!(
                    "JSのMarp設定は読み込めません。{} の themeSet を使ってください: {}",
                    MARP_RC_NAMES.join(" / "),
                    path.display()
                ),
            );
        }
    }
}

/// 1つのフォルダにある設定からテーマの指定を取り出す。
/// 設定が見つからなければ None、見つかったが読み込めなければ警告を残して None。
fn theme_entries_in(
    directory: &Path,
    warnings: &mut Vec<String>,
) -> Option<(PathBuf, Vec<String>)> {
    for name in MARP_RC_NAMES {
        let path = directory.join(name);
        if !path.is_file() {
            continue;
        }
        match read_marp_rc(&path) {
            Ok(Some(entries)) => return Some((directory.to_path_buf(), entries)),
            Ok(None) => continue,
            Err(message) => {
                warn(
                    warnings,
                    format!("テーマ設定を読み込めません ({}): {message}", path.display()),
                );
            }
        }
    }

    let settings = directory.join(VSCODE_SETTINGS[0]).join(VSCODE_SETTINGS[1]);
    if settings.is_file() {
        // 相対パスはワークスペース（.vscode の親）基準
        match read_vscode_settings(&settings) {
            Ok(Some(entries)) => return Some((directory.to_path_buf(), entries)),
            Ok(None) => {}
            Err(message) => warn(
                warnings,
                format!(
                    "テーマ設定を読み込めません ({}): {message}",
                    settings.display()
                ),
            ),
        }
    }

    None
}

fn read_marp_rc(path: &Path) -> Result<Option<Vec<String>>, String> {
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);

    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        let value: serde_json::Value =
            serde_json::from_str(&strip_jsonc(text)).map_err(|error| error.to_string())?;
        return theme_set_from_value(value.get("themeSet"));
    }

    parse_yaml_theme_set(text)
}

fn read_vscode_settings(path: &Path) -> Result<Option<Vec<String>>, String> {
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let value: serde_json::Value =
        serde_json::from_str(&strip_jsonc(text)).map_err(|error| error.to_string())?;
    theme_set_from_value(
        value
            .get("markdown.marp.themes")
            .or_else(|| value.get("markdown")?.get("marp")?.get("themes")),
    )
}

fn theme_set_from_value(value: Option<&serde_json::Value>) -> Result<Option<Vec<String>>, String> {
    let Some(value) = value else {
        return Ok(None);
    };

    if let Some(text) = value.as_str() {
        return Ok(Some(vec![text.to_owned()]));
    }

    let array = value
        .as_array()
        .ok_or_else(|| "themeSet は文字列か文字列の配列で指定してください".to_owned())?;
    let mut entries = Vec::with_capacity(array.len());
    for item in array {
        let text = item
            .as_str()
            .ok_or_else(|| "themeSet の要素は文字列で指定してください".to_owned())?;
        entries.push(text.to_owned());
    }
    Ok(Some(entries))
}

/// `themeSet`（文字列 / 配列 / ブロックシーケンス / フローシーケンス）だけを読む最小限のYAML解析。
fn parse_yaml_theme_set(text: &str) -> Result<Option<Vec<String>>, String> {
    let lines: Vec<&str> = text.lines().collect();

    for (index, line) in lines.iter().enumerate() {
        let Some((indent, key, rest)) = split_yaml_key(line) else {
            continue;
        };
        if key != "themeSet" {
            continue;
        }

        let rest = strip_yaml_comment(rest).trim();
        if !rest.is_empty() {
            return parse_yaml_value(rest).map(Some);
        }

        let mut entries = Vec::new();
        for line in lines.iter().skip(index + 1) {
            let content = strip_yaml_comment(line);
            let trimmed = content.trim();
            if trimmed.is_empty() {
                continue;
            }

            let item_indent = content.len() - content.trim_start().len();
            if item_indent <= indent {
                break;
            }
            if let Some(item) = trimmed.strip_prefix('-') {
                let value = item.trim();
                if value.is_empty() {
                    return Err("themeSet の要素が空です".to_owned());
                }
                entries.push(parse_yaml_scalar(value)?);
            } else {
                return Err("themeSet は文字列か文字列の配列で指定してください".to_owned());
            }
        }
        return Ok(Some(entries));
    }

    Ok(None)
}

/// 行を `(インデント, キー, 値)` に分ける。引用符内の `:` は区切りにしない。
fn split_yaml_key(line: &str) -> Option<(usize, &str, &str)> {
    let content = strip_yaml_comment(line);
    let indent = content.len() - content.trim_start().len();
    let body = content.trim_start();
    if body.is_empty() || body.starts_with('-') || body.starts_with('#') {
        return None;
    }

    let mut quote: Option<char> = None;
    for (offset, character) in body.char_indices() {
        match quote {
            Some(current) if character == current => quote = None,
            Some(_) => {}
            None if character == '"' || character == '\'' => quote = Some(character),
            None if character == ':' => {
                let key = body[..offset].trim();
                let rest = &body[offset + 1..];
                return Some((indent, key, rest));
            }
            None => {}
        }
    }
    None
}

/// 行末コメント（引用符の外の `#`）を取り除く。
fn strip_yaml_comment(text: &str) -> &str {
    let mut quote: Option<char> = None;
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let character = text[index..].chars().next().unwrap_or('\0');
        match quote {
            Some(current) => {
                if current == '\'' && character == '\'' {
                    // YAMLのシングルクォートは '' でエスケープする
                    if text[index + 1..].starts_with('\'') {
                        index += 2;
                        continue;
                    }
                    quote = None;
                } else if current == '"' && character == '\\' {
                    let step = text[index + 1..]
                        .chars()
                        .next()
                        .map(|next| 1 + next.len_utf8())
                        .unwrap_or(1);
                    index += step;
                    continue;
                } else if character == current {
                    quote = None;
                }
            }
            None => {
                if character == '"' || character == '\'' {
                    quote = Some(character);
                } else if character == '#'
                    && matches!(text[..index].chars().last(), None | Some(' ') | Some('\t'))
                {
                    return &text[..index];
                }
            }
        }
        index += character.len_utf8();
    }
    text
}

fn parse_yaml_value(value: &str) -> Result<Vec<String>, String> {
    let value = value.trim();
    if let Some(body) = value.strip_prefix('[') {
        let body = body
            .strip_suffix(']')
            .ok_or_else(|| "themeSet の配列が閉じていません".to_owned())?;
        let mut entries = Vec::new();
        for item in split_flow_items(body) {
            let item = item.trim();
            if item.is_empty() {
                continue;
            }
            entries.push(parse_yaml_scalar(item)?);
        }
        return Ok(entries);
    }
    Ok(vec![parse_yaml_scalar(value)?])
}

fn split_flow_items(body: &str) -> Vec<&str> {
    let mut items = Vec::new();
    let mut quote: Option<char> = None;
    let mut start = 0;
    let mut index = 0;
    while index < body.len() {
        let character = body[index..].chars().next().unwrap_or('\0');
        match quote {
            Some(current) => {
                if current == '"' && character == '\\' {
                    let step = body[index + 1..]
                        .chars()
                        .next()
                        .map(|next| 1 + next.len_utf8())
                        .unwrap_or(1);
                    index += step;
                    continue;
                }
                if character == current {
                    quote = None;
                }
            }
            None => {
                if character == '"' || character == '\'' {
                    quote = Some(character);
                } else if character == ',' {
                    items.push(&body[start..index]);
                    start = index + character.len_utf8();
                }
            }
        }
        index += character.len_utf8();
    }
    items.push(&body[start..]);
    items
}

fn parse_yaml_scalar(value: &str) -> Result<String, String> {
    let value = strip_yaml_comment(value).trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        return Ok(value[1..value.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\"));
    }
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        return Ok(value[1..value.len() - 1].replace("''", "'"));
    }
    if value.is_empty() {
        return Err("themeSet の要素が空です".to_owned());
    }
    Ok(value.to_owned())
}

/// JSONC（行コメント・ブロックコメント・末尾カンマ）をJSONとして読める形にする。
fn strip_jsonc(text: &str) -> String {
    let without_comments = remove_json_comments(text);
    remove_trailing_commas(&without_comments)
}

fn remove_json_comments(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(character) = chars.next() {
        if in_string {
            output.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }

        if character == '"' {
            in_string = true;
            output.push(character);
            continue;
        }

        if character == '/' {
            match chars.peek() {
                Some('/') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if next == '\n' {
                            output.push('\n');
                            break;
                        }
                    }
                }
                Some('*') => {
                    chars.next();
                    let mut previous = '\0';
                    for next in chars.by_ref() {
                        if previous == '*' && next == '/' {
                            break;
                        }
                        previous = next;
                    }
                }
                _ => output.push(character),
            }
            continue;
        }

        output.push(character);
    }

    output
}

fn remove_trailing_commas(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;

    for (index, character) in text.char_indices() {
        if in_string {
            output.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }

        if character == '"' {
            in_string = true;
            output.push(character);
            continue;
        }

        if character == ',' {
            let next = text[index + 1..].chars().find(|next| !next.is_whitespace());
            if matches!(next, Some('}') | Some(']')) {
                continue;
            }
        }

        output.push(character);
    }

    output
}

/// テーマの指定（ファイル・フォルダ・URL）をCSSファイルのパスへ展開する。
fn resolve_theme_entry(base: &Path, entry: &str, warnings: &mut Vec<String>) -> Vec<PathBuf> {
    let entry = entry.trim();
    if entry.is_empty() {
        return Vec::new();
    }

    if has_url_scheme(entry) {
        warn(
            warnings,
            format!("URLのテーマは読み込めません。ローカルのCSSを指定してください: {entry}"),
        );
        return Vec::new();
    }

    let path = if Path::new(entry).is_absolute() {
        PathBuf::from(entry)
    } else {
        base.join(entry)
    };
    let path = normalize_lexically(&path);

    if path.is_dir() {
        return css_files_in(&path, warnings);
    }

    vec![path]
}

fn has_url_scheme(value: &str) -> bool {
    // Windowsのドライブレター（`C:\`）はスキームではない
    let Some((scheme, rest)) = value.split_once("://") else {
        return false;
    };
    scheme.len() > 1
        && !rest.is_empty()
        && scheme
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "+-.".contains(character))
}

fn css_files_in(directory: &Path, warnings: &mut Vec<String>) -> Vec<PathBuf> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            warn(
                warnings,
                format!(
                    "テーマのフォルダを読み込めません ({}): {error}",
                    directory.display()
                ),
            );
            return Vec::new();
        }
    };

    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("css"))
        })
        .collect();
    files.sort_by(|left, right| {
        left.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
            .cmp(&right.file_name().unwrap_or_default().to_string_lossy().to_lowercase())
    });

    if files.is_empty() {
        warn(
            warnings,
            format!(
                "テーマのフォルダにCSSがありません: {}",
                directory.display()
            ),
        );
    }
    files
}

fn push_theme_css(path: PathBuf, config: &mut ThemeConfig) {
    if config
        .themes
        .iter()
        .any(|theme| same_path(&theme.path, &path))
    {
        return;
    }

    match read_theme_css(&path) {
        Ok(css) => config.themes.push(ThemeCss {
            path: path.to_string_lossy().into_owned(),
            css,
        }),
        Err(message) => warn(&mut config.warnings, message),
    }
}

fn read_theme_css(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path)
        .map_err(|_| format!("テーマCSSが見つかりません: {}", path.display()))?;
    if metadata.len() > MAX_THEME_CSS_BYTES {
        return Err(format!(
            "テーマCSSが1MBを超えています: {}",
            path.display()
        ));
    }

    let bytes = fs::read(path)
        .map_err(|error| format!("テーマCSSを読み込めません ({}): {error}", path.display()))?;
    let css = String::from_utf8(bytes)
        .map_err(|_| format!("テーマCSSがUTF-8ではありません: {}", path.display()))?;
    Ok(css.strip_prefix('\u{feff}').unwrap_or(&css).to_owned())
}

fn same_path(left: &str, right: &Path) -> bool {
    let right = right.to_string_lossy();
    left.eq_ignore_ascii_case(&right)
}

/// `.` と `..` を畳んだパス。存在しないパスでも使える。
fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

fn warn(warnings: &mut Vec<String>, message: String) {
    if !warnings.contains(&message) {
        warnings.push(message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("themes")
            .join(name)
    }

    fn write_file(path: &Path, contents: impl AsRef<[u8]>) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn css(theme: &str) -> String {
        format!("/* @theme {theme} */\nsection {{ background: #fff; }}\n")
    }

    fn theme_names(config: &ThemeConfig) -> Vec<String> {
        config
            .themes
            .iter()
            .map(|theme| {
                Path::new(&theme.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    }

    #[test]
    fn reads_yaml_block_sequence_and_directory() {
        let project = fixture("yaml-project");
        let config = read_theme_config(&project.join("slides").join("deck.md"));

        assert!(config.warnings.is_empty(), "{:?}", config.warnings);
        // フォルダ指定は直下の *.css だけ（nested/gamma.css は含まない）。
        // 同じファイルを2回指定しても1回だけ読み込む。
        assert_eq!(theme_names(&config), ["alpha.css", "beta.css"]);
        assert!(config.themes[0].css.contains("@theme fixture-alpha"));
    }

    #[test]
    fn reads_yaml_flow_sequence_and_yaml_extension() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            &dir.path().join(".marprc.yaml"),
            "themeSet: [\"./themes/a.css\", ./themes/b.css] # フロー\n",
        );
        write_file(&dir.path().join("themes/a.css"), css("flow-a"));
        write_file(&dir.path().join("themes/b.css"), css("flow-b"));
        write_file(&dir.path().join("deck.md"), "# deck");

        let config = read_theme_config(&dir.path().join("deck.md"));
        assert!(config.warnings.is_empty(), "{:?}", config.warnings);
        assert_eq!(theme_names(&config), ["a.css", "b.css"]);
    }

    #[test]
    fn reads_yaml_single_string() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            &dir.path().join(".marprc.yml"),
            "# 設定\nthemeSet: ./themes/one.css\n",
        );
        write_file(&dir.path().join("themes/one.css"), css("single"));
        write_file(&dir.path().join("deck.md"), "# deck");

        let config = read_theme_config(&dir.path().join("deck.md"));
        assert!(config.warnings.is_empty(), "{:?}", config.warnings);
        assert_eq!(theme_names(&config), ["one.css"]);
    }

    #[test]
    fn reads_jsonc_rc_json() {
        let project = fixture("json-project");
        let config = read_theme_config(&project.join("deck.md"));

        assert!(config.warnings.is_empty(), "{:?}", config.warnings);
        assert_eq!(theme_names(&config), ["only.css"]);
        assert!(config.themes[0].css.contains("@theme fixture-json"));
    }

    #[test]
    fn reads_vscode_settings_relative_to_workspace() {
        let project = fixture("vscode-project");
        let config = read_theme_config(&project.join("deck.md"));

        assert!(config.warnings.is_empty(), "{:?}", config.warnings);
        assert_eq!(theme_names(&config), ["one.css", "two.css"]);
        assert!(config.themes[1]
            .path
            .ends_with(&format!("fixtures{}themes{}shared{}two.css", '\\', '\\', '\\')));
    }

    #[test]
    fn uses_the_nearest_config() {
        let dir = tempfile::tempdir().unwrap();
        write_file(&dir.path().join(".marprc.yml"), "themeSet: ./root.css\n");
        write_file(&dir.path().join("root.css"), css("root"));
        write_file(&dir.path().join("sub/.marprc.yml"), "themeSet: ./sub.css\n");
        write_file(&dir.path().join("sub/sub.css"), css("sub"));
        write_file(&dir.path().join("sub/deck.md"), "# deck");

        let config = read_theme_config(&dir.path().join("sub/deck.md"));
        assert_eq!(theme_names(&config), ["sub.css"]);
    }

    #[test]
    fn stops_searching_at_git_directory() {
        let dir = tempfile::tempdir().unwrap();
        write_file(&dir.path().join(".marprc.yml"), "themeSet: ./above.css\n");
        write_file(&dir.path().join("above.css"), css("above"));
        write_file(&dir.path().join("project/.git/HEAD"), "ref: refs/heads/main");
        write_file(&dir.path().join("project/slides/deck.md"), "# deck");

        let config = read_theme_config(&dir.path().join("project/slides/deck.md"));
        assert!(config.themes.is_empty(), "{:?}", config.themes);
    }

    #[test]
    fn warns_about_url_themes() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            &dir.path().join(".marprc.yml"),
            "themeSet:\n  - https://example.com/theme.css\n  - ./local.css\n",
        );
        write_file(&dir.path().join("local.css"), css("local"));
        write_file(&dir.path().join("deck.md"), "# deck");

        let config = read_theme_config(&dir.path().join("deck.md"));
        assert_eq!(theme_names(&config), ["local.css"]);
        assert!(config
            .warnings
            .iter()
            .any(|warning| warning.contains("URL") && warning.contains("example.com")));
    }

    #[test]
    fn warns_about_js_config() {
        let dir = tempfile::tempdir().unwrap();
        write_file(&dir.path().join("marp.config.js"), "module.exports = {}");
        write_file(
            &dir.path().join(".marprc.yml"),
            "themeSet: ./themes/one.css\n",
        );
        write_file(&dir.path().join("themes/one.css"), css("one"));
        write_file(&dir.path().join("deck.md"), "# deck");

        let config = read_theme_config(&dir.path().join("deck.md"));
        assert_eq!(theme_names(&config), ["one.css"]);
        assert!(config
            .warnings
            .iter()
            .any(|warning| warning.contains("JS") && warning.contains("marp.config.js")));
    }

    #[test]
    fn warns_about_missing_css() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            &dir.path().join(".marprc.yml"),
            "themeSet: ./missing.css\n",
        );
        write_file(&dir.path().join("deck.md"), "# deck");

        let config = read_theme_config(&dir.path().join("deck.md"));
        assert!(config.themes.is_empty());
        assert!(config
            .warnings
            .iter()
            .any(|warning| warning.contains("見つかりません") && warning.contains("missing.css")));
    }

    #[test]
    fn warns_about_css_larger_than_one_megabyte() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            &dir.path().join(".marprc.yml"),
            "themeSet: ./large.css\n",
        );
        let mut large = css("large").into_bytes();
        large.resize(MAX_THEME_CSS_BYTES as usize + 1, b'a');
        write_file(&dir.path().join("large.css"), large);
        write_file(&dir.path().join("deck.md"), "# deck");

        let config = read_theme_config(&dir.path().join("deck.md"));
        assert!(config.themes.is_empty());
        assert!(config.warnings.iter().any(|warning| warning.contains("1MB")));
    }

    #[test]
    fn warns_about_non_utf8_css() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            &dir.path().join(".marprc.yml"),
            "themeSet: ./broken.css\n",
        );
        write_file(&dir.path().join("broken.css"), [0xff, 0xfe, 0x00]);
        write_file(&dir.path().join("deck.md"), "# deck");

        let config = read_theme_config(&dir.path().join("deck.md"));
        assert!(config.themes.is_empty());
        assert!(config
            .warnings
            .iter()
            .any(|warning| warning.contains("UTF-8")));
    }

    #[test]
    fn warns_about_directory_without_css() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            &dir.path().join(".marprc.yml"),
            "themeSet: ./themes\n",
        );
        fs::create_dir_all(dir.path().join("themes")).unwrap();
        write_file(&dir.path().join("themes/readme.txt"), "no css");
        write_file(&dir.path().join("deck.md"), "# deck");

        let config = read_theme_config(&dir.path().join("deck.md"));
        assert!(config.themes.is_empty());
        assert!(config
            .warnings
            .iter()
            .any(|warning| warning.contains("CSSがありません")));
    }

    #[test]
    fn warns_about_invalid_theme_set() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            &dir.path().join(".marprc.yml"),
            "themeSet:\n  css: ./themes/one.css\n",
        );
        write_file(&dir.path().join("deck.md"), "# deck");

        let config = read_theme_config(&dir.path().join("deck.md"));
        assert!(config.themes.is_empty());
        assert!(config
            .warnings
            .iter()
            .any(|warning| warning.contains("テーマ設定を読み込めません")));
    }

    #[test]
    fn accepts_bom_and_strips_it() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            &dir.path().join(".marprc.yml"),
            "themeSet: ./bom.css\n",
        );
        write_file(
            &dir.path().join("bom.css"),
            format!("\u{feff}{}", css("bom")).into_bytes(),
        );
        write_file(&dir.path().join("deck.md"), "# deck");

        let config = read_theme_config(&dir.path().join("deck.md"));
        assert_eq!(theme_names(&config), ["bom.css"]);
        assert!(config.themes[0].css.starts_with("/* @theme bom */"));
    }

    #[test]
    fn returns_empty_when_markdown_has_no_parent() {
        let config = read_theme_config(Path::new(""));
        assert!(config.themes.is_empty());
        assert!(config.warnings.is_empty());
    }
}
