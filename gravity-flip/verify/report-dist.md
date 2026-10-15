# verify_ui 报告 — dist

时间: 2026-10-15T03:11:36.047Z

| id | 检查项 | 结果 | 详情 |
| --- | --- | --- | --- |
| D1 | 无外部 src=/href= 请求（仅允许 # 锚点与 data: 内联） | **PASS** | 检查 0 个 src/href，全部为 # 或 data: |
| D2 | 无 http(s) 外部链接（w3.org 命名空间声明除外） | **PASS** | 未发现任何 http(s) |
| D3 | 占位符已被替换干净 | **PASS** | 4 种占位符 token 均为 0 次 |
| D4 | 内联 CSS 无外部 url() 资源 | **PASS** | 扫描 1 个样式源，无外部 url() |
| D5 | 无 <script src=>（脚本必须内联） | **PASS** | 共 1 个 <script> 块，全部内联 |
| D7 | 内联脚本无「字面量 script 标签」解析陷阱 | **PASS** | 标签计数平衡，且内联脚本中无 <!--+<script 组合 |
| D6 | 内联脚本语法可解析（node --check） | **PASS** | inline-1.js(L352) exit=0 |
| D8 | 产物与当前源一致（模板/CSS 未漂移） | **PASS** | 骨架与 index.html 逐字一致；内联 CSS 与 css/style.css 逐字一致；产物 mtime 不早于任何源文件 |
| 1.1 | 构建产物无 `<!--@STYLE@-->` 残留 | **PASS** | 实际 0 次 |
| 1.2 | 构建产物无 `<!--@BUNDLE@-->` 残留 | **PASS** | 实际 0 次 |
| 1.3 | 构建产物存在内联 <style> 与 <script> | **PASS** | 内联 style 块=1（行 20），script 块=1（行 352） |
| 2.1 | 必需 id 全部存在（12 个） | **PASS** | 全部命中；共发现 13 个 id |
| 2.2 | 无重复 id | **PASS** | 无重复 |
| 2.3 | 每个必需 id 恰好 1 次（在产物文本中独立计数） | **PASS** | 12/12 个必需 id 计数均为 1；本文本共 13 个 id 标签 |
| 3.1 | 四个操作按钮存在且 type="button" | **PASS** | 共 4 个 <button>，四个 action 各 1 个且 type="button" |
| 3.2 | CSS 含 `touch-action:none` 且作用于按钮 | **PASS** | 命中 3 处；按钮相关规则: L86 "#game", L162 "#overlay-buttons button", L204 ".ctl" |
| 4.1 | <canvas id="game" width="1280" height="720"> | **PASS** | L335 <canvas id="game" width="1280" height="720"> → width="1280" height="720" |
| 4.2 | CSS 保证 16:9 且不裁切 | **PASS** | 找到 aspect-ratio:16/9（L86 "#game"），选择器指向 canvas/#game/#wrap |
| 4.3 | CSS 无 object-fit:cover / clip-path 裁切迹象 | **PASS** | 未发现 |
| 5.1 | #overlay 默认带 hidden | **PASS** | L336 <div id="overlay" hidden> |
| 5.2 | #overlay 的 hidden 实际生效（CSS 不覆盖） | **PASS** | 存在覆盖规则: L118 "#overlay[hidden]" |

小计: PASS=21 FAIL=0 WARN=0 SKIP=0
