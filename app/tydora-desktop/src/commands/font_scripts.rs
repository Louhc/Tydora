//! 字体文字体系覆盖判定（纯 fontdb + ttf-parser，不依赖 tauri）。
//! 拆出独立模块以便在不链接 tauri 的测试 harness 里直接验证同一份源码。
use fontdb::Database;
use serde::Serialize;
use std::collections::{BTreeSet, HashSet};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontInfo {
    /// CSS font-family 可用的族名（规范名，mark 属性与序列化用它）
    pub family: String,
    /// 是否为等宽字体（用于代码字体优先展示）
    pub monospaced: bool,
    /// 覆盖的文字体系（cmap 实测）：han / kana / hangul / latin / cyrillic /
    /// greek / arabic / hebrew / devanagari / thai。供右键字体菜单按语言筛选。
    pub scripts: Vec<String>,
    /// 本地化族名（name 表）：lang 为 BCP47 主_subtag（zh/en/ja/ko…）。
    /// 菜单按界面语言取对应名字显示（如 zh 显示「微软雅黑」而非 Microsoft YaHei）。
    pub names: Vec<FontLocalName>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontLocalName {
    pub lang: String,
    pub family: String,
}

/// fontdb/ttf-parser 的 Language → BCP47 主_subtag（界面语言匹配用）。
fn lang_tag(lang: &fontdb::Language) -> String {
    match lang.primary_language() {
        "Chinese" => "zh".to_string(),
        "English" => "en".to_string(),
        "Japanese" => "ja".to_string(),
        "Korean" => "ko".to_string(),
        other => other.to_lowercase(),
    }
}

/// 收集一个 face 的本地化族名（每语言取第一条）。
fn face_names(face: &fontdb::FaceInfo) -> Vec<FontLocalName> {
    let mut out: Vec<FontLocalName> = Vec::new();
    for (name, lang) in &face.families {
        let tag = lang_tag(lang);
        if name.is_empty() || out.iter().any(|n| n.lang == tag) {
            continue;
        }
        out.push(FontLocalName { lang: tag, family: name.clone() });
    }
    out
}

/// 各文字体系的判定样本码点：**全部**都有字形才算覆盖。
/// 仅用作「无 OS/2 码页位」时的兜底，以及无码页的天城文（走 Unicode range 位）。
const SCRIPT_SAMPLES: &[(&str, &[u32])] = &[
    ("han", &[0x4E00, 0x6F22, 0x9F8D]),          // 一 漢 龍
    ("kana", &[0x3042, 0x30A2, 0x30FC]),         // あ ア ー
    ("hangul", &[0xAC00, 0xD55C, 0x1100]),       // 가 한 ᄀ
    ("latin", &[0x0041, 0x007A, 0x00E9]),        // A z é
    ("cyrillic", &[0x0410, 0x044F, 0x0401]),     // А я Ё
    ("greek", &[0x0391, 0x03C9, 0x03B1]),        // Α ω α
    ("arabic", &[0x0627, 0x0644, 0x064A]),       // ا ل ي
    ("hebrew", &[0x05D0, 0x05EA, 0x05B0]),       // א ת ְ
    ("devanagari", &[0x0905, 0x0939, 0x094D]),   // अ ह ्
    ("thai", &[0x0E01, 0x0E2F, 0x0E30]),         // ก ฯ ะ
];

/// 与 Windows「按语言筛字体」同判据：OS/2 表 ulCodePageRange 的码页位（GDI charset）。
/// 中文-font 的 cmap 虽含假名，但码页位是 936 而非 932，故不会误入日文 —— 这正是
/// 设置里日文只有 MS Gothic 等数种的原因。位索引（MS OS/2 规范，实测校准）：
/// 0=1252, 2=1251, 3=1253, 5=1255, 6=1256, 16=874, 17=932, 18=936, 19=949, 20=950, 21=1361。
/// 任一命中即算覆盖（如中文 = 简 936 或繁 950）。表内整数为**大端**。
const SCRIPT_CP_BITS: &[(&str, &[u32])] = &[
    ("han", &[18, 20]),
    ("kana", &[17]),
    ("hangul", &[19, 21]),
    ("latin", &[0]),
    ("cyrillic", &[2]),
    ("greek", &[3]),
    ("arabic", &[6]),
    ("hebrew", &[5]),
    ("thai", &[16]),
];

/// OS/2 表内 ulCodePageRange1/2 的字节偏移（v1+ 才有；v0 无码页位 → 兜底 cmap）。
const CP_RANGE1_OFFSET: usize = 78;
const CP_RANGE2_OFFSET: usize = 82;

fn cp_bit(cp: &[u32; 2], bit: u32) -> bool {
    let word = if bit < 32 { cp[0] } else { cp[1] };
    let shift = if bit < 32 { bit } else { bit - 32 };
    (word >> shift) & 1 == 1
}

/// 固定输出顺序（前端筛选芯片按此排列）
pub const SCRIPT_ORDER: &[&str] = &[
    "han", "kana", "hangul", "latin", "cyrillic", "greek", "arabic", "hebrew", "devanagari", "thai",
];

/// name 表本地化族名语言（设计语言）：ja-JP / zh-* / ko-KR 的 Windows LANGID。
const LANG_JA: u16 = 0x0411;
const LANG_KO: u16 = 0x0412;
const LANG_ZH: &[u16] = &[0x0804, 0x0404, 0x0c04, 0x1004, 0x1404];

/// 判定单个 face 覆盖的文字体系，与 Windows「按语言筛字体」同口径：
/// - 非 CJK：OS/2 码页位（GDI charset）；无码页位（OS/2 v0 / 缺表）兜底 cmap 样本。
/// - CJK：码页位 **且** 设计语言匹配 —— 泛 CJK 字体（Noto Sans SC、Malgun 等）虽带
///   932/936 位，但设计语言是 zh/ko，故不会误入日文/中文之外的语言；
///   无任何 CJK 本地化族名时退回纯码页位。
/// - 天城文无 ANSI 码页：走 OS/2 Unicode range 位，缺表兜底 cmap。
fn face_scripts(db: &Database, id: fontdb::ID) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let _ = db.with_face_data(id, |data, index| {
        let Ok(face) = ttf_parser::Face::parse(data, index) else {
            return;
        };
        let os2_raw = face.raw_face().table(ttf_parser::Tag::from_bytes(b"OS/2"));
        let cp: Option<[u32; 2]> = os2_raw.and_then(|raw| {
            if raw.len() < CP_RANGE2_OFFSET + 4 {
                return None;
            }
            Some([
                u32::from_be_bytes(raw[CP_RANGE1_OFFSET..CP_RANGE1_OFFSET + 4].try_into().ok()?),
                u32::from_be_bytes(raw[CP_RANGE2_OFFSET..CP_RANGE2_OFFSET + 4].try_into().ok()?),
            ])
        });
        let cmap = face.tables().cmap;
        let has_glyph = |cp: u32| -> bool {
            cmap.map(|c| c.subtables.into_iter().any(|sub| sub.glyph_index(cp).is_some()))
                .unwrap_or(false)
        };
        // 设计语言：name_id 1/16 的本地化族名语言
        let mut has_ja = false;
        let mut has_zh = false;
        let mut has_ko = false;
        if let Some(nt) = face.tables().name {
            for rec in nt.names {
                if rec.name_id != 1 && rec.name_id != 16 {
                    continue;
                }
                match rec.language_id {
                    LANG_JA => has_ja = true,
                    LANG_KO => has_ko = true,
                    l if LANG_ZH.contains(&l) => has_zh = true,
                    _ => {}
                }
            }
        }
        let any_cjk_name = has_ja || has_zh || has_ko;
        // 无 CJK 本地化族名时按码页主语言单一归属（简/繁 > 韩 > 日），
        // 避免泛 CJK 字体的 en-only face 把 932/936/949 全收进多种语言
        let cjk_primary: Option<&str> = match cp {
            Some(cp) => {
                if cp_bit(&cp, 18) || cp_bit(&cp, 20) {
                    Some("han")
                } else if cp_bit(&cp, 19) || cp_bit(&cp, 21) {
                    Some("hangul")
                } else if cp_bit(&cp, 17) {
                    Some("kana")
                } else {
                    None
                }
            }
            None => None,
        };
        for (name, bits) in SCRIPT_CP_BITS {
            let mut covered = match cp {
                Some(cp) => bits.iter().any(|&b| cp_bit(&cp, b)),
                None => SCRIPT_SAMPLES
                    .iter()
                    .find(|(n, _)| n == name)
                    .map(|(_, samples)| samples.iter().all(|&c| has_glyph(c)))
                    .unwrap_or(false),
            };
            if covered && matches!(*name, "han" | "kana" | "hangul") {
                covered = if any_cjk_name {
                    match *name {
                        "kana" => has_ja,
                        "han" => has_zh,
                        "hangul" => has_ko,
                        _ => true,
                    }
                } else {
                    cjk_primary == Some(*name)
                };
            }
            if covered {
                out.insert((*name).to_string());
            }
        }
        // 天城文无 ANSI 码页：用 OS/2 Unicode range 位（contains_char 判定），缺表兜底 cmap
        let devanagari = match face.tables().os2 {
            Some(os2) => {
                let ranges = os2.unicode_ranges();
                [0x0905u32, 0x0939, 0x094D]
                    .iter()
                    .all(|&c| ranges.contains_char(char::from_u32(c).unwrap_or('\0')))
            }
            None => [0x0905u32, 0x0939, 0x094D].iter().all(|&c| has_glyph(c)),
        };
        if devanagari {
            out.insert("devanagari".to_string());
        }
    });
    out
}

