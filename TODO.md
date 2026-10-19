# TODO

## 编辑器 · 注音复制 / 粘贴（搁置中，2026-10-18）

**现状**
- 复制**完整**注音 → 粘贴能还原注音（读音、`{{Ruby|…}}` 都对）✓
- 复制**半个**注音 → HTML 通道仍会带上读音 ✗（希望当纯文本 ✓）
- 全选两个注音粘贴时，曾出现"只有后一个注音带读音"✗

**已修复（2026-10-18）**
- 多块/多行粘贴只剩第一段 ✗ → 已修（单块走行内插入、多块整篇插入 ✓）
- Ctrl+V 无反应 ✗ → 已修（keydown 拦截 + 40ms 首试、失败按 80/160ms 重试 ✓；
  根因是按键处理期间剪贴板仍被占用，右键菜单天然在处理之外所以一直正常 ✓）

**已查明的机制（有探针/日志证据）**
- 右键粘贴走 Rust `read_clipboard_html` + `parse` + `insertContent` ✓ 可用；
  Ctrl+V 的 `paste` 事件在 WebView 里是**合成的**（`clipboardData` 为空、`preventDefault` 拦不住），
  已在 `keydown` 阶段拦截 + 延后 30ms 调同一命令 + 250ms 无变化时退回原生粘贴 ✓
- PM 自己的 `pasteHTML` / `parseSlice` 会把注音**压成纯文本** ✗（`parse` 不会）—— 这是"粘贴丢读音"的根因
- "部分选中注音当纯文本"曾用**下标**把 `nodesBetween` 结果与 `.md-ruby` 对应 ✗ →
  错位时把**完整注音也拆掉** → 剪贴板里所有注音都失去 `data-rt` ✗（已回退）
- 正确做法应是**按被选中的文字**匹配（`partialTexts` 集合）✓，但该改动未验证充分，已回退

**下一步**
1. 用"按文字匹配"的版本（而不是下标）重做"半个注音 → 纯文本" ✓；
2. 用 harness 覆盖三种场景：全选 / 只选第二个 / 两个各选一半，断言 `data-rt` 的存在性；
3. 再确认 Ctrl+V 与右键粘贴在**同一场景下结果完全一致**。

## 编辑器 · Ctrl+V 粘贴注音（已解决，2026-10-19）

**结论**：`paste` 事件里**带着完整 HTML** ✓（事务探针实测 `types=["text/plain","text/html"]`、`htmlLen≈297`），
根因是 **ProseMirror 的 `parseSlice` 路径** ✗：它给出的 slice 是 `openStart=2/openEnd=1` 的不对称形状 ✓，
`replaceSelection` 在**起始边界**把行内节点降级 ✗ —— 表现就是"复制多个注音时只有第一个丢读音"✗
（harness 精确复现 ✓：`openStart=2` → 只剩第二个 ✓；`openStart=1` → 两个都在 ✓）。

**修法**：`handlePaste` 里直接取事件的 HTML ✓ → `insertClipboardHtml(editor, html)` ✓
（= `parse` + `insertContent` ✓，与右键粘贴**共用同一份逻辑** ✓），绕开 PM 的 `parseSlice` ✗。

**踩过的三个无效方向（不要再试）**
- `editorProps.clipboardParser` ✗：PM 要求它返回**解析器对象**（不是 slice ✓），且实测无效 ✗；
- `editorProps.transformPasted` ✗：在 app 里**根本没被调用** ✗（日志文件未生成 ✓，TipTap 换掉了这个 prop）；
- 延后 + 重试 + `execCommand("paste")` 兜底 ✗：不稳定 ✗，且用 `doc.content.size` 判断成功会在"等长替换"时误判 → **粘两次** ✗。


**现状**
- **右键 → 粘贴**：走 Rust 读剪贴板 + `parse` + `insertContent` ✓，注音/标题/多段都正常 ✓
- **Ctrl+V**：已**回退为浏览器/PM 原生粘贴** ✓（保证"按了有反应"✓），但注音会丢读音 ✗

**为什么回退**
- WebView 派发的 `paste` 事件是**合成**的：`clipboardData.types` 为空 ✗、`getData` 全空 ✗，
  连 `preventDefault()` 都拦不住浏览器自己的粘贴 ✗
- 于是在 `keydown` 里 `preventDefault` + 调自己的粘贴命令 ✗ —— 但**按键处理期间剪贴板仍被占用** ✗，
  Rust 读回来是 null ✗ → 表现为"按了没反应"✗；加延后/重试也不稳定 ✗
- 期间还踩过一个坑：用 `doc.content.size` 判断"是否粘贴成功"✗ —— **替换等长内容**时长度不变 ✗
  → 误判失败 → 重试 → **同一段被粘贴两次** ✗（已改为比较 `doc` 对象身份 ✓）

**下一步（建议）**
1. 把"读剪贴板"改成**不依赖 Rust 读**：在 `keydown` 时先 `preventDefault` ✓，然后等 `paste` 事件里的
   `clipboardData`（若某版本 WebView 会给出数据 ✓）或改从 `navigator.clipboard.read()` 取（需权限）✗；
2. 或接受现状：**右键粘贴保格式** ✓，Ctrl+V 只做纯文本 ✓（并在 UI 上提示 ✓）；
3. 无论走哪条，都**不要**再在 `paste`/`keydown` 里连环加延后与重试 ✗（已证明不稳定 ✗）。
## 编辑器 · 图片在加载/保存时丢失（未解决）

- 现象：某笔记里的 `![image.png|97](/assets/image-…png)` 在应用**保存**后消失（图片文件本身完好）
- 已排除：Markdown 管线往返（harness 4/4 ✓）、`hardbreak-cleanup`（只删 hardBreak ✓）
- 下一步：在**文件加载完成后**记录文档里 `image` 节点数量，确认是"加载丢"还是"保存丢"