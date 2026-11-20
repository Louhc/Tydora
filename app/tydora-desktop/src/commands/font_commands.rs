use std::sync::OnceLock;

use super::font_scripts::{compute, SystemFontInfo};

/// 列出本机已安装字体（按族名去重、排序），附 cmap 实测的文字体系覆盖。
/// 结果进程级缓存：cmap 解析较贵，而字体在安装期间极少变化。
#[tauri::command]
pub fn list_system_fonts() -> Vec<SystemFontInfo> {
    static CACHE: OnceLock<Vec<SystemFontInfo>> = OnceLock::new();
    CACHE.get_or_init(compute).clone()
}