/// 列出本机已安装字体（按族名去重、排序），附 cmap 实测的文字体系覆盖。
pub fn compute() -> Vec<SystemFontInfo> {
    let mut db = Database::new();
    db.load_system_fonts();

    let mut seen: HashSet<String> = HashSet::new();
    // 同一字体文件的别名 face（如 MS Gothic 与 ＭＳ ゴシック）只留一条，
    // 与 Windows 设置「一个字体文件一张卡」同口径
    let mut seen_files: HashSet<String> = HashSet::new();
    // 同文件已有 ASCII 族名 face 时，非 ASCII 族名（全角/本地化别名）不单独成卡
    let ascii_sources: HashSet<String> = db
        .faces()
        .filter_map(|f| f.families.first().map(|(n, _)| (n, f)))
        .filter(|(n, _)| n.is_ascii())
        .map(|(_, f)| format!("{:?}", f.source))
        .collect();
    let mut fonts: Vec<SystemFontInfo> = Vec::new();

    for face in db.faces() {
        let Some((name, _)) = face.families.first() else {
            continue;
        };
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        if !name.is_ascii() && ascii_sources.contains(&format!("{:?}", face.source)) {
            continue;
        }
        if !seen_files.insert(format!("{:?}#{}", face.source, face.index)) {
            continue;
        }
        let scripts = face_scripts(&db, face.id);
        let names = face_names(face);
        // 同一族名只保留一条；monospaced 与 scripts 取各 face 的并集；本地化名每语言取首见
        if !seen.insert(name.clone()) {
            if let Some(existing) = fonts.iter_mut().find(|f| f.family == *name) {
                if face.monospaced {
                    existing.monospaced = true;
                }
                let mut merged: BTreeSet<String> = existing.scripts.iter().cloned().collect();
                merged.extend(scripts);
                existing.scripts = ordered(&merged);
                for n in names {
                    if !existing.names.iter().any(|x| x.lang == n.lang) {
                        existing.names.push(n);
                    }
                }
            }
            continue;
        }
        fonts.push(SystemFontInfo {
            family: name.clone(),
            monospaced: face.monospaced,
            scripts: ordered(&scripts),
            names,
        });
    }

    fonts.sort_by(|a, b| a.family.to_lowercase().cmp(&b.family.to_lowercase()));
    fonts
}

