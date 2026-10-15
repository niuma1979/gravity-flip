# 第二阶段独立验证报告（task-3）

验证者：verifier（独立于实现者）。报告目录：`gravity-flip/verify/`。

## 0. 已校验修订（sha256 前 16 位）

| 文件 | sha256(16) |
| --- | --- |
| dist/gravity-flip.html | DF0F850B143FBA70 |
| index.html | E193750E2520F012 |
| css/style.css | 401B5036218B9F9C |
| js/physics.js | 24DE96C5A9E4E8BB |
| js/levels.js | B5AD305EE527D187 |
| js/levels7-12.js | B4F67193F7D7617E |
| js/game.js | 1E214228C91E19D0 |
| build.mjs | D0A77EF16537744A |

## 1. 产物自包含验证：PASS（21 PASS / 0 FAIL，exit 0）

命令：`node tools/verify_ui.mjs --dist dist/gravity-flip.html`

- D1 无外部 src/href（0 个）· D2 无 http(s) · D3 占位符 0 残留
- D4 内联 CSS 无外部 url() · D5 共 1 个 script 块且全内联 · D6 真 `node --check` exit 0
- D7 标签计数平衡（raw `<script`=1，`</script`=1），无 `<!--`+`<script` 组合
- **D8 产物与当前源一致**：把产物内联块还原成占位符后与 `index.html` 逐字相同（骨架 sha256 双方均 ba3991283df0…），内联 CSS 与 `css/style.css` 逐字相同，产物 mtime 不早于任何源文件 → 排除「产物是旧源构建」。
- **2.3 产物里 12 个必需 id 各恰好 1 次**（计数对象为产物本文本自身，sha256 df0f850b143f…，70945B）；2.1/2.2 同样在产物文本上独立执行（证据行号 L315–L329，与模板 L12–L26 不同，证明未复用模板结论）。

## 2. 外壳验证：PASS（18 PASS / 0 FAIL / 2 WARN，exit 0）

命令：`node tools/verify_ui.mjs`。第 1–7 条全部 PASS。
- 7.3（README 按键 ↔ 脚本实际绑定）= **WARN**：README 的 12 个键全部在 `js/game.js` 键表（L146–149）中找到且动作语义一致；脚本另外绑定了 README 未写的 `Escape`、`Enter`、`KeyM`（静音）→ 文档小缺口，非功能缺陷。
- 7.4 = WARN：`#hint` 把左右合并为一段，机器无法判定合并语义；键集与 README 完全一致（人工确认正确）。

## 3. 物理常量与「必须翻转」：Lead 的 160px 数字错误

用真实 `createSim/stepSim` 实测（`node verify/independent_physics_check.mjs`）：

- 解析式 h = JUMP_V²/(2·GRAVITY) = 720²/4800 = **108.0 px = 2.70 格**（Lead 的 108 / 2.7 格正确）
- 离散实测（dt=1/60，半隐式欧拉）最大上升 = **102.0 px = 2.55 格**（比解析式少 6px）
- 地面站 py=626（=16×40−PH/2），天花板站 py=214（=(4+1)×40+PH/2）→ **质心行程 412 px**；两站立面净空 **440 px**；泳道格差 12×40 = **480 px**
- **Lead 说的「相距 160px」与源码不符**：实际是 412/440/480 px。结论方向不变（108 < 412，必须翻转），但 160 这个数字本身是错的。
- 翻转后实测可贴到对面（关 2–6 位移 412px，与 lead 的 regress 输出一致；关 1 在出生列无 r4 板，飞到 r0–2 板下 y=134，位移 492px）。

## 4. 关卡可解性：可解性 PASS；但闸门「最少翻转 ≥1」不成立

- 独立复跑 `node tools/solve_levels.mjs 1 12 --nodes 300000` → **12/12 PASS，exit 0，「未通过: 0 / 12」**；最大展开 28193 远低于 300000 上限（非预算截断）。各关 flips=3,1,1,1,1,1,4,4,10,6,4,6，par 恰好 = flips+1。
- **闸门漏洞（已实锤）**：`flipEarned = d.flipCount >= 1 && d.flipCount >= par.flips-3` 用的是**搜索找到的那个解**的翻转数，不是最小值；注释把它写成「证明翻转是通关必需」，这不成立。
- **反例**：把 Lead 自己的搜索脚本复制到 `verify/noflip_probe.mjs` 并移除全部翻转宏后运行，**关卡 8 在禁止翻转时仍能通关**（展开仅 186，远未触顶）：
  `关 8 贴顶走廊 WEAK flips=0(par 5) time=4.65s 死亡0 宏步9`
  宏序列 `JL6 JR6 JR6 J·6 R40 R6 JR40 R40 JR40`（无一个 F），终点星=3。
