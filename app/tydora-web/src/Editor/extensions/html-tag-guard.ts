/**
 * 「只在 HTML 标签之外做替换」的守卫。
 *
 * 背景（实测事故）：应用的 `#标签` 规则（`extensions/tag.ts`）匹配"空白/行首 + #名字"，
 * 而别处生成的标签里常有 `style="background-color: #ffe58f"` 这种写法 —— 那个 ` #ffe58f`
 * 会被当成标签，于是在别人的标签中间插入 `<span data-tag="…">`，把 `<mark …>` 劈开成
 * `<mark data-color="#ffe58f" …>&lt;span data-tag="ffe58f"&gt;…`，
 * 整串退化成纯文本（表现：高亮消失 / 变成 `&lt;mark …&gt;…` / 颜色变成纯 blue）。
 *
 * 这个 helper 把字符串按「标签内 / 标签外」切开，只对**标签外**的片段做变换，
 * 标签（`<…>`）整体原样保留。对正文里正常的 `#标签` 行为没有任何影响。
 *
 * 注意：只处理**单行**语义（`<` 到最近的 `>`）；迷你语法里我们生成的标签都是单行的。
 */
export function applyOutsideHtmlTags(
  text: string,
  transform: (chunk: string) => string,
): string {
  if (!text.includes("<")) return transform(text);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      out += transform(text.slice(i));
      break;
    }
    out += transform(text.slice(i, lt));
    const gt = text.indexOf(">", lt);
    if (gt < 0) {
      // 没有闭合的 `>`：不确定是不是标签，保守起见原样保留剩余内容
      out += text.slice(lt);
      break;
    }
    out += text.slice(lt, gt + 1); // 标签整体不参与变换
    i = gt + 1;
  }
  return out;
}
