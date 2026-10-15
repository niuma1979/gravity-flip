# verify_ui 报告 — shell

时间: 2026-10-15T00:19:50.771Z

| id | 检查项 | 结果 | 详情 |
| --- | --- | --- | --- |
| 1.1 | `<!--@STYLE@-->` 恰好 1 次 | **PASS** | 实际 1 次，行号 9 |
| 1.2 | `<!--@BUNDLE@-->` 恰好 1 次 | **PASS** | 实际 1 次，行号 38 |
| 1.3 | 模板内除占位符外无其他 <style>/<script> 标签 | **PASS** | <style>/<script> 计数均为 0 |
| 2.1 | 必需 id 全部存在（12 个） | **PASS** | 全部命中；共发现 13 个 id |
| 2.2 | 无重复 id | **PASS** | 无重复 |
| 2.3 | 每个必需 id 恰好 1 次（在模板文本中独立计数） | **PASS** | 12/12 个必需 id 计数均为 1；本文本共 13 个 id 标签 |
| 3.1 | 四个操作按钮存在且 type="button" | **PASS** | 共 4 个 <button>，四个 action 各 1 个且 type="button" |
| 3.2 | CSS 含 `touch-action:none` 且作用于按钮 | **PASS** | 命中 3 处；按钮相关规则: L85 "#game", L161 "#overlay-buttons button", L203 ".ctl" |
| 4.1 | <canvas id="game" width="1280" height="720"> | **PASS** | L21 <canvas id="game" width="1280" height="720"> → width="1280" height="720" |
| 4.2 | CSS 保证 16:9 且不裁切 | **PASS** | 找到 aspect-ratio:16/9（L85 "#game"），选择器指向 canvas/#game/#wrap |
| 4.3 | CSS 无 object-fit:cover / clip-path 裁切迹象 | **PASS** | 未发现 |
| 5.1 | #overlay 默认带 hidden | **PASS** | L22 <div id="overlay" hidden> |
| 5.2 | #overlay 的 hidden 实际生效（CSS 不覆盖） | **PASS** | 存在覆盖规则: L117 "#overlay[hidden]" |
| 1.4 | 模板与 CSS 无外部资源引用（src/href/@import/url） | **PASS** | 未发现外部引用（为最终自包含产物做好准备） |
| 7.1 | README 自身无自相矛盾（同键不映射到多个动作） | **PASS** | 解析到 6 条按键声明（0 条无动作语义、已跳过），无冲突 |
| 7.2 | README 提到四个动作（左/右/跳/翻） | **PASS** | 四个动作均有提及 |
| 7.3 | README 按键 vs 脚本实际绑定一致 | **WARN** | README 声明=[ArrowLeft,KeyA,ArrowRight,KeyD,Space,ArrowUp,KeyW,KeyZ,ArrowDown,KeyS,KeyP,KeyR] 脚本绑定=[KeyP,Escape,KeyR,Enter,ArrowLeft,KeyA,ArrowRight,KeyD,Space,ArrowUp,KeyW,KeyZ,ArrowDown,KeyS] \| WARN: 脚本绑定但 README 未写: Escape,Enter（属界面/便利键，建议补进 README） |
| 7.4 | 页面 #hint 与 README 操作说明一致 | **WARN** | 提示段 "←/→ 或 A/D 移动" 合并了多个动作 [left,right]，无法机器判定（人工确认） |
| 8.1 | JS 源码内联安全性（字面量 script 标签） | **PASS** | 扫描 4 个 JS 文件，无字面量 <script / </script> |
| 8.2 | 跨文件顶层声明冲突 / 拼接后可解析（单 <script> 前提） | **PASS** | 可发布拼接 [physics.js, levels.js, levels7-12.js, game.js] node --check → exit 0（可解析） |

小计: PASS=18 FAIL=0 WARN=2 SKIP=0
