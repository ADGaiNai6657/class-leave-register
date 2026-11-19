# Agent 前端设计规范（基于 Apple HIG）

适用范围：网站、Web 应用及新增或修改的前端页面。若任务明确涉及 Apple 原生应用，同时查阅目标平台和版本的 HIG 条目。

本文中的「必须」「禁止」「可以」是对执行本规范的 Agent 的约束。Apple HIG 提供设计依据。本文将其中适用于 Web 的原则映射为网页规则，并采用 W3C WCAG 2.2 AA 作为 Web 无障碍验收基线。具体视觉参数、品牌方案和业务交互由项目或用户确定。

## 1. 强制执行流程

### 1.1 实现前核对

1. 读取用户当前任务、适用的 `AGENTS.md`、设计稿、组件库、设计变量和相关已上线页面。所有新增或变更的设计必须能追溯到适用的明确要求、已确认的项目规范、本文规定或适用的官方条目。
2. 核对目标平台、页面主任务、信息层级、导航、组件及交互状态。再核对与本次改动有关的主题、字体、色彩、布局、间距、断点、动效、输入方式和无障碍要求。只核对会影响本次改动的决策。
3. 只有当既有规范明确适用于当前场景，并且导向唯一设计选择时，才可以直接复用。涉及不止一种合理方案时，视为未指明。若只修改现有组件且其余设计无需变动，沿用其余已确定的设计即可。
4. 开始实现前清除全部未决设计项。执行中发现新的冲突或缺项，立即执行下节的停工流程。

### 1.2 冲突或未指明时，必须停下来问用户

下列任一情况成立，立即暂停本次前端设计与实现：

| 触发条件 | 示例 |
| --- | --- |
| 适用于同一场景的要求无法同时满足 | 设计稿规定字号，项目组件规范对同一控件明确规定另一字号。 |
| 影响可见界面或交互的选择没有明确依据 | 新页面需要决定移动端采用折叠侧栏还是底部导航，已有规范未覆盖。 |
| 指南提供多种策略或平台规则，当前场景无法唯一选定 | 同一控件面对触控和桌面密集布局，项目未定义两种布局的切换条件。 |
| 原本可复用的规则不能在当前限制下落实 | 已指定的品牌色在批准的背景上对比度不足，需要决定调整哪一项。 |

停止修改页面、样式、组件、设计变量及相关交互，也暂停按某个未确认方案制作原型或截图。可以继续做只读核对，以列出冲突来源或所缺信息。已经存在的工作保留在当前状态，等待决定。

把独立的待决事项一次问清。每项写明受影响的页面或组件、冲突条款或缺失信息、可行选项及其后果。用户确认前禁止自行选项、按个人审美补值或把临时默认值写进实现。用户只确认部分事项时，保留其决定，继续等待其余事项答复。若用户明确授权 Agent 决定某一项，按该项授权的范围记录并执行。用户未回复、回复含糊或答复又引入冲突时，保持暂停。

提问示例：

> 移动端的一级导航尚未指定。现有桌面侧栏有 6 个入口。你希望用可展开的侧栏保留全部入口，还是先确定哪些入口进入底部标签栏？前者保留原有信息架构，后者需要你确认入口优先级。确认后我再继续实现。

## 2. 页面结构与导航

- 页面必须有清晰的主要任务。通过标题、位置、分组与主操作的视觉权重表达优先级。删除无信息价值的装饰标签、重复标题和解释性文案。
- 将相关信息和控制放在一起。用对齐、间距和标题表明关系。优先使用项目现有容器、网格、间距变量与组件。
- 响应式布局必须保住内容阅读顺序、操作上下文和主要功能。视觉顺序、DOM 顺序与键盘焦点顺序应相符。横向溢出应限制在依赖二维布局的局部组件内，例如数据表格或图表。
- 一级导航只负责切换主要目的地，当前目的地必须可辨认。作用于当前页面的保存、新建、筛选等操作放在对应工具区。切换视图和返回时按已确认的规则保留上下文。
- 宽屏与窄屏的导航形式、折叠规则、断点和固定区域按项目定义。Web 页面如有贴近视口边缘的固定控件，必须检查安全区、软键盘和浏览器缩放时的遮挡。

