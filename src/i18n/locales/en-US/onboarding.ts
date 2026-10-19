/**
 * 新手引导
 */
const onboarding = {
  'AI Canvas 免费发行提醒': 'AI Canvas free distribution notice',
  '重要提醒': 'Important notice',
  'AI Canvas 完全免费': 'AI Canvas is completely free',
  '请勿为软件、入群资格或使用授权向第三方付款':
    'Do not pay third parties for the software, group access or a usage license',
  'AI Canvas 本体完全免费，项目方从未授权任何个人或账号收费售卖软件、入群资格或使用授权。':
    'AI Canvas itself is completely free. The project has never authorized any person or account to charge for the software, group access or a usage license.',
  '如果你已经付费': 'If you have already paid',
  '如果你是通过抖音账号“XiaoA灵洞”（抖音号：XiaoA250908）付费获得本画布，该收费并非本项目官方行为。请立即保存聊天记录、付款凭证等证据，并通过抖音平台投诉举报、申请退款。':
    'If you paid to obtain this canvas through the Douyin account “XiaoA灵洞” (Douyin ID: XiaoA250908), that charge was not made by this project. Save your chat history, payment receipt and other evidence, then report it and request a refund through Douyin.',
  '请勿继续向任何第三方支付软件费、入群费或授权费。':
    'Do not make any further software, group-access or license payments to a third party.',
  '说明：模型 API、云端算力等第三方服务可能自行收费，这些费用与画布软件售价无关。':
    'Note: third-party services such as model APIs and cloud compute may charge their own fees. Those charges are separate from the canvas software itself.',
  '我知道了，继续使用': 'I understand, continue',
  'AI Canvas 新手引导': 'AI Canvas onboarding',
  '欢迎使用 AI Canvas': 'Welcome to AI Canvas',
  '花两分钟看完，能少走很多弯路': 'Spend two minutes here to avoid a lot of detours',
  '关闭引导': 'Close onboarding',
  '像现在这样——把鼠标停在元素上不动，说明就会自己浮出来。':
    'Just like this — hover over an element and the description will appear on its own.',
  '先养成一个习惯：多悬停': 'Build one habit first: hover',
  '界面上几乎每个按钮、图标和开关都写了说明。把鼠标停在上面约 1 秒，说明就会浮出来。':
    'Almost every button, icon and toggle has a description. Hover over it for about a second and the hint will appear.',
  '遇到不认识的图标，先悬停看一眼再点，比点开试错快得多——这段文字本身也可以悬停试试。':
    'When you see an unfamiliar icon, hover to read it before clicking — it is much faster than trial and error. You can hover over this very text to try it.',
  '界面卡顿或显示不全？开启性能模式': 'Lagging or seeing an incomplete interface? Turn on Performance mode',
  '前往“设置 > 常规 > 图形与性能”开启。它会关闭毛玻璃、装饰动画和动态背景，同时保留加载与进度提示。':
    'Open Settings > General > Graphics & performance. It disables frosted glass, decorative animations and animated backgrounds while keeping loading and progress feedback.',
  '这些操作藏在界面里，不说很难发现': 'These actions are hidden in the UI and hard to find on your own',
  '下面每一条都可以悬停查看适用条件和限制。':
    'Hover over each item below to see its conditions and limitations.',
  '打开节点的提示词对话框': 'Open a node\'s prompt dialog',
  '单独选中一个内容节点后按空格，直接展开提示词、参数和参考内容的完整编辑面板。':
    'Select a single content node and press Space to expand the full editor for its prompt, parameters and references.',
  '只在单独选中一个普通内容节点时生效；正在输入文字、多选节点、分组节点或 Markdown 节点都不会触发。':
    'Only works when a single regular content node is selected. It won\'t trigger while typing, with multiple nodes selected, or on group and Markdown nodes.',
  '图像节点批量出图': 'Batch-generate images from an image node',
  '在图像节点对话框里填好提示词，长按发送/生成按钮，可以选择一次生成 2-8 张。':
    'Fill in the prompt in an image node dialog, then long-press the generate button to choose 2–8 images at once.',
  '需要使用支持批量的普通模型且未选择 ComfyUI 工作流；费用可能按实际生成张数计算。':
    'Requires a regular model that supports batching and no ComfyUI workflow selected. Cost may be based on the actual number of images generated.',
  '自定义节点工具栏': 'Customize the node toolbar',
  '单独选中节点后长按上方浮动工具栏，进入编辑状态，可增删按钮或拖拽排序。':
    'Select a node and long-press the floating toolbar above it to enter edit mode, where you can add, remove or drag to reorder buttons.',
  '编辑完成后布局会被保存，之后同类节点都用这套工具栏。':
    'The layout is saved after editing, and all nodes of the same type will use this toolbar.',
  '拖一下就留副本': 'Drag to leave a copy behind',
  '按住 Ctrl/⌘ 拖动非分组节点，原位置会留下一个副本，省去复制粘贴再对位。':
    'Hold Ctrl/⌘ and drag a non-group node to leave a copy at its original position — no copy-paste and re-aligning.',
  '分组节点不支持这个手势；误操作可用 Ctrl/⌘ + Z 撤销。':
    'Group nodes don\'t support this gesture; undo any mistake with Ctrl/⌘ + Z.',
  '锁定节点宽高比例': 'Lock a node\'s aspect ratio',
  '拖动节点右下角尺寸控制点时按住 Shift，宽高按当前比例一起变化。':
    'Hold Shift while dragging the resize handle at the bottom-right corner to scale width and height together.',
  '拖拽过程中可以随时按下或松开 Shift 来切换是否锁定比例。':
    'You can press or release Shift at any time while dragging to toggle aspect-ratio lock.',
  '边连线边建节点': 'Create nodes while connecting',
  '从输出连接点拖出连线，松手在画布空白处，会直接弹出菜单创建已连好的下游节点。':
    'Drag a connection out from an output handle and release on empty canvas to open a menu that creates the downstream node already wired up.',
  '菜单里选择的节点类型会自动放在松手的位置，并保留这条连线。':
    'The node type you pick is placed exactly where you released, keeping the connection.',
  '在鼠标位置直接建节点': 'Create a node right at the mouse position',
  '按 1-7 创建文本、图像、视频、音频、全景、动画和 3D 导演台节点；Alt + 1-5 创建对应的源节点。':
    'Press 1–7 to create text, image, video, audio, panorama, animation and 3D director desk nodes; Alt + 1–5 creates the corresponding source nodes.',
  '节点会出现在当前鼠标所在的画布位置，不需要先点加号菜单。':
    'Nodes appear at the current mouse position on the canvas — no need to open the plus menu first.',
  '快捷指令与 Skill 菜单': 'Quick commands and Skill menu',
  '在生成节点的提示词输入框里键入 /，可调用内置指令、自定义快捷指令和已上传的 Skill。':
    'Type / in a generation node\'s prompt box to invoke built-in commands, custom quick commands and uploaded Skills.',
  '也可以点输入框下方的 / 按钮；在“管理快捷指令”里能定义自己的模板、参数和多步骤流程。':
    'You can also click the / button below the input; define your own templates, parameters and multi-step flows in "Manage quick commands".',
  '跨范围搜索素材': 'Search assets across scopes',
  '打开资源搜索窗口，聚合查询项目文件、全局资产和已添加的外部文件夹，结果可直接拖进画布。':
    'Open the asset search window to query project files, global assets and added external folders together; results can be dragged straight onto the canvas.',
  'Ctrl + Shift + Space 是同一个入口的备用组合键。':
    'Ctrl + Shift + Space is an alternative shortcut for the same entry.',
  '找回跑远的画布内容': 'Find canvas content that has drifted away',
  '按 F 把全部内容适配到当前视野，按 M 显示或隐藏小地图。':
    'Press F to fit all content to the current view, and M to show or hide the minimap.',
  '画布右下角还有缩放控件，可以精确调整显示比例。':
    'There are zoom controls at the bottom-right of the canvas for fine-tuning the display scale.',
  '开始生成前，记得先在“设置 > API Key”配置好模型服务，否则节点里的模型会是不可用状态。':
    'Before generating, remember to configure your model providers in Settings > API Key, otherwise the models in nodes will be unavailable.',
  '先自己逛逛': 'Explore on my own',
  '按场景整理的完整说明：画布导航、节点连线、AI 生成、快捷指令、资产与设置':
    'Complete guide organized by scenario: canvas navigation, node connections, AI generation, quick commands, assets and settings.',
  '打开帮助中心细读一遍': 'Open the Help Center and read it through',
};

export default onboarding;