- 我用**自己写的**宏循环（`verify/independent_physics_check.mjs` H 节）独立复跑该计划：**won=true flips=0 星=3/3 deaths=0 time=4.65s**。
- 因此：① 「两泳道+3星结构下最少翻转就是 1」这个**论证不成立**（关 8 的最小值是 0）；② `par ≤ 实测最优+1` 里的「实测最优」也只是找到的解，关 8 真实最优 flip=0 而 par=5；③ 脚本的失败计数会超过关卡数（单关可同时触发 flipEarned 与 parTight 两个 failures，实测打印「未通过: 2 / 1」）。
- 建议：加一个 `--no-flip` 模式（本报告已提供等价探针）建立 0 翻转基线，仅在「0 翻转确实无解」的关卡上要求 flips ≥ 1。

## 5. 打包产物的运行时：PASS（此前从未被执行过）

`tools/smoke_test.mjs` 只加载 `js/*.js` 源文件，**从未执行过 dist 里的内联脚本**。我生成 `verify/dist_runtime_test.mjs`（同一套 DOM 桩 + 同一批断言，改为加载产物内联脚本）：**39 PASS / 0 FAIL**，12 关、跳跃 102px、翻转、暂停、重开、通关、存档全部与源一致 → 打包顺序/全局挂载/`</script` 转义未破坏运行时。

## 6. 真实浏览器：UNVERIFIED（环境不允许，非代码问题）

- `node tools/browser_test.mjs` → `FAIL 浏览器测试执行完成 [Chrome DevTools 端点未就绪]`，0 PASS / 1 FAIL，exit 1。
- 原始输出（`chrome.exe --version` 都起不来）：
  `crashpad_client_win.cc:430] OpenProcess: 拒绝访问。 (0x5)`
  `mojo\public\cpp\platform\platform_channel.cc:112] Check failed: . : 拒绝访问。 (0x5)`
  `crashpad_client_win.cc:144] crash server failed to launch, self-terminating`，`--version` 退出码 **-36863**。
- headless + CDP（端口 9344）同样立刻退出，CDP 连接失败；Edge `--version` 挂起不返回。根因是本沙箱禁止创建命名管道/mojo 通道，浏览器进程无法启动。
- **因此以下全部 UNVERIFIED**：真实渲染与像素、真实键盘/触屏输入、实际手感与帧率、音频、不同浏览器/设备表现。

## 7. 工具自身的修复（本轮）

- 新增 2.3「每个必需 id 恰好 1 次」并**在产物路径独立执行**（哈希证明计数对象是产物文本）。
- 新增 D8「产物 ↔ 当前源一致性」（骨架/CSS 逐字比对 + mtime 陈旧告警）。
- `readJsSources` 改为**从 build.mjs 的显式打包清单**读取真正被内联的文件（此前会误扫根目录的 `build.mjs`，产生假 FAIL）。
- `jsBindings` 支持**对象字面量键表**（`ArrowLeft: 'left'`），并新增键表语义比对（此前漏解析键表，产生假 FAIL）。
- 自检 7/7 通过（合格夹具 0 FAIL；注入缺陷的夹具必须报出指定 FAIL；D8 的 CSS 漂移/骨架漂移路径均已证明可捕获）。

## 8. 未验证项清单（UNVERIFIED）

1. 真实浏览器渲染/输入/手感/音频/性能（沙箱禁止启动 Chrome/Edge）。
2. 第 1 关之外的「零翻转是否也可通关」——我的 no-flip 探针只证明关 8 为 0；其余 11 关在探针里以 `budget`（预算耗尽）失败，属「未找到解」而非「已证明无解」。
3. 关卡 7–12 的关卡对象缺少 `spawnAnchor/exitAnchor/solidCells`（只有 map/saws/par），与 1–6 关结构不同；`compileLevel` 回退到字形格中心。游戏与 solver 共用同一 `compileLevel`，故一致性无忧，但两套作者风格是否有意为之未确认。
4. 人眼观感（配色/可读性）与目标真机（手机）触屏表现。