fn ordered(set: &BTreeSet<String>) -> Vec<String> {
    SCRIPT_ORDER
        .iter()
        .filter(|s| set.contains(**s))
        .map(|s| (*s).to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 取证：打印 name_id 1/16 的本地化语言，校准设计语言判据。
    #[test]
    fn debug_name16() {
        let mut db = Database::new();
        db.load_system_fonts();
        for face in db.faces() {
            let Some((name, _)) = face.families.first() else { continue };
            if !["Noto Sans SC", "Malgun Gothic", "MS Gothic", "Yu Gothic", "SimSun"].contains(&name.as_str()) {
                continue;
            }
            let _ = db.with_face_data(face.id, |data, index| {
                let Ok(f) = ttf_parser::Face::parse(data, index) else { return };
                let Some(nt) = f.tables().name else { return };
                let l1: Vec<String> = nt.names.into_iter().filter(|r| r.name_id == 1).map(|r| format!("{:04x}", r.language_id)).collect();
                let l16: Vec<String> = nt.names.into_iter().filter(|r| r.name_id == 16).map(|r| format!("{:04x}", r.language_id)).collect();
                println!("{name} id1=[{}] id16=[{}]", l1.join(","), l16.join(","));
            });
        }
    }

    /// 真实读系统字体 OS/2 码页位 + 设计语言：与 Windows 同判据 —— 中文字体不入日文、
    /// 日文字体（MS Gothic 等）入日文；scripts 有序无重复。
    #[test]
    fn scripts_cover_cjk_and_latin() {
        let fonts = compute();
        assert!(!fonts.is_empty(), "system font list empty");
        assert!(
            fonts.iter().any(|f| f.scripts.iter().any(|s| s == "han")),
            "no CJK-covering font detected"
        );
        if let Some(arial) = fonts.iter().find(|f| f.family == "Arial") {
            assert!(arial.scripts.contains(&"latin".to_string()), "Arial lacks latin");
            assert!(!arial.scripts.contains(&"han".to_string()), "Arial wrongly marked han");
            assert!(!arial.scripts.contains(&"kana".to_string()), "Arial wrongly marked kana");
        }
        // 中文字体 cmap 含假名但码页为 936 → 不得入日文（Windows 同口径）
        for zh in ["SimSun", "Microsoft YaHei", "SimHei", "KaiTi"] {
            if let Some(f) = fonts.iter().find(|f| f.family == zh) {
                assert!(f.scripts.contains(&"han".to_string()), "{zh} lacks han");
                assert!(!f.scripts.contains(&"kana".to_string()), "{zh} wrongly marked kana");
            }
        }
        if let Some(f) = fonts.iter().find(|f| f.family == "MS Gothic") {
            assert!(f.scripts.contains(&"kana".to_string()), "MS Gothic lacks kana");
        }
        // 泛 CJK 字体按设计语言归属：Noto SC 只中文、Malgun 只韩文，均不入日文
        for zh_pan in ["Noto Sans SC", "Noto Serif SC"] {
            if let Some(f) = fonts.iter().find(|f| f.family == zh_pan) {
                assert!(f.scripts.contains(&"han".to_string()), "{zh_pan} lacks han");
                assert!(!f.scripts.contains(&"kana".to_string()), "{zh_pan} wrongly kana");
            }
        }
        if let Some(f) = fonts.iter().find(|f| f.family == "Malgun Gothic") {
            assert!(f.scripts.contains(&"hangul".to_string()), "Malgun lacks hangul");
            assert!(!f.scripts.contains(&"kana".to_string()), "Malgun wrongly kana");
            assert!(!f.scripts.contains(&"han".to_string()), "Malgun wrongly han");
        }
        for f in &fonts {
            let idx: Vec<usize> = f
                .scripts
                .iter()
                .map(|s| SCRIPT_ORDER.iter().position(|o| o == s).expect("unknown script"))
                .collect();
            assert!(idx.windows(2).all(|w| w[0] < w[1]), "scripts not ordered/unique: {}", f.family);
        }
        // 取证输出：各语言族数 + 日文名单（与 Windows 设置对照）
        for s in SCRIPT_ORDER {
            let names: Vec<&str> = fonts
                .iter()
                .filter(|f| f.scripts.iter().any(|x| x == s))
                .map(|f| f.family.as_str())
                .collect();
            println!("[{s}] {} : {}", names.len(), names.join(", "));
        }
    }
}