依据：[Layout][layout]、[Tab bars][tabs]、[Sidebars][sidebars]、[Design principles][principles]。

## 3. 视觉语言

| 项目 | Agent 必须遵守 |
| --- | --- |
| 字体 | 沿用已批准的字体与排版层级，用字号、字重和间距区分标题、正文与辅助信息。小字号避免过细的字重。放大文字后保持可读性和层级，并允许合理换行。 |
| 颜色 | 用语义变量定义画布、表面、文本、边框、强调和状态。相同语义在全站一致。成功、警告、错误与选中等信息同时用文字、符号或结构传达。 |
| 主题 | 在项目启用的每种主题中验证文本、控件、状态与图表的可辨性。项目采用系统主题跟随时，Web 使用 `prefers-color-scheme` 等适用机制，并遵循项目规定的手动主题切换逻辑。主题支持范围缺失且影响任务时先询问。 |
| 材质 | 让内容层优先，导航和临时控制层靠层级区分。原生 Liquid Glass 只按目标系统的官方组件和规则使用。Web 半透明、模糊等效果须有已确认的用途，并验证复杂背景上的对比度和实色回退。 |
| 图标与图像 | 复用已批准的图标体系。同一动作使用一致符号。图标按钮提供无障碍名称，含义容易混淆时提供可见文字。内容图片保持正确宽高比，按用途提供替代文字。 |
| 设计变量 | 字号、行高、间距、圆角、阴影、颜色、断点与动效时长，统一由项目变量或已确认设计值提供。Apple 原生单位 `pt` 必须按原生指南使用，禁止直接当成 CSS `px`。 |

依据：[Typography][typography]、[Color][color]、[Dark Mode][dark]、[Materials][materials]、[UI Design Dos and Don’ts][tips]。

## 4. 组件、反馈与文案

| 场景 | Agent 必须遵守 |
| --- | --- |
| 按钮和链接 | Web 优先复用符合语义的原生元素或项目组件。按钮执行动作，链接前往目的地。动作标签应具体，在同一操作组内明确主次。提供与场景有关的焦点、按下、禁用和等待反馈。 |
| 表单 | 提供持久可见的标签，提示和示例作为辅助。错误指向相应字段，说明如何修正，保留可复用的已填内容。输入类型、校验时机、默认值和提交行为遵循已确定规则。 |
| 弹窗和警告 | 仅在重要决策或独立任务确需中断时使用模态。写明原因及必要后果，提供明确的取消或关闭方式。Web 模态打开后将焦点移至合适元素，焦点限制在模态内，支持 Escape 关闭，关闭后将焦点返回触发控件或合理的后续位置。 |
| 危险操作 | 对需要确认的危险操作，写明受影响对象与后果。采用明确的动作名称。撤销、确认或恢复策略按业务规则执行，缺失时先询问。 |
| 加载与状态 | 按场景核对加载、空状态、成功、错误和重试。能测量时显示实际进度，不能测量时使用不定进度反馈。重要状态变化要能被辅助技术感知。禁止伪造进度、权限、数量和数据。 |
| 动效 | 动效必须服务于状态反馈、关系理解或上下文过渡。Web 必须响应 `prefers-reduced-motion`，去除或简化非必要动效，并保留等效信息和功能。 |
| 文案 | 采用清楚、简洁、统一的术语。链接文本描述目的地，按钮文本说明动作，错误文案说明当前情况和可执行的下一步。业务事实与承诺缺失时先询问。 |

依据：[Buttons][buttons]、[Text fields][fields]、[Modality][modality]、[Alerts][alerts]、[Progress indicators][progress]、[Motion][motion]、[Writing][writing]、[W3C 模态对话框模式][dialog]。

## 5. Web 无障碍基线

