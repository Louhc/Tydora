use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryWithMeta {
    pub name: String,
    pub is_directory: bool,
    pub is_file: bool,
    pub mtime: Option<f64>,
    pub ctime: Option<f64>,
}

#[tauri::command]
pub fn list_dir_with_meta(dir_path: String) -> Result<Vec<DirEntryWithMeta>, String> {
    let path = std::path::Path::new(&dir_path);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let metadata = std::fs::metadata(entry.path()).ok();
        let mtime = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64);
        let ctime = metadata
            .as_ref()
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64);
        entries.push(DirEntryWithMeta {
            name: entry.file_name().to_string_lossy().to_string(),
            is_directory: file_type.is_dir(),
            is_file: file_type.is_file(),
            mtime,
            ctime,
        });
    }
    Ok(entries)
}

/// 递归统计路径占用字节数（目录累加其内容；符号链接按链接自身计，不跟随）。
///
/// `max_bytes` 给一个上限：一旦累计超过它就**提前返回**。回收站只需要判断
/// 「放不放得下 / 该淘汰多少」，没必要为了一个超大目录把整棵子树翻完。
#[tauri::command]
pub fn path_usage(path: String, max_bytes: Option<u64>) -> Result<u64, String> {
    let limit = max_bytes.unwrap_or(u64::MAX);
    Ok(usage_of(std::path::Path::new(&path), limit))
}

fn usage_of(path: &std::path::Path, limit: u64) -> u64 {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let mut total: u64 = 0;
    let entries = match std::fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        total = total.saturating_add(usage_of(&entry.path(), limit));
        if total > limit {
            return total;
        }
    }
    total
}
