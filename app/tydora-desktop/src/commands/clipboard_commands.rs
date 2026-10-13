//! 剪贴板相关命令。
//!
//! `tauri-plugin-clipboard-manager` 只提供 `readText` / `readImage`，**没有**读 HTML 的能力
//! （写有 `writeHtml`，读没有）。而"右键菜单粘贴带格式文本"必须有 HTML，所以这里直接用
//! 该插件底层所使用的 `arboard` 读一次：Windows 走 `CF_HTML`、macOS 走
//! `NSPasteboardTypeHTML`，arboard 会剥掉 CF_HTML 的头部标记、返回 HTML 片段。
//!
//! 走 Rust 侧的好处：**不会触发浏览器的剪贴板读取权限弹窗**
//!（`navigator.clipboard.read()` / `document.execCommand("paste")` 都会弹）。

/// 读取剪贴板中的 HTML。（剪贴板里没有 HTML 时返回 `None`，前端据此退回纯文本路径。）
#[tauri::command]
pub fn read_clipboard_html() -> Result<Option<String>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    match clipboard.get().html() {
        Ok(html) if !html.trim().is_empty() => Ok(Some(html)),
        // 没有 HTML 格式、或内容为空：当作"没有"，交给前端退回纯文本
        _ => Ok(None),
    }
}