- **结构与操作。** 使用可识别的页面标题、标题层级、地标和语义控件。主要流程可只用键盘完成。焦点必须可见，避免被悬浮工具栏、固定页头或弹层遮挡。拖动、悬停、手势、颜色或声音传达的关键信息和操作应有可用替代方式，适用的 WCAG 例外见原文。
- **对比度。** 普通文本至少 4.5:1，符合 WCAG 大文本定义的文字至少 3:1。辨认控件、状态或理解图形所必需的视觉信息与相邻颜色至少 3:1。按 WCAG 对应条款处理例外。必须检查各已启用主题和实际背景上的组合。
- **目标大小。** WCAG 2.2 AA 的指针目标最小要求为 24 × 24 CSS px，允许使用准则规定的例外。Apple 建议的 44 × 44 pt 用于其原生触控设计。若需采用更大的 Web 触控目标，按项目已确认的标准执行。
- **缩放与重排。** 检查文字放大至 200% 后内容与功能是否齐全。对适用垂直滚动的网页内容，在等效 320 CSS px 视口宽度下检查重排，遵循 WCAG 对依赖二维布局内容的例外。
- **状态与错误。** 为辅助技术提供准确的名称、角色、值与状态。动态反馈按适用情形通过语义或状态消息暴露，错误同时给出可定位的文字说明。避免为被动反馈随意移动焦点。

依据：[Apple Accessibility][accessibility]、[Apple UI Design Dos and Don’ts][tips]、[WCAG 2.2][wcag]（重点检查 1.3.1、1.4.1、1.4.3、1.4.4、1.4.10、1.4.11、2.1.1、2.4.7、2.4.11、2.5.7、2.5.8、3.3.1、4.1.2、4.1.3）。

## 6. 交付前核对

- [ ] 每项新增或修改的设计能追溯到规范或用户确认，冲突和缺项已清除。
- [ ] 在支持的视口、主题和输入方式下检查主要流程，确认无遮挡、裁切或意外横向溢出。
- [ ] 用键盘走完受影响流程，检查焦点顺序、对话框行为、语义标签与状态反馈，并核查对比度、缩放和减少动态效果。
- [ ] 按实际业务场景检查加载、空状态、表单错误、失败和恢复路径。
- [ ] 交付时报告实际检查的范围及无法验证的项。若未验证的项暴露出新的设计冲突或缺项，按第 1.2 节暂停并询问。

## 官方来源

- [Apple《人机界面指南》中文入口][hig-cn] · [英文目录][hig-en]
- 页面组织与排版：[Design principles][principles]、[Layout][layout]、[Typography][typography]、[Writing][writing]
- 视觉与动态：[Color][color]、[Dark Mode][dark]、[Materials][materials]、[Motion][motion]、[UI Design Dos and Don’ts][tips]
- 导航与组件：[Tab bars][tabs]、[Sidebars][sidebars]、[Buttons][buttons]、[Text fields][fields]、[Modality][modality]、[Alerts][alerts]、[Progress indicators][progress]
- 无障碍：[Apple Accessibility][accessibility]、[W3C WCAG 2.2][wcag]、[W3C 模态对话框模式][dialog]

[hig-cn]: https://developer.apple.com/cn/design/human-interface-guidelines/
[hig-en]: https://developer.apple.com/design/human-interface-guidelines/
[principles]: https://developer.apple.com/design/human-interface-guidelines/design-principles/
[layout]: https://developer.apple.com/design/human-interface-guidelines/layout
[typography]: https://developer.apple.com/design/human-interface-guidelines/typography
[color]: https://developer.apple.com/design/human-interface-guidelines/color
[dark]: https://developer.apple.com/design/human-interface-guidelines/dark-mode
[materials]: https://developer.apple.com/design/human-interface-guidelines/materials
[motion]: https://developer.apple.com/design/human-interface-guidelines/motion
[writing]: https://developer.apple.com/design/human-interface-guidelines/writing
[tabs]: https://developer.apple.com/design/human-interface-guidelines/tab-bars
[sidebars]: https://developer.apple.com/design/human-interface-guidelines/sidebars
[buttons]: https://developer.apple.com/design/human-interface-guidelines/buttons
[fields]: https://developer.apple.com/design/human-interface-guidelines/text-fields
[modality]: https://developer.apple.com/design/human-interface-guidelines/modality
[alerts]: https://developer.apple.com/design/human-interface-guidelines/alerts
[progress]: https://developer.apple.com/design/human-interface-guidelines/progress-indicators
[accessibility]: https://developer.apple.com/design/human-interface-guidelines/accessibility
[tips]: https://developer.apple.com/design/tips/
[wcag]: https://www.w3.org/TR/WCAG22/
[dialog]: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
