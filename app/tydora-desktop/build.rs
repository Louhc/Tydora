fn main() {
    // windows-gnu（MinGW）下的 cdylib 链接修复。
    //
    // Rust 给 cdylib 传的 .def 在该 crate 没有导出符号时是空的，MinGW 的 ld
    // 于是回退成 `--export-all-symbols`，把静态链接进来的全部全局符号都塞进
    // 导出表（本 workspace 约 16 万个），触发：
    //     ld.exe: error: export ordinal too large: 161152
    //
    // 桌面端不使用 tydora_lib.dll（入口是 tydora-desktop.exe），所以对
    // windows-gnu 关掉自动导出即可；MSVC / 其它平台构建不受影响。
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "gnu" {
        println!("cargo:rustc-link-arg-cdylib=-Wl,--exclude-all-symbols");
    }

    tauri_build::build()
}
